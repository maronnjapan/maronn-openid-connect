/**
 * The client credentials grant (RFC 6749 §4.4 / OAuth 2.1 §4.2).
 *
 * The token endpoint calls dispatchClientCredentials() in its
 * (feature: client-credentials) block, right after client authentication.
 * No End-User is involved: the authenticated client gets an access token for
 * itself. The grant is limited to what the client registered (grantTypes,
 * scope), and to the audiences of config.clientCredentialsAllowedAudiences.
 */
import {
  CLIENT_CREDENTIALS_GRANT_TYPE,
  TokenError,
  TokenErrorCode,
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  buildClientCredentialsTokenResponse,
  buildValidatedClientCredentialsRequest,
  resolveClientCredentialsAudience,
  resolveClientCredentialsScope,
  validateClientCredentialsConfidentialClient,
  validateClientCredentialsGrantAllowed,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import {
  accessTokenIssuer,
  config,
  stores,
  type ProviderSigningKeys,
} from '../../provider';
import { noStoreJson } from '../../http';
import { findUnsupportedScopes } from '../../scopes';

/**
 * グラントタイプが `client_credentials` ならアクセストークンで応答する。
 *
 * トークンエンドポイントのルートハンドラが、クライアントの認証の直後に呼ぶ。
 * `grant_type` が `client_credentials` でなければ、何もせず `undefined` を返す。
 * `client_credentials` のリクエストにはこの関数が最後まで応答し、認可コードやリフレッシュトークンのグラントの処理には進まない。
 *
 * このグラントにはエンドユーザーが関わらず、認証したクライアントが自分自身の権限でアクセストークンを得る。
 * そのため、次の規則でトークンを発行する。
 * - グラントを使えるのは、`grant_types` に `client_credentials` を登録したコンフィデンシャルクライアントだけである（RFC 6749 §4.4）。
 * - スコープは、クライアントが登録したスコープの範囲に限る。`scope` を省くと、登録したスコープのすべてになる（RFC 6749 §3.3）。
 * - `openid` と `offline_access` は発行しない。ID トークンとリフレッシュトークンも返さない（RFC 6749 §4.4.3）。
 * - `sub` は `client_id` にする（RFC 9068 §2.2）。
 * - `audience` で要求できるのは、設定の `clientCredentialsAllowedAudiences` にあるリソースだけである（RFC 8707 §2）。
 *
 * 検証に失敗すると、中で呼ぶ core の関数が `TokenError` を投げ、ルートハンドラが OAuth のエラーレスポンスにする。
 * 検証はそれぞれ core の独立した関数なので、一つずつ取り除いたり、差し替えたり、独自の方針（クライアントごとのオーディエンスの制限など）を間に挟んだりできる。
 *
 * @spec RFC 6749 §4.4
 * @spec OAuth 2.1 §4.2
 * @spec RFC 9068 §2.2
 * @spec RFC 8707 §2
 * @throws {TokenError} `unauthorized_client`: クライアントが `client_credentials` を登録していないとき、またはパブリッククライアントのとき
 * @throws {TokenError} `invalid_scope`: 発行できないスコープ、クライアントに登録されていないスコープ、OP が受け付けないスコープを要求したとき
 * @throws {TokenError} `invalid_target`: 許可されていないオーディエンスを要求したとき
 */
export async function dispatchClientCredentials(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response | undefined> {
  if (params.grant_type !== CLIENT_CREDENTIALS_GRANT_TYPE) return undefined;

  // クライアントが `grant_types` に `client_credentials` を登録していることを確かめる（RFC 6749 §5.2）。
  // 登録していないクライアントの既定値は `["authorization_code"]` である（RFC 7591 §2）。
  validateClientCredentialsGrantAllowed(client);

  // コンフィデンシャルクライアントであることを確かめる（RFC 6749 §4.4）。
  // パブリッククライアントは `client_id` を名乗るだけで認証していないので、このグラントを使えない。
  validateClientCredentialsConfidentialClient(client);

  // 発行するスコープを決める。
  // 要求できるのはクライアントが登録したスコープ（`client.scope`）だけで、`openid` と `offline_access` は登録していても発行しない。
  // `scope` を省いたリクエストには、登録したスコープのすべてを発行する（RFC 6749 §3.3）。
  // スコープを登録していないクライアントには、スコープのないトークンだけを発行する。
  const scope = resolveClientCredentialsScope(params.scope, client);

  // 独自のスコープを宣言している（`scopes.ts`）と、宣言していない値を `invalid_scope` で拒否する（RFC 6749 §3.3）。
  // 認可エンドポイントと同じ規則である。
  const unsupportedScopes = findUnsupportedScopes(scope);
  if (unsupportedScopes.length > 0) {
    throw new TokenError(
      TokenErrorCode.InvalidScope,
      'Unsupported scope: ' + unsupportedScopes.join(' '),
    );
  }

  // `audience` で要求されたリソースが、設定の `clientCredentialsAllowedAudiences` にあることを確かめる（RFC 8707 §2）。
  // 一覧の既定は空なので、リソースを設定するまでは `audience` を指定したリクエストをすべて拒否する。
  // クライアントごとに発行先を絞るときは、この呼び出しの後に独自の確認を足す。
  const requestedAudience = resolveClientCredentialsAudience(
    params.audience,
    config.clientCredentialsAllowedAudiences,
  );

  // 検証済みのリクエストを組み立てる。
  // サブジェクトは、認証したクライアントの `client_id` になる（RFC 9068 §2.2）。
  const validatedRequest = buildValidatedClientCredentialsRequest(
    client.clientId,
    scope,
    requestedAudience,
  );

  // アクセストークンの `aud` を決める。
  // このトークンは `openid` を持たず UserInfo エンドポイントでは使えないので、ほかのグラントと違い、UserInfo エンドポイントを `aud` に入れない。
  // `audience` が要求されなければ、既定のリソースとして issuer を入れる（RFC 9068 §3）。
  const audience = buildAccessTokenAudience({
    requested: validatedRequest.audience,
    issuer: config.issuer,
  });

  // 発行時刻をレスポンス全体で一つにし、発行したトークンと保存するレコードで `iat` と `exp` を一致させる。
  const issuedAt = Math.floor(Date.now() / 1000);

  // ペイロードに `iss`、`sub`、`aud`、`exp`、`iat`、`jti`、`client_id` を入れ、スコープがあれば `scope` も入れる（RFC 9068 §2.2）。
  // エンドユーザーの認証がないので、`acr` は入れない。
  const accessTokenPayload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject: validatedRequest.subject,
    clientId: validatedRequest.clientId,
    scope: validatedRequest.scope,
    audience,
    expiresIn: config.accessTokenExpiresIn,
    issuedAt,
  });
  // `provider.ts` が設定の `accessTokenFormat` から選んだ方式で、JWT か不透明な文字列のトークンを発行する。
  // 新しいトークンには、登録された鍵のうち最初の鍵で署名する。
  const accessToken = await accessTokenIssuer.issue({
    payload: accessTokenPayload,
    privateKey: keys.general[0].privateKey,
    keyId: keys.general[0].keyId,
  });

  // アクセストークンのレコードを保存し、イントロスペクションと失効のエンドポイントが読めるようにする。
  // このグラントには認可コードも同意もないので、グラント ID は付けない。
  await stores.accessTokenStore.set(accessToken, {
    sub: validatedRequest.subject,
    clientId: validatedRequest.clientId,
    scope: validatedRequest.scope,
    expiresAt: issuedAt + config.accessTokenExpiresIn,
    iat: issuedAt,
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    jti: accessTokenPayload.jti,
  });

  // 200 でトークンレスポンスを返す。
  // `access_token`、`token_type`、`expires_in` と、発行したスコープがあれば `scope` を入れ、リフレッシュトークンと ID トークンは入れない（RFC 6749 §4.4.3）。
  return noStoreJson(
    buildClientCredentialsTokenResponse({
      accessToken,
      expiresIn: config.accessTokenExpiresIn,
      scope: validatedRequest.scope,
    }),
  );
}
