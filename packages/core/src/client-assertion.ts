/**
 * private_key_jwt クライアント認証
 * OIDC Core 1.0 Section 9 / RFC 7523 Section 3 / RFC 7521 Section 4.2
 *
 * クライアントは、自分の秘密鍵で署名した JWT（クライアントアサーション）を `client_assertion` に、
 * その種類 `urn:ietf:params:oauth:client-assertion-type:jwt-bearer` を `client_assertion_type` に入れて送る。
 * OP は、クライアントが登録した公開鍵（`jwks` か `jwks_uri`）で署名を検証し、クレームを確かめ、
 * `jti` を有効期限まで覚えて同じアサーションの再利用を拒否する。
 *
 * 検証は責務ごとの関数に分けてあり、次の順に呼ぶ。
 * 1. {@link decodeClientAssertion}: JWS のコンパクト形式を分解し、JOSE ヘッダーを検査する
 * 2. {@link validateClientAssertionAlg}: 署名のアルゴリズムが OP の受け付けるもの（とクライアントが登録したもの）か確かめる
 * 3. {@link validateClientAssertionClaims}: `iss`、`sub`、`aud`、`exp`、`iat`、`nbf`、`jti` を確かめる
 * 4. {@link loadClientAssertionKeys} と {@link verifyClientAssertionSignature}: クライアントの公開鍵で署名を検証する
 * 5. {@link consumeClientAssertionJti}: `jti` を消費し、再利用を拒否する
 *
 * 失敗はどれも `invalid_client` の `TokenError` になる（RFC 7521 §4.2.1）。
 */

import { isClientJwksUriError } from './client-jwks-uri.js';
import type { ClientKeyResolver } from './client-keys.js';
import {
  base64UrlToArrayBuffer,
  importJwkForJwsVerification,
  resolveJwkSigningAlg,
  verify,
} from './crypto-utils.js';
import type { Jwk, JwkSet } from './jwks.js';
import { TokenError, TokenErrorCode } from './token-error.js';

/**
 * JWT をクライアントアサーションとして使うときの `client_assertion_type` の値（RFC 7523 §2.2）。
 */
export const CLIENT_ASSERTION_TYPE_JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * core がクライアントアサーションの署名を検証できる JWS のアルゴリズム（RFC 7518 §3.3 / §3.4）。
 * `none` と対称鍵の HS 系は含めない（private_key_jwt は非対称鍵の署名である。OIDC Core 1.0 §9）。
 */
export const SUPPORTED_CLIENT_ASSERTION_SIGNING_ALGS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'] as const;

/** クライアントアサーションの時刻（`exp`、`iat`、`nbf`）に許す時計のずれ（秒）の既定値。 */
export const DEFAULT_CLIENT_ASSERTION_LEEWAY_SECONDS = 60;

/** {@link decodeClientAssertion} が分解したクライアントアサーション。署名はまだ検証していない。 */
export interface DecodedClientAssertion {
  /** JOSE ヘッダー */
  header: Record<string, unknown>;
  /** ペイロードのクレーム（未検証） */
  claims: Record<string, unknown>;
  /** ヘッダーの `alg` */
  alg: string;
  /** ヘッダーの `kid`（あれば） */
  kid?: string;
  /** 署名の対象（`<header>.<payload>`） */
  signingInput: string;
  /** 署名（base64url） */
  signature: string;
}

/** {@link validateClientAssertionClaims} の検査の条件。 */
export interface ClientAssertionClaimsPolicy {
  /** 認証するクライアントの `client_id`。`iss` と `sub` はこの値でなければならない */
  clientId: string;
  /**
   * `aud` に含まれていればよい値。呼ばれたエンドポイントの URL と OP の issuer を渡す
   * （OIDC Core 1.0 §9 は Token Endpoint の URL を、RFC 7523 §3 は issuer も認める）。
   */
  audiences: readonly string[];
  /** 現在時刻（Unix epoch 秒） */
  now: number;
  /** 時計のずれとして許す秒数。既定は {@link DEFAULT_CLIENT_ASSERTION_LEEWAY_SECONDS} */
  leewaySeconds?: number;
}

/** {@link validateClientAssertionClaims} が確かめたクレームのうち、`jti` の消費に使う値。 */
export interface ValidatedClientAssertionClaims {
  /** アサーションの `jti` */
  jti: string;
  /** `jti` を覚えておく期限（Unix epoch 秒）。`exp` に時計のずれを足した時刻で、これより後はアサーションが期限切れとして拒否される */
  replayWindowEndsAt: number;
}

/**
 * 使用済みの `jti` を覚えるストア。
 *
 * OP は、受け付けたクライアントアサーションの `jti` を、そのアサーションが期限切れになるまで覚え、同じ `jti` の再提示を拒否する（RFC 7523 §3 の MAY、OIDC Core 1.0 §9）。
 */
export interface ClientAssertionJtiStore {
  /**
   * `key` を `expiresAt`（Unix epoch 秒）まで覚え、初めての `key` なら `true`、覚えている `key` なら `false` を返す。
   *
   * 同じ `key` を同時に渡した二つの呼び出しのうち、`true` を返すのは一方だけにする（できればアトミックに）。
   * 期限を過ぎた `key` は忘れてよい。
   */
  consume(key: string, expiresAt: number): boolean | Promise<boolean>;
}

/**
 * クライアントアサーションの検査の失敗を表す `invalid_client` の `TokenError` を返す。
 *
 * どの検査の失敗も、クライアント認証の失敗としてクライアントに `invalid_client` で伝える（RFC 7521 §4.2.1）。
 *
 * @spec RFC 7521 §4.2.1
 */
function invalidClientAssertion(description: string): TokenError {
  return new TokenError(TokenErrorCode.InvalidClient, description);
}

/**
 * JWT のセグメントを base64url として復号し、JSON のオブジェクトとして返す。
 *
 * 復号できないとき、JSON として読めないとき、JSON のオブジェクト（配列と `null` を除く）でないときは `undefined` を返す。
 */
function decodeJsonObjectSegment(segment: string): Record<string, unknown> | undefined {
  try {
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToArrayBuffer(segment)));
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      return undefined;
    }
    return decoded as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * クライアントアサーションを JWS のコンパクト形式として分解し、ヘッダー、クレーム、署名の対象と署名を返す。
 *
 * `.` で区切った三つのセグメントからなり、ヘッダーとペイロードが JSON のオブジェクトで、ヘッダーに文字列の `alg` があるものだけを受け付ける。
 * 五つのセグメントからなる JWE や、署名のセグメントが空のもの（`alg: none` の JWT）は拒否する。
 * ヘッダーの `crit`（RFC 7515 §4.1.11）は、この OP が理解する拡張が無いので、あれば拒否する。
 * `kid` は文字列のときだけ返す。
 * 署名は検証しないので、返したクレームは {@link verifyClientAssertionSignature} が通るまで信用しない。
 *
 * @spec RFC 7523 §3
 * @spec RFC 7515 §7.1
 * @spec RFC 7515 §4.1.11
 * @throws {TokenError} `invalid_client`: 形式が正しくないとき
 */
export function decodeClientAssertion(assertion: string): DecodedClientAssertion {
  if (typeof assertion !== 'string' || assertion.length === 0) {
    throw invalidClientAssertion('client_assertion is empty');
  }
  const parts = assertion.split('.');
  if (parts.length !== 3) {
    throw invalidClientAssertion('client_assertion is not a JWS compact serialization');
  }
  const [headerB64, payloadB64, signature] = parts as [string, string, string];
  const header = decodeJsonObjectSegment(headerB64);
  if (header === undefined) {
    throw invalidClientAssertion('client_assertion header is not valid base64url JSON');
  }
  const claims = decodeJsonObjectSegment(payloadB64);
  if (claims === undefined) {
    throw invalidClientAssertion('client_assertion payload is not valid base64url JSON');
  }
  const alg = header['alg'];
  if (typeof alg !== 'string' || alg.length === 0) {
    throw invalidClientAssertion('client_assertion header is missing alg');
  }
  if (header['crit'] !== undefined) {
    throw invalidClientAssertion('client_assertion header carries unsupported crit parameters');
  }
  if (signature === '') {
    throw invalidClientAssertion('client_assertion is not signed');
  }
  const kid = typeof header['kid'] === 'string' ? (header['kid'] as string) : undefined;
  return {
    header,
    claims,
    alg,
    ...(kid === undefined ? {} : { kid }),
    signingInput: `${headerB64}.${payloadB64}`,
    signature,
  };
}

/**
 * クライアントアサーションのヘッダーの `alg` が受け付けるアルゴリズムであることを確かめる。
 *
 * `none` と HS 系（対称鍵の署名）は、どの設定でも拒否する。
 * private_key_jwt はクライアントの秘密鍵による署名であり（OIDC Core 1.0 §9）、署名の無い JWT は認証にならないためである。
 * `registeredAlg`（クライアントが登録した `token_endpoint_auth_signing_alg`）があれば、その alg だけを受け付ける（OIDC Dynamic Client Registration 1.0 §2 の MUST）。
 * そのうえで、`supportedAlgs`（OP が `token_endpoint_auth_signing_alg_values_supported` で公開する alg）にない alg を拒否する（RFC 8725 §3.1）。
 *
 * @spec OIDC Core 1.0 §9
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @spec RFC 8725 §3.1
 * @throws {TokenError} `invalid_client`: `alg` を受け付けないとき
 */
export function validateClientAssertionAlg(
  alg: string,
  options: { supportedAlgs: readonly string[]; registeredAlg?: string },
): void {
  if (alg === 'none' || alg.startsWith('HS')) {
    throw invalidClientAssertion(`client_assertion alg ${alg} is not accepted for private_key_jwt`);
  }
  if (options.registeredAlg !== undefined && alg !== options.registeredAlg) {
    throw invalidClientAssertion('client_assertion alg does not match the registered token_endpoint_auth_signing_alg');
  }
  if (!options.supportedAlgs.includes(alg)) {
    throw invalidClientAssertion(`unsupported client_assertion signing alg: ${alg}`);
  }
}

/**
 * クライアントアサーションの `iss` と `sub` が、どちらもクライアントの `client_id` であることを確かめる。
 *
 * @spec OIDC Core 1.0 §9
 * @spec RFC 7523 §3
 * @throws {TokenError} `invalid_client`: `iss` か `sub` が `clientId` でないとき
 */
export function validateClientAssertionSubject(claims: Record<string, unknown>, clientId: string): void {
  if (claims['iss'] !== clientId) {
    throw invalidClientAssertion('client_assertion iss must be the client_id');
  }
  if (claims['sub'] !== clientId) {
    throw invalidClientAssertion('client_assertion sub must be the client_id');
  }
}

/**
 * クライアントアサーションの `aud` が、`audiences` の値を一つ以上含むことを確かめる。
 *
 * `aud` は文字列か文字列の配列で、どちらでもない値や空の配列は拒否する（RFC 7519 §4.1.3）。
 * `audiences` には呼ばれたエンドポイントの URL と OP の issuer を渡す。
 * OIDC Core 1.0 §9 は Token Endpoint の URL を `aud` に求め、RFC 7523 §3 は認可サーバーを示す値として issuer も認める。
 *
 * @spec OIDC Core 1.0 §9
 * @spec RFC 7523 §3
 * @spec RFC 7519 §4.1.3
 * @throws {TokenError} `invalid_client`: `aud` が `audiences` のどれも含まないとき
 */
export function validateClientAssertionAudience(claims: Record<string, unknown>, audiences: readonly string[]): void {
  const aud = claims['aud'];
  const values = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : undefined;
  if (values === undefined || values.length === 0 || values.some((value) => typeof value !== 'string')) {
    throw invalidClientAssertion('client_assertion aud must be a string or an array of strings');
  }
  if (!values.some((value) => audiences.includes(value as string))) {
    throw invalidClientAssertion('client_assertion aud does not identify this authorization server');
  }
}

/**
 * クライアントアサーションの `exp`、`iat`、`nbf` を確かめ、`exp` を返す。
 *
 * `exp` は必須で、数値で、`now - leewaySeconds` より後でなければならない（期限切れの拒否。RFC 7523 §3）。
 * `iat` と `nbf` は任意で、あれば数値で、`now + leewaySeconds` を超えてはならない（未来に発行されたものと、まだ使えないものの拒否）。
 *
 * @spec RFC 7523 §3
 * @spec RFC 7519 §4.1.4 / §4.1.5 / §4.1.6
 * @throws {TokenError} `invalid_client`: `exp` がないか期限切れのとき、`iat` か `nbf` が数値でないか未来のとき
 */
export function validateClientAssertionTimes(
  claims: Record<string, unknown>,
  now: number,
  leewaySeconds: number,
): number {
  const exp = claims['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw invalidClientAssertion('client_assertion exp is required');
  }
  if (exp <= now - leewaySeconds) {
    throw invalidClientAssertion('client_assertion has expired');
  }
  for (const name of ['iat', 'nbf'] as const) {
    const value = claims[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalidClientAssertion(`client_assertion ${name} must be a number`);
    }
    if (value > now + leewaySeconds) {
      throw invalidClientAssertion(`client_assertion ${name} is in the future`);
    }
  }
  return exp;
}

/**
 * クライアントアサーションの `jti` を返す。
 *
 * `jti` は再利用を見分けるための識別子で、private_key_jwt では必須である（OIDC Core 1.0 §9）。
 *
 * @spec OIDC Core 1.0 §9
 * @spec RFC 7519 §4.1.7
 * @throws {TokenError} `invalid_client`: `jti` が空でない文字列でないとき
 */
export function requireClientAssertionJti(claims: Record<string, unknown>): string {
  const jti = claims['jti'];
  if (typeof jti !== 'string' || jti.length === 0) {
    throw invalidClientAssertion('client_assertion jti is required');
  }
  return jti;
}

/**
 * クライアントアサーションのクレームを確かめ、`jti` と、`jti` を覚えておく期限を返す。
 *
 * {@link validateClientAssertionSubject}、{@link validateClientAssertionAudience}、{@link validateClientAssertionTimes}、{@link requireClientAssertionJti} をこの順に呼ぶ。
 * 署名は確かめないので、{@link verifyClientAssertionSignature} と組み合わせて使う。
 *
 * @spec OIDC Core 1.0 §9
 * @spec RFC 7523 §3
 * @throws {TokenError} `invalid_client`: どれかのクレームが正しくないとき
 */
export function validateClientAssertionClaims(
  claims: Record<string, unknown>,
  policy: ClientAssertionClaimsPolicy,
): ValidatedClientAssertionClaims {
  const leewaySeconds = policy.leewaySeconds ?? DEFAULT_CLIENT_ASSERTION_LEEWAY_SECONDS;
  validateClientAssertionSubject(claims, policy.clientId);
  validateClientAssertionAudience(claims, policy.audiences);
  const exp = validateClientAssertionTimes(claims, policy.now, leewaySeconds);
  const jti = requireClientAssertionJti(claims);
  return { jti, replayWindowEndsAt: Math.ceil(exp + leewaySeconds) };
}

/**
 * クライアントが `private_key_jwt` の用途に登録した公開鍵を読んで返す。
 *
 * `kid` があれば `ClientKeyResolver.findClientKeys()` の手がかりに渡すので、`jwks_uri` を登録したクライアントが鍵を足したときは、見慣れない `kid` で `jwks_uri` を取り直す（OIDC Core 1.0 §10.1.1）。
 * `jwks_uri` の取得の失敗（`ClientJwksUriError`）は、理由を含まない固定の文言の `invalid_client` にする。
 * 失敗の理由は OP の内側のネットワークを探る手がかりになるので、応答に出さない。
 * ほかのエラーはそのまま投げる。
 *
 * @spec OIDC Core 1.0 §9
 * @spec OIDC Core 1.0 §10.1.1
 * @throws {TokenError} `invalid_client`: `jwks_uri` から鍵を取得できないとき
 */
export async function loadClientAssertionKeys(
  resolver: ClientKeyResolver,
  clientId: string,
  kid: string | undefined,
): Promise<JwkSet> {
  try {
    return await resolver.findClientKeys(clientId, 'private_key_jwt', kid === undefined ? {} : { kid });
  } catch (error) {
    // クラスではなく形で見分ける。プロセスで共有するキャッシュは、別に読み込まれた core の複製が作ったものかもしれない（isClientJwksUriError）。
    if (isClientJwksUriError(error)) {
      throw invalidClientAssertion('the client jwks_uri could not be retrieved');
    }
    throw error;
  }
}

/**
 * クライアントアサーションの署名を、クライアントの公開鍵のどれかで検証する。
 *
 * ヘッダーに `kid` があれば `kid` が一致する鍵を、なければすべての鍵を候補にする。
 * 候補のうち、`use` がないか `sig` で、使える alg（`resolveJwkSigningAlg()`）がヘッダーの `alg` と同じ鍵だけを順に試す（RFC 8725 §3.1）。
 * 鍵はヘッダーの `alg` のとおりにインポートし（`importJwkForJwsVerification()`）、2048 ビット未満の RSA の鍵やインポートできない鍵は飛ばす。
 * どれか一つの鍵で署名を検証できれば返る。
 *
 * @spec OIDC Core 1.0 §9
 * @spec RFC 7515 §5.2
 * @spec RFC 8725 §3.1
 * @throws {TokenError} `invalid_client`: 鍵がないとき、`kid` か `alg` に合う鍵がないとき、どの鍵でも署名を検証できないとき
 */
export async function verifyClientAssertionSignature(
  decoded: Pick<DecodedClientAssertion, 'alg' | 'kid' | 'signingInput' | 'signature'>,
  jwks: JwkSet,
): Promise<void> {
  const keys: Jwk[] = jwks.keys;
  if (keys.length === 0) {
    throw invalidClientAssertion('no keys registered to verify the client_assertion');
  }
  const keysOfKid = decoded.kid === undefined ? keys : keys.filter((key) => key.kid === decoded.kid);
  const candidates = keysOfKid.filter(
    (key) => (key.use === undefined || key.use === 'sig') && resolveJwkSigningAlg(key) === decoded.alg,
  );
  if (candidates.length === 0) {
    throw invalidClientAssertion('no registered key matches the client_assertion header');
  }
  for (const jwk of candidates) {
    let publicKey: CryptoKey;
    try {
      publicKey = await importJwkForJwsVerification(jwk, decoded.alg);
    } catch {
      // 2048 ビット未満の RSA の鍵（RFC 7518 §3.3）や、WebCrypto がインポートできない鍵は飛ばす。
      continue;
    }
    try {
      if (await verify(decoded.signingInput, decoded.signature, publicKey)) {
        return;
      }
    } catch {
      // 次の候補の鍵を試す。
    }
  }
  throw invalidClientAssertion('client_assertion signature verification failed');
}

/**
 * クライアントアサーションの `jti` を消費し、使用済みなら拒否する。
 *
 * `jti` はクライアントごとに一意であればよいので（RFC 7519 §4.1.7）、`client_id` と `jti` の組をキーにして `store` に `replayWindowEndsAt` まで覚えさせる。
 * キーは `[clientId, jti]` の JSON なので、どちらの値に区切りの文字が含まれていても、別の組のキーと同じにならない。
 * 署名とクレームを確かめた後で呼ぶ。検証できないアサーションの `jti` を覚えると、正しいクライアントの `jti` を先に使わせる妨害ができるためである。
 *
 * @spec RFC 7523 §3
 * @spec OIDC Core 1.0 §9
 * @throws {TokenError} `invalid_client`: 同じ `jti` のアサーションがすでに使われたとき
 */
export async function consumeClientAssertionJti(
  store: ClientAssertionJtiStore,
  assertion: { clientId: string; jti: string; replayWindowEndsAt: number },
): Promise<void> {
  const first = await store.consume(JSON.stringify([assertion.clientId, assertion.jti]), assertion.replayWindowEndsAt);
  if (!first) {
    throw invalidClientAssertion('client_assertion has already been used');
  }
}
