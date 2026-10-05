import { buildJoseHeader, signJwt } from './jwt.js';
import {
  verify,
  base64UrlToArrayBufferStrict,
  getJwaAlgorithm,
  extractAlgorithmParamsFromJwk,
} from './crypto-utils.js';
import type { Jwk, JwkSet } from './jwks.js';
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
  validateIdTokenIssuer(payload.iss);

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

  const leeway = options?.clockSkewToleranceSec ?? DEFAULT_CLOCK_SKEW_TOLERANCE_SEC;
  validateIdTokenExpiration(payload.exp, Math.floor(Date.now() / 1000), leeway);

  if (payload.iat === undefined || payload.iat === null) {
    throw new Error('Missing required claim: iat');
  }

  // RFC 7519 §4.1.6 (iat is a NumericDate): match validateIdTokenHint strictness.
  if (typeof payload.iat !== 'number') {
    throw new Error('iat must be a number (NumericDate)');
  }

  validateIdTokenAuthorizedParty(payload.aud, payload.azp);
}

/**
 * OIDC Core 1.0 §2: iss があり、クエリとフラグメントを含まない https の URL であることを検証する。
 * ループバックホストに限り http を許す。
 */
export function validateIdTokenIssuer(issuer: string | undefined): void {
  if (!issuer) {
    throw new Error('Missing required claim: iss');
  }
  validateIssuer(issuer);
}

/**
 * ID Token の exp があり、数値で、now から leeway を引いた時刻より前でないことを検証する。
 * RFC 7519 §4.1.4。now と leeway は秒。
 */
export function validateIdTokenExpiration(expiration: unknown, now: number, leeway: number): void {
  if (expiration === undefined || expiration === null) {
    throw new Error('Missing required claim: exp');
  }

  // RFC 7519 §4.1.4 (exp is a NumericDate): the issued payload must use a numeric
  // exp, matching the typeof === 'number' check in validateIdTokenHint.
  if (typeof expiration !== 'number') {
    throw new Error('exp must be a number (NumericDate)');
  }

  if (expiration < now - leeway) {
    throw new Error('Token expiration time is in the past');
  }
}

/**
 * OIDC Core 1.0 §2 / §3.1.3.7: aud が複数の値を持つ場合に azp があり、aud の一つであることを検証する。
 * aud が一つなら検査しない。
 */
export function validateIdTokenAuthorizedParty(
  audience: string | readonly string[],
  authorizedParty: string | undefined,
): void {
  // The issuing path (token-response.ts / buildIdTokenAudience) emits aud = clientId with
  // no azp for the single-audience default, and aud = [clientId, ...] with azp = clientId
  // when additional audiences are configured. This validator enforces the same rule for
  // both self-issued tokens and ID Tokens received from outside (id_token_hint, federation)
  // that may carry multiple audiences.
  if (Array.isArray(audience) && audience.length > 1) {
    if (!authorizedParty) {
      throw new Error('azp is required when aud contains multiple values');
    }

    // azp must be one of the aud values
    if (!audience.includes(authorizedParty)) {
      throw new Error('azp must be one of the audience values');
    }
  }
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
  const header = buildJoseHeader(getJwaAlgorithm(privateKey), 'JWT', keyId);

  return signJwt(header, payload, privateKey);
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

  const { header, payload, signingInput, signature } = decodeIdTokenHint(hint);
  const { algorithm, keyId } = validateIdTokenHintHeader(header);
  const candidates = selectIdTokenHintKeys(jwks.keys, algorithm, keyId);
  await verifyIdTokenHintSignature(signingInput, signature, candidates, algorithm);

  validateIdTokenHintIssuer(payload['iss'], expectedIss);
  validateIdTokenHintAudience(payload['aud'], expectedAud);
  const now = Math.floor(Date.now() / 1000);
  validateIdTokenHintExpiration(payload['exp'], now, leeway);
  validateIdTokenHintIssuedAt(payload['iat'], now, leeway);
  requireIdTokenHintSubject(payload['sub']);

  return payload as { sub: string; [key: string]: unknown };
}

/** {@link decodeIdTokenHint} の戻り値。署名を検証していないため、どのクレームも信頼できない。 */
export interface DecodedIdTokenHint {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: string;
}

/**
 * id_token_hint の JWS Compact Serialization を分解し、ヘッダーとペイロードを JSON として解析する。
 * 署名、発行者、有効期限は検証しない。
 */
export function decodeIdTokenHint(hint: string): DecodedIdTokenHint {
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

  return { header, payload, signingInput: `${headerB64}.${payloadB64}`, signature: signatureB64 };
}

/**
 * id_token_hint のヘッダーが署名付きで、外部の鍵を参照しないことを検証する（RFC 8725 §3.1）。
 * alg と kid を返す。
 */
export function validateIdTokenHintHeader(
  header: Record<string, unknown>,
): { algorithm: string; keyId: string | undefined } {
  const headerAlg = typeof header['alg'] === 'string' ? (header['alg'] as string) : undefined;
  if (!headerAlg || headerAlg === 'none') {
    throw new IdTokenHintError('id_token_hint alg is missing or "none"');
  }
  // RFC 8725 §3.1 / OIDC Core §16.18: 外部から鍵を取得しうるヘッダは明示拒否する。
  assertNoExternalKeyHeaders(header);
  const headerKid = typeof header['kid'] === 'string' ? (header['kid'] as string) : undefined;
  return { algorithm: headerAlg, keyId: headerKid };
}

/**
 * ヘッダーの kid、無ければ alg に合う登録済みの鍵を選ぶ。一つも無ければ拒否する。
 * 選んだ鍵の alg との一致は {@link verifyIdTokenHintSignature} が確かめる。
 */
export function selectIdTokenHintKeys<Key extends Pick<Jwk, 'alg' | 'kid'>>(
  keys: readonly Key[],
  algorithm: string,
  keyId?: string,
): Key[] {
  const candidates = keyId
    ? keys.filter((k) => k.kid === keyId)
    : keys.filter((k) => k.alg === algorithm);

  if (candidates.length === 0) {
    throw new IdTokenHintError('No JWK matched the id_token_hint header');
  }
  return candidates;
}

/**
 * 候補の鍵で署名を検証し、どれか一つで成功すれば通す。
 * alg が一致しない鍵や読み込めない鍵は飛ばす（RFC 7515 §4.1.1）。
 */
export async function verifyIdTokenHintSignature(
  signingInput: string,
  signature: string,
  candidates: readonly Jwk[],
  algorithm: string,
): Promise<void> {
  for (const jwk of candidates) {
    if (jwk.alg !== algorithm) {
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
      if (await verify(signingInput, signature, publicKey)) {
        return;
      }
    } catch {
      // try next candidate
    }
  }
  throw new IdTokenHintError('id_token_hint signature verification failed');
}

/** id_token_hint の iss が期待する発行者と一致することを検証する。署名の検証後に呼ぶ。 */
export function validateIdTokenHintIssuer(issuer: unknown, expectedIssuer: string): void {
  if (issuer !== expectedIssuer) {
    throw new IdTokenHintError('id_token_hint iss does not match expected issuer');
  }
}

/** OIDC Core 1.0 §2: id_token_hint の aud（文字列または配列）が期待する audience を含むことを検証する。 */
export function validateIdTokenHintAudience(audience: unknown, expectedAudience: string): void {
  const matches = audience === expectedAudience ||
    (Array.isArray(audience) && audience.includes(expectedAudience));
  if (!matches) {
    throw new IdTokenHintError('id_token_hint aud does not match expected audience');
  }
}

/** id_token_hint の exp が数値で、exp に leeway を足した時刻が now より前でないことを検証する。時刻は秒。 */
export function validateIdTokenHintExpiration(expiration: unknown, now: number, leeway: number): void {
  if (typeof expiration !== 'number') {
    throw new IdTokenHintError('id_token_hint is missing exp claim');
  }
  if (expiration + leeway < now) {
    throw new IdTokenHintError('id_token_hint has expired');
  }
}

/** RFC 8725 §3.8: id_token_hint の iat が数値で、now に leeway を足した時刻より未来でないことを検証する。 */
export function validateIdTokenHintIssuedAt(issuedAt: unknown, now: number, leeway: number): void {
  if (typeof issuedAt !== 'number') {
    throw new IdTokenHintError('id_token_hint is missing iat claim');
  }
  if (issuedAt > now + leeway) {
    throw new IdTokenHintError('id_token_hint iat is in the future');
  }
}

/** id_token_hint の sub が空でない文字列であることを確かめる。すべての検証を通した後に使う。 */
export function requireIdTokenHintSubject(subject: unknown): string {
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new IdTokenHintError('id_token_hint is missing sub claim');
  }
  return subject;
}
