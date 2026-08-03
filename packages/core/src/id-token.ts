import {
  sign,
  verify,
  arrayBufferToBase64Url,
  base64UrlToArrayBufferStrict,
  stringToArrayBuffer,
  getJwaAlgorithm,
  extractAlgorithmParamsFromJwk,
} from './crypto-utils.js';
import type { JwkSet } from './jwks.js';
import { isLoopbackHostname } from './loopback.js';

/**
 * ID Tokenのペイロード
 */
export interface IdTokenPayload {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  auth_time?: number;
  nonce?: string;
  acr?: string;
  amr?: string[];
  azp?: string;
  [key: string]: unknown;
}

/**
 * ID Token生成のオプション
 */
export interface GenerateIdTokenOptions {
  payload: IdTokenPayload;
  privateKey: CryptoKey;
  keyId?: string;
}



/**
 * issuer URLを検証する
 */
function validateIssuer(iss: string): void {
  // RFC 7519 §2 (StringOrURL): normalize the raw `new URL` TypeError into a clear
  // library error so callers get a consistent failure for a non-URL issuer.
  let url: URL;
  try {
    url = new URL(iss);
  } catch {
    throw new Error('Issuer must be a valid URL');
  }

  // issuer must be https (except for loopback hosts used during development)
  if (url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('Issuer must use https scheme (except for loopback hosts)');
  }

  // issuer must not have query parameters
  if (url.search) {
    throw new Error('Issuer must not contain query parameters');
  }

  // issuer must not have fragment
  if (url.hash) {
    throw new Error('Issuer must not contain fragment');
  }
}

/**
 * Clock Skew 許容の既定値（秒）。
 *
 * RFC 8725 §3.8: 検証側は `iat` / `exp` / `nbf` を厳格に確認すべきで、leeway は
 * 数分以内に留める。通常は 30〜60 秒が妥当で、5 分（300 秒）を超える設定は推奨しない。
 * https://datatracker.ietf.org/doc/html/rfc8725#section-3.8
 */
export const DEFAULT_CLOCK_SKEW_TOLERANCE_SEC = 60;

/**
 * ペイロードを検証する
 *
 * @param payload 検証する ID Token ペイロード
 * @param options.clockSkewToleranceSec `exp` 過去判定に用いる leeway（秒）。
 *   未指定時は {@link DEFAULT_CLOCK_SKEW_TOLERANCE_SEC}。RFC 8725 §3.8 に従い
 *   通常 30〜60 秒、5 分超は推奨しない。
 */
export function validatePayload(
  payload: IdTokenPayload,
  options?: { clockSkewToleranceSec?: number },
): void {
  // Required claims validation
  if (!payload.iss) {
    throw new Error('Missing required claim: iss');
  }
  validateIssuer(payload.iss);

  if (!payload.sub) {
    throw new Error('Missing required claim: sub');
  }

  // OIDC Core 1.0 Section 5.1: sub must not exceed 255 ASCII characters
  if (payload.sub.length > 255) {
    throw new Error('Subject identifier must not exceed 255 ASCII characters');
  }

  if (payload.aud === undefined || payload.aud === null) {
    throw new Error('Missing required claim: aud');
  }

  // Validate aud is not empty array
  if (Array.isArray(payload.aud) && payload.aud.length === 0) {
    throw new Error('Audience must not be an empty array');
  }

  // RFC 7519 §4.1.3 (aud = StringOrURI / array of StringOrURI): reject empty or
  // non-string members so a structurally invalid audience is never issued. This
  // mirrors the strictness the verification path (validateIdTokenHint) applies.
  if (Array.isArray(payload.aud)) {
    for (const a of payload.aud) {
      if (typeof a !== 'string' || a.length === 0) {
        throw new Error('Audience array must contain only non-empty strings');
      }
    }
  }

  if (payload.exp === undefined || payload.exp === null) {
    throw new Error('Missing required claim: exp');
  }

  // RFC 7519 §4.1.4 (exp is a NumericDate): the issued payload must use a numeric
  // exp, matching the typeof === 'number' check in validateIdTokenHint.
  if (typeof payload.exp !== 'number') {
    throw new Error('exp must be a number (NumericDate)');
  }

  // Validate exp is not too far in the past (with configurable clock skew tolerance)
  const leeway = options?.clockSkewToleranceSec ?? DEFAULT_CLOCK_SKEW_TOLERANCE_SEC;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now - leeway) {
    throw new Error('Token expiration time is in the past');
  }

  if (payload.iat === undefined || payload.iat === null) {
    throw new Error('Missing required claim: iat');
  }

  // RFC 7519 §4.1.6 (iat is a NumericDate): match validateIdTokenHint strictness.
  if (typeof payload.iat !== 'number') {
    throw new Error('iat must be a number (NumericDate)');
  }

  // azp validation: required when aud has multiple values (OIDC Core §3.1.3.7 (4-5)).
  // The issuing path (token-response.ts / buildIdTokenAudience) emits aud = clientId with
  // no azp for the single-audience default, and aud = [clientId, ...] with azp = clientId
  // when additional audiences are configured. This validator enforces the same rule for
  // both self-issued tokens and ID Tokens received from outside (id_token_hint, federation)
  // that may carry multiple audiences.
  if (Array.isArray(payload.aud) && payload.aud.length > 1) {
    if (!payload.azp) {
      throw new Error('azp is required when aud contains multiple values');
    }

    // azp must be one of the aud values
    if (!payload.aud.includes(payload.azp)) {
      throw new Error('azp must be one of the audience values');
    }
  }
}

/**
 * Base64URL エンコード
 */
function base64UrlEncode(str: string): string {
  return arrayBufferToBase64Url(stringToArrayBuffer(str));
}

/**
 * IDトークンを生成する（JWT形式）
 * サポートする署名アルゴリズム（JWA名称 = 暗号方式）:
 * - RS256/RS384/RS512 = RSASSA-PKCS1-v1_5 with SHA-256/384/512
 *   ※ OpenID Connect Core 1.0でRS256はデフォルトアルゴリズム（SHOULD）
 * - ES256/ES384/ES512 = ECDSA with P-256/P-384/P-521 and SHA-256/384/512【推奨】
 *   ※ 楕円曲線暗号による高速かつ安全な署名方式
 * @param options ID Token生成のオプション
 * @returns 生成されたID Token（JWT形式）
 */
export async function generateIdToken(options: GenerateIdTokenOptions): Promise<string> {
  const { payload, privateKey, keyId } = options;

  // Validate payload
  validatePayload(payload);

  // Build JOSE header
  const header: Record<string, string> = {
    alg: getJwaAlgorithm(privateKey),
    typ: 'JWT',
  };

  if (keyId) {
    header.kid = keyId;
  }

  // Encode header and payload
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));

  // Create signing input
  const signingInput = `${headerB64}.${payloadB64}`;

  // Sign
  const signature = await sign(signingInput, privateKey);

  return `${signingInput}.${signature}`;
}

/**
 * id_token_hint 検証エラー
 *
 * OIDC Core 1.0 §3.1.2.1 / §3.1.2.6: id_token_hint が無効な場合、prompt=none との
 * 組み合わせで `login_required` を返す必要がある。呼び出し側がそのまま AS エラーに
 * 写像できるよう、`error` プロパティに OAuth エラーコードを保持する。
 */
export class IdTokenHintError extends Error {
  public readonly error: 'login_required';

  constructor(message: string) {
    super(message);
    this.name = 'IdTokenHintError';
    this.error = 'login_required';
  }
}

/**
 * RFC 7515 が「鍵を外部から取得するための情報源」として定義する JOSE Header フィールド。
 * 本リポジトリは事前登録済み JWKS のみで鍵を選ぶため、これらが受信 JWS に含まれていたら
 * 即拒否する（RFC 8725 §3.1 / OIDC Core §16.18: SSRF・任意公開鍵差し替え・Cross-JWT confusion 対策）。
 * - jku: RFC 7515 §4.1.2 / jwk: §4.1.3 / x5u: §4.1.5 / x5c: §4.1.6
 */
const FORBIDDEN_KEY_HEADERS = ['jku', 'x5u', 'jwk', 'x5c'] as const;

/**
 * 受信 JWS の JOSE Header に外部鍵取得系フィールドが含まれていないことを表明する。
 * logout_token / request Object など、将来追加する JWS 受信処理でも再利用できるよう
 * 小さなヘルパとして括り出している。
 */
function assertNoExternalKeyHeaders(header: Record<string, unknown>): void {
  for (const field of FORBIDDEN_KEY_HEADERS) {
    if (field in header) {
      throw new IdTokenHintError(
        `id_token_hint JOSE header contains unsupported field: ${field}`,
      );
    }
  }
}

/**
 * id_token_hint 検証ヘルパー
 *
 * OIDC Core 1.0 §3.1.2.1: `id_token_hint` が提供された場合、OP は hint の署名・iss・aud・
 * exp を検証してから sub を信頼してよい。本関数は JWT 構造のパース → JWKS からの鍵選択 →
 * 署名検証 → クレーム検証を行い、検証通過時に payload を返す。失敗時は `IdTokenHintError`
 * を throw するため、呼び出し側はそのまま `login_required` に変換できる。
 *
 * 鍵選択ロジック:
 * 1. JOSE header に `kid` が含まれる場合は同じ kid を持つ JWK を優先（一意）。
 * 2. それ以外は `alg` が一致する最初の JWK を使う。複数候補がある場合は順次試行する。
 *
 * @param hint id_token_hint パラメータの値（compact JWS / JWT 文字列）
 * @param options 検証に必要な期待値（iss / aud）と JWKS
 * @param verifyOptions.clockSkewToleranceSec `exp` 過去判定および `iat` 未来判定に用いる
 *   leeway（秒）。未指定時は {@link DEFAULT_CLOCK_SKEW_TOLERANCE_SEC}。RFC 8725 §3.8 に
 *   従い通常 30〜60 秒、5 分超は推奨しない。
 * @returns 検証通過した ID Token の payload（少なくとも sub を含む）
 * @throws {IdTokenHintError} 検証失敗時
 */
export async function validateIdTokenHint(
  hint: string,
  options: {
    expectedIss: string;
    expectedAud: string;
    jwks: JwkSet;
  },
  verifyOptions?: { clockSkewToleranceSec?: number },
): Promise<{ sub: string; [key: string]: unknown }> {
  const { expectedIss, expectedAud, jwks } = options;
  const leeway = verifyOptions?.clockSkewToleranceSec ?? DEFAULT_CLOCK_SKEW_TOLERANCE_SEC;

  if (typeof hint !== 'string' || hint.length === 0) {
    throw new IdTokenHintError('id_token_hint is empty');
  }

  const parts = hint.split('.');
  if (parts.length !== 3) {
    throw new IdTokenHintError('id_token_hint is not a valid JWS compact serialization');
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToArrayBufferStrict(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToArrayBufferStrict(payloadB64)));
  } catch {
    throw new IdTokenHintError('id_token_hint header or payload is not valid base64url JSON');
  }

  const headerAlg = typeof header['alg'] === 'string' ? (header['alg'] as string) : undefined;
  if (!headerAlg || headerAlg === 'none') {
    throw new IdTokenHintError('id_token_hint alg is missing or "none"');
  }
  // RFC 8725 §3.1 / OIDC Core §16.18: 外部から鍵を取得しうるヘッダは明示拒否する。
  assertNoExternalKeyHeaders(header);
  const headerKid = typeof header['kid'] === 'string' ? (header['kid'] as string) : undefined;

  // Pick candidate keys: kid match wins; otherwise fall back to alg match.
  // Multiple alg-matched keys may be tried in order — the first valid signature wins.
  const candidates = headerKid
    ? jwks.keys.filter((k) => k.kid === headerKid)
    : jwks.keys.filter((k) => k.alg === headerAlg);

  if (candidates.length === 0) {
    throw new IdTokenHintError('No JWK matched the id_token_hint header');
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  let signatureValid = false;
  for (const jwk of candidates) {
    if (jwk.alg !== headerAlg) {
      // alg-claim mismatch with the picked key → reject without verifying
      // (RFC 7515 §4.1.1 — alg pin per key).
      continue;
    }
    let publicKey: CryptoKey;
    try {
      const algParams = extractAlgorithmParamsFromJwk(jwk);
      publicKey = await crypto.subtle.importKey('jwk', jwk, algParams, false, ['verify']);
    } catch {
      continue;
    }
    try {
      if (await verify(signingInput, signatureB64, publicKey)) {
        signatureValid = true;
        break;
      }
    } catch {
      // try next candidate
    }
  }
  if (!signatureValid) {
    throw new IdTokenHintError('id_token_hint signature verification failed');
  }

  if (payload['iss'] !== expectedIss) {
    throw new IdTokenHintError('id_token_hint iss does not match expected issuer');
  }

  // aud may be a string or string[] (OIDC Core 1.0 §2)
  const aud = payload['aud'];
  const audMatches =
    aud === expectedAud || (Array.isArray(aud) && aud.includes(expectedAud));
  if (!audMatches) {
    throw new IdTokenHintError('id_token_hint aud does not match expected audience');
  }

  // exp must be in the future (allow clock skew, mirroring validatePayload)
  const exp = payload['exp'];
  if (typeof exp !== 'number') {
    throw new IdTokenHintError('id_token_hint is missing exp claim');
  }
  const now = Math.floor(Date.now() / 1000);
  if (exp + leeway < now) {
    throw new IdTokenHintError('id_token_hint has expired');
  }

  // iat must be present and not in the future beyond the allowed leeway.
  // RFC 8725 §3.8 / RFC 7519 §4.1.6: reject tokens whose iat is implausibly in the
  // future to limit replay / session-fixation style abuse via a forged id_token_hint.
  const iat = payload['iat'];
  if (typeof iat !== 'number') {
    throw new IdTokenHintError('id_token_hint is missing iat claim');
  }
  if (iat > now + leeway) {
    throw new IdTokenHintError('id_token_hint iat is in the future');
  }

  if (typeof payload['sub'] !== 'string' || payload['sub'].length === 0) {
    throw new IdTokenHintError('id_token_hint is missing sub claim');
  }

  return payload as { sub: string; [key: string]: unknown };
}
