import { buildJoseHeader, signJwt } from './jwt.js';
import { getJwaAlgorithm } from './crypto-utils.js';

/**
 * Access Tokenのペイロード
 */
export interface AccessTokenPayload {
  iss: string;
  sub: string;
  aud: string[];
  exp: number;
  iat: number;
  /**
   * RFC 9068 §2.2 / RFC 7519 §4.1.5: "not before". OPTIONAL for JWT access
   * tokens; emitted by the JWT issuer (set to iat) for clock-skew tolerance.
   */
  nbf?: number;
  /**
   * RFC 9068 §2.2: `jti` is REQUIRED for JWT access tokens.
   * RFC 7519 §4.1.7: the value MUST be assigned so that the probability of the
   * same value being assigned to a different token is negligible.
   *
   * It is also what keeps two issuances distinct: RS256 (RFC 8017 §8.2) is a
   * deterministic signature scheme, so a payload rebuilt from identical input
   * within the same wall-clock second would otherwise sign to a byte-identical
   * token and silently overwrite the earlier record in a token-keyed store.
   *
   * Optional in the type so callers can build a payload for an Opaque issuer,
   * which carries no claims in the token string. {@link buildAccessTokenPayload}
   * always populates it.
   */
  jti?: string;
  scope?: string;
  client_id?: string;
  /**
   * RFC 9068 §2.2.1: the Authentication Context Class Reference (OIDC Core 1.0
   * §2) the authentication that obtained this token satisfied. OPTIONAL.
   */
  acr?: string;
  [key: string]: unknown;
}

/**
 * Access Token生成のオプション
 */
export interface GenerateAccessTokenOptions {
  payload: AccessTokenPayload;
  privateKey: CryptoKey;
  keyId?: string;
}


/**
 * ペイロードのクレームが不正なら `Error` を投げる。
 *
 * 次のどれかに当てはまると `Error` を投げる:
 * - `iss`、`sub`、`iat` のどれかがない（`iss` と `sub` は空文字列も拒否する）。
 * - `aud` がない、配列でない、または空の配列である。
 * - `exp` がない、または 60 秒を超えて過ぎている。
 */
function validatePayload(payload: AccessTokenPayload): void {
  // 必須のクレームがあることを確かめる。
  if (!payload.iss) {
    throw new Error('Missing required claim: iss');
  }

  if (!payload.sub) {
    throw new Error('Missing required claim: sub');
  }

  if (payload.aud === undefined || payload.aud === null) {
    throw new Error('Missing required claim: aud');
  }

  // `aud` が空でない配列であることを確かめる。
  // `aud` は JWT のアクセストークンを受け取るリソースサーバーを示すので、空の値は不正である（RFC 9068 §3）。
  if (!Array.isArray(payload.aud) || payload.aud.length === 0) {
    throw new Error('Invalid aud claim: must be a non-empty array');
  }

  // `exp` が過ぎていないことを確かめる（時計のずれとして 60 秒まで許容する）。
  validateAccessTokenExpiration(payload.exp, Math.floor(Date.now() / 1000), 60);

  if (payload.iat === undefined || payload.iat === null) {
    throw new Error('Missing required claim: iat');
  }
}

/**
 * `exp` がないか期限切れなら `Error` を投げる。
 *
 * `expiration` が `undefined` か `null` のとき、または `now - leeway` より前のときに `Error` を投げる。
 * `now` と `leeway` は秒で渡し、`leeway` には時計のずれとして許容する幅を渡す。
 *
 * @spec RFC 9068 §2.2
 * @spec RFC 7519 §4.1.4
 */
export function validateAccessTokenExpiration(
  expiration: number | undefined | null,
  now: number,
  leeway: number,
): void {
  if (expiration === undefined || expiration === null) {
    throw new Error('Missing required claim: exp');
  }

  if (expiration < now - leeway) {
    throw new Error('Token expiration time is in the past');
  }
}

/**
 * ペイロードを検証し、署名した JWT を返す。
 *
 * 必須のクレーム（`iss`、`sub`、`aud`、`exp`、`iat`）が欠けているとき、`aud` が空の配列のとき、`exp` が 60 秒を超えて過ぎているときは、`Error` を投げる。
 * ヘッダーの `alg` は秘密鍵のアルゴリズムから決め、`typ` は `at+jwt` にし、`kid` は `keyId` を渡したときだけ付ける。
 *
 * 対応する署名アルゴリズム（JWA の名前と暗号方式）は次のとおりである:
 * - RS256、RS384、RS512: SHA-256、SHA-384、SHA-512 を使う RSASSA-PKCS1-v1_5。OpenID Connect と OAuth 2.1 で広く使われている標準のアルゴリズムである。
 * - ES256、ES384、ES512: P-256、P-384、P-521 の曲線と SHA-256、SHA-384、SHA-512 を使う ECDSA。楕円曲線暗号による高速で安全な署名方式で、こちらを推奨する。
 *
 * RSASSA-PKCS1-v1_5 と ECDSA 以外の鍵を渡すと `Error` を投げる。
 *
 * @param options ペイロード、署名に使う秘密鍵、ヘッダーの `kid` に入れる鍵の ID。
 * @returns 署名した JWT のアクセストークン（JWS のコンパクト形式）。
 * @spec RFC 9068 §2.1
 */
export async function generateAccessToken(options: GenerateAccessTokenOptions): Promise<string> {
  const { payload, privateKey, keyId } = options;

  // ペイロードのクレームを検証する。
  validatePayload(payload);

  // 秘密鍵に合う `alg` と、`typ` が `at+jwt` の JOSE ヘッダーを組み立てる。
  // `typ` を `at+jwt` にするのは、リソースサーバーがアクセストークンと ID トークン（`typ` が `JWT`）を区別できるようにするためである（RFC 9068 §2.1）。
  const header = buildJoseHeader(getJwaAlgorithm(privateKey), 'at+jwt', keyId);

  return signJwt(header, payload, privateKey);
}
