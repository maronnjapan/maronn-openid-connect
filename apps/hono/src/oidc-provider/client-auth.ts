/**
 * The check of the credential a client presents at an endpoint that
 * authenticates clients (OAuth 2.1 §2.3 / OIDC Core 1.0 §9): the token
 * endpoint, and the introspection, revocation, PAR, device authorization and
 * CIBA endpoints of their features. Their authenticate-client steps read the
 * credential with extractClientCredentials() of core, find the client and
 * check the method it registered, then call verifyPresentedClientCredential()
 * with the path of their endpoint.
 *
 * A client_secret (client_secret_basic, client_secret_post) is compared with
 * the stored hash. A private_key_jwt client assertion is verified with the
 * keys the client registered for private_key_jwt (its jwks, or its jwks_uri,
 * fetched again for an unknown kid: client-jwks-uri.ts), and its jti is kept
 * in the clientAssertionJtiStore (store.ts) until the assertion expires, so a
 * replay is rejected. The algs the OP accepts are
 * config.tokenEndpointAuthSigningAlgValuesSupported (config.ts).
 */
import {
  consumeClientAssertionJti,
  decodeClientAssertion,
  loadClientAssertionKeys,
  validateClientAssertionAlg,
  validateClientAssertionClaims,
  verifyClientAssertionSignature,
  verifyClientSecret,
  type PresentedClientCredentials,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import { getClientKeyResolver } from './client-jwks-uri.js';
import type { ProviderConfig } from './config.js';
import type { ClientAssertionJtiStorage } from './store.js';

/**
 * クライアントが提示した認証情報を、使われた認証方式に応じて確かめる。
 *
 * 使われた方式が `private_key_jwt` ならクライアントアサーションを（{@link verifyPrivateKeyJwtAssertion}）、それ以外ならシークレットを core の `verifyClientSecret()` で確かめる。
 * パブリッククライアント（`none`）には確かめるものがないので、`verifyClientSecret()` が何もせずに返る。
 * 使われた方式が登録された方式であることは、呼ぶ前に core の `validateClientAuthMethod()` で確かめておく。
 *
 * `endpointPath` は呼ばれたエンドポイントのパス（`/token` など）で、アサーションの `aud` の照合に使う。
 *
 * @spec OAuth 2.1 §2.3
 * @spec OIDC Core 1.0 §9
 * @throws {TokenError} `invalid_client`: シークレットが一致しないとき、またはアサーションを検証できないか使用済みのとき
 */
export async function verifyPresentedClientCredential(
  c: any,
  client: TokenClientInfo,
  presented: PresentedClientCredentials,
  endpointPath: string,
): Promise<void> {
  if (presented.method === 'private_key_jwt') {
    await verifyPrivateKeyJwtAssertion(c, client, presented.clientAssertion ?? '', endpointPath);
    return;
  }
  // `client_secret` を定数時間で比較する（OAuth 2.1 §7.4.1）。
  await verifyClientSecret(client, presented.clientSecret);
}

/**
 * `private_key_jwt` のクライアントアサーションを検証し、`jti` を消費する。
 *
 * core の関数を次の順に呼ぶ。
 * - `decodeClientAssertion()`: JWS のコンパクト形式を分解し、JOSE ヘッダーを検査する
 * - `validateClientAssertionAlg()`: `alg` が `config.tokenEndpointAuthSigningAlgValuesSupported` にあり、クライアントが登録した `tokenEndpointAuthSigningAlg` と一致することを確かめる（`none` と HS 系は拒否する）
 * - `validateClientAssertionClaims()`: `iss` と `sub` がクライアントの `client_id` で、`aud` に呼ばれたエンドポイントの URL（issuer にパスを付けたもの）か issuer があり、`exp` が切れておらず、`jti` があることを確かめる
 * - `loadClientAssertionKeys()` と `verifyClientAssertionSignature()`: クライアントが `private_key_jwt` の用途に登録した鍵で署名を検証する。`jwks_uri` のクライアントでは、見慣れない `kid` で `jwks_uri` を取り直す（OIDC Core 1.0 §10.1.1）
 * - `consumeClientAssertionJti()`: `jti` を消費し、使用済みなら拒否する（RFC 7523 §3）
 *
 * 鍵は `alg` とクレームを確かめた後でだけ読むので、受け付けないアサーションのために `jwks_uri` を取得することはない。
 * `jti` は署名を検証した後でだけ消費する。
 *
 * @spec OIDC Core 1.0 §9
 * @spec RFC 7523 §3
 * @spec OIDC Core 1.0 §10.1.1
 * @throws {TokenError} `invalid_client`: アサーションの形式、`alg`、クレーム、鍵、署名のどれかが正しくないとき、`jwks_uri` から鍵を取得できないとき、または使用済みのとき
 */
export async function verifyPrivateKeyJwtAssertion(
  c: any,
  client: TokenClientInfo,
  clientAssertion: string,
  endpointPath: string,
): Promise<void> {
  const config: ProviderConfig = c.get('config');
  const jtiStore: ClientAssertionJtiStorage = c.get('clientAssertionJtiStore');

  // JWS のコンパクト形式を分解し、`alg` を確かめる。
  const decoded = decodeClientAssertion(clientAssertion);
  validateClientAssertionAlg(decoded.alg, {
    supportedAlgs: config.tokenEndpointAuthSigningAlgValuesSupported,
    ...(client.tokenEndpointAuthSigningAlg === undefined ? {} : { registeredAlg: client.tokenEndpointAuthSigningAlg }),
  });

  // `aud` には、呼ばれたエンドポイントの URL と issuer のどちらかがあればよい（OIDC Core 1.0 §9、RFC 7523 §3）。
  // OP の URL は、リクエストの URL ではなく issuer から作る（リバースプロキシの後ろでも、ディスカバリーが公開する URL と同じにする）。
  const { jti, replayWindowEndsAt } = validateClientAssertionClaims(decoded.claims, {
    clientId: client.clientId,
    audiences: [`${config.issuer}${endpointPath}`, config.issuer],
    now: Math.floor(Date.now() / 1000),
  });

  // クライアントが `private_key_jwt` の用途に登録した鍵（`jwks_uri` を含む）で署名を検証する。
  const jwks = await loadClientAssertionKeys(getClientKeyResolver(c), client.clientId, decoded.kid);
  await verifyClientAssertionSignature(decoded, jwks);

  // 同じアサーションの再利用を拒否する（RFC 7523 §3）。
  await consumeClientAssertionJti(jtiStore, { clientId: client.clientId, jti, replayWindowEndsAt });
}
