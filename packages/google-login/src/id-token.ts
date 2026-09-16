/**
 * Google の ID トークンの検証。
 *
 * Google のドキュメント「サーバーサイドで Google ID トークンを検証する」が挙げる条件を
 * ステップ関数に分け、{@link verifyGoogleIdToken} で同じ順序に合成する。
 *
 *   1. ID トークンが Google によって適切に署名されている（Google の公開鍵で署名を検証する）
 *   2. `aud` の値がアプリのクライアント ID と同じである
 *   3. `iss` の値が `accounts.google.com` または `https://accounts.google.com` と同じである
 *   4. `exp` の有効期限が経過していない
 *   5. （任意）Google Workspace / Cloud organization のユーザーに制限するなら `hd` を確認する
 *
 * これに加えて、redirect mode のログインを OP のトランザクションへ束縛するための
 * `nonce`（GIS の `data-nonce` / `nonce` 設定で ID トークンに載る）を検証できる。
 *
 * core の `validateIdTokenHint` と同じく、生成コードはステップ関数を個別に呼び出せる。
 */
import type { GoogleJwk, GoogleSigningKeyProvider } from './certs.js';
import { GoogleLoginError, GoogleLoginErrorCode } from './errors.js';
import { parseCompactJws, verifyRs256Signature } from './jws.js';

/** Google の ID トークンが取りうる `iss`（どちらも正当）。 */
export const GOOGLE_ID_TOKEN_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'] as const;

/** Google の ID トークンの署名アルゴリズム。これ以外は受け入れない（RFC 8725 §3.1）。 */
export const GOOGLE_ID_TOKEN_SIGNING_ALG = 'RS256';

/**
 * 時刻検証で許容するクロックスキュー（秒）の既定値。core の `DEFAULT_CLOCK_SKEW_TOLERANCE_SEC`
 * と揃える。
 */
export const DEFAULT_GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS = 60;

export interface GoogleIdTokenHeader {
  alg: string;
  kid: string;
  typ?: string;
  [member: string]: unknown;
}

/**
 * Google の ID トークンのペイロード。
 *
 * 必須の `iss` / `sub` / `aud` / `exp` / `iat` 以外は Google のドキュメントが
 * 「含まれることがある」と説明するクレーム。`sub` がユーザーの一意な識別子であり、
 * `email` はユーザーが変更できるためアカウントのキーには使わないこと。
 */
export interface GoogleIdTokenPayload {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  /** トークンを要求したクライアント ID（authorized party）。 */
  azp?: string;
  nbf?: number;
  jti?: string;
  email?: string;
  email_verified?: boolean;
  /** Google Workspace / Cloud organization のホストされたドメイン。 */
  hd?: string;
  name?: string;
  picture?: string;
  given_name?: string;
  family_name?: string;
  locale?: string;
  /** GIS の `nonce` 設定で載る値。redirect mode のログインを OP のトランザクションへ束縛するために使う。 */
  nonce?: string;
  at_hash?: string;
  [claim: string]: unknown;
}

/** 署名検証前の分解結果。 */
export interface DecodedGoogleIdToken {
  header: GoogleIdTokenHeader;
  payload: GoogleIdTokenPayload;
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
}

/** 検証済みの ID トークン。 */
export interface VerifiedGoogleIdToken {
  header: GoogleIdTokenHeader;
  payload: GoogleIdTokenPayload;
}

export interface GoogleIdTokenTimeOptions {
  /** 検証時刻。既定は現在時刻。テストでの差し替え用。 */
  now?: Date;
  /** 許容するクロックスキュー（秒）。既定は {@link DEFAULT_GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS}。 */
  clockSkewSeconds?: number;
}

export interface VerifyGoogleIdTokenOptions extends GoogleIdTokenTimeOptions {
  /**
   * `aud` と突き合わせるクライアント ID。複数のクライアント（Web / Android / iOS）から
   * 同じバックエンドへ ID トークンが届く構成では配列で渡す。
   */
  clientId: string | readonly string[];
  /** 署名検証に使う Google の公開鍵。 */
  keyProvider: GoogleSigningKeyProvider;
  /** 指定すると `hd` がこのドメイン（のいずれか）と一致することを要求する。 */
  hostedDomain?: string | readonly string[];
  /** true なら `email_verified: true` を要求する。メールでアカウントを対応付ける構成向け。 */
  requireVerifiedEmail?: boolean;
  /** 指定すると `nonce` クレームがこの値と一致することを要求する。 */
  expectedNonce?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNumericDate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isAudience(value: unknown): value is string | string[] {
  if (isNonEmptyString(value)) return true;
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function normalizeList(value: string | readonly string[], label: string): readonly string[] {
  const list = typeof value === 'string' ? [value] : value;
  if (list.length === 0 || !list.every(isNonEmptyString)) {
    throw new TypeError(`${label} must be a non-empty string or a non-empty array of non-empty strings`);
  }
  return list;
}

function toSeconds(now: Date | undefined): number {
  return Math.floor((now ?? new Date()).getTime() / 1000);
}

/**
 * ステップ 0: ID トークンを分解し、JOSE ヘッダーと必須クレームの形を検証する。署名は検証しない。
 *
 * - `alg` は RS256 のみ受け入れる（`none` や HMAC 系へのすり替えを拒否する。RFC 8725 §3.1）
 * - `kid` は鍵の選択に必須
 * - `typ` は省略可。あれば `JWT`
 * - `iss` / `sub` は空でない文字列、`aud` は空でない文字列またはその配列、`exp` / `iat` は数値
 *
 * @throws {GoogleLoginError} `malformed_id_token` / `unsupported_algorithm`
 */
export function decodeGoogleIdToken(idToken: string): DecodedGoogleIdToken {
  if (!isNonEmptyString(idToken)) {
    throw new GoogleLoginError(GoogleLoginErrorCode.MalformedIdToken, 'ID token is empty');
  }
  const jws = parseCompactJws(idToken);

  const { alg, kid, typ } = jws.header;
  if (alg !== GOOGLE_ID_TOKEN_SIGNING_ALG) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.UnsupportedAlgorithm,
      `ID token alg must be ${GOOGLE_ID_TOKEN_SIGNING_ALG}`,
    );
  }
  if (!isNonEmptyString(kid)) {
    throw new GoogleLoginError(GoogleLoginErrorCode.MalformedIdToken, 'ID token header is missing kid');
  }
  if (typ !== undefined && !(typeof typ === 'string' && typ.toUpperCase() === 'JWT')) {
    throw new GoogleLoginError(GoogleLoginErrorCode.MalformedIdToken, 'ID token typ is not JWT');
  }

  const { iss, sub, aud, exp, iat } = jws.payload;
  if (!isNonEmptyString(iss) || !isNonEmptyString(sub) || !isAudience(aud) || !isNumericDate(exp) || !isNumericDate(iat)) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.MalformedIdToken,
      'ID token is missing a required claim (iss, sub, aud, exp, iat)',
    );
  }

  return {
    header: { ...jws.header, alg, kid } as GoogleIdTokenHeader,
    payload: { ...jws.payload, iss, sub, aud, exp, iat } as GoogleIdTokenPayload,
    signingInput: jws.signingInput,
    signature: jws.signature,
  };
}

/**
 * ステップ 1a: JOSE ヘッダーの `kid` に対応する Google の公開鍵を引く。
 *
 * @throws {GoogleLoginError} `unknown_signing_key`（鍵が見つからない）/ `signing_key_unavailable`（取得失敗）
 */
export async function resolveGoogleSigningKey(
  header: GoogleIdTokenHeader,
  keyProvider: GoogleSigningKeyProvider,
): Promise<GoogleJwk> {
  const key = await keyProvider.getSigningKey(header.kid);
  if (key === null) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.UnknownSigningKey,
      'No Google public key matches the ID token kid',
    );
  }
  return key;
}

/**
 * ステップ 1b: Google の公開鍵で署名を検証する。
 *
 * 鍵が RSA でない、または JWK の `alg` が RS256 以外を宣言している場合は、`alg` の
 * すり替えとみなして検証せずに拒否する。
 *
 * @throws {GoogleLoginError} `unsupported_algorithm` / `invalid_signature`
 */
export async function verifyGoogleIdTokenSignature(
  decoded: DecodedGoogleIdToken,
  key: GoogleJwk,
): Promise<void> {
  if (key.kty !== 'RSA' || !isNonEmptyString(key.n) || !isNonEmptyString(key.e)) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.UnsupportedAlgorithm,
      'Google public key is not an RSA key',
    );
  }
  if (key.alg !== undefined && key.alg !== GOOGLE_ID_TOKEN_SIGNING_ALG) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.UnsupportedAlgorithm,
      `Google public key alg must be ${GOOGLE_ID_TOKEN_SIGNING_ALG}`,
    );
  }

  const valid = await verifyRs256Signature(decoded.signingInput, decoded.signature, {
    kty: key.kty,
    n: key.n,
    e: key.e,
  });
  if (!valid) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.InvalidSignature,
      'ID token signature verification failed',
    );
  }
}

/**
 * ステップ 2: `aud` がアプリのクライアント ID と一致することを検証する。
 *
 * Google のドキュメント: 攻撃者のアプリに発行された ID トークンで、同じユーザーに関する
 * サーバー上のデータへアクセスされる恐れがあるため、この確認は必須。
 *
 * @throws {GoogleLoginError} `invalid_audience`
 */
export function validateGoogleIdTokenAudience(
  payload: GoogleIdTokenPayload,
  clientId: string | readonly string[],
): void {
  const clientIds = normalizeList(clientId, 'clientId');
  const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud;
  if (!audiences.some((audience) => clientIds.includes(audience))) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.InvalidAudience,
      'ID token aud does not match the configured client ID',
    );
  }
}

/**
 * ステップ 3: `iss` が `accounts.google.com` または `https://accounts.google.com` であることを検証する。
 *
 * @throws {GoogleLoginError} `invalid_issuer`
 */
export function validateGoogleIdTokenIssuer(payload: GoogleIdTokenPayload): void {
  if (!(GOOGLE_ID_TOKEN_ISSUERS as readonly string[]).includes(payload.iss)) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.InvalidIssuer,
      'ID token iss is not accounts.google.com',
    );
  }
}

/**
 * ステップ 4: `exp` が経過していないことを検証する。
 *
 * あわせて `nbf`（あれば）と `iat` が未来を指していないことも確認する。`iat` の確認は
 * ドキュメントの条件には無いが、Google の公式クライアントライブラリ（google-auth-library）
 * が "Token used too early" として拒否している挙動に合わせる。
 *
 * @throws {GoogleLoginError} `id_token_expired` / `id_token_not_yet_valid`
 */
export function validateGoogleIdTokenExpiration(
  payload: GoogleIdTokenPayload,
  options: GoogleIdTokenTimeOptions = {},
): void {
  const now = toSeconds(options.now);
  const skew = options.clockSkewSeconds ?? DEFAULT_GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS;

  if (now >= payload.exp + skew) {
    throw new GoogleLoginError(GoogleLoginErrorCode.IdTokenExpired, 'ID token has expired');
  }
  if (payload.nbf !== undefined && isNumericDate(payload.nbf) && now + skew < payload.nbf) {
    throw new GoogleLoginError(GoogleLoginErrorCode.IdTokenNotYetValid, 'ID token is not yet valid (nbf)');
  }
  if (payload.iat > now + skew) {
    throw new GoogleLoginError(GoogleLoginErrorCode.IdTokenNotYetValid, 'ID token is issued in the future (iat)');
  }
}

/**
 * ステップ 5（任意）: `hd` が許可したホストされたドメインと一致することを検証する。
 *
 * `hostedDomain` を渡さなければ何もしない。渡した場合、`hd` が無いトークン（個人の
 * Google アカウント）は拒否する。
 *
 * @throws {GoogleLoginError} `invalid_hosted_domain`
 */
export function validateGoogleHostedDomain(
  payload: GoogleIdTokenPayload,
  hostedDomain?: string | readonly string[],
): void {
  if (hostedDomain === undefined) return;
  const allowed = normalizeList(hostedDomain, 'hostedDomain');
  if (!isNonEmptyString(payload.hd) || !allowed.includes(payload.hd)) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.InvalidHostedDomain,
      'ID token hd does not match the allowed hosted domain',
    );
  }
}

/**
 * ステップ 6（任意）: `email_verified` が true であることを検証する。
 *
 * メールアドレスで OP のユーザーと対応付ける構成では、未検証のメールを持つ Google
 * アカウントが他人のアカウントへ結びつくのを防ぐために必須。
 *
 * @throws {GoogleLoginError} `email_not_verified`
 */
export function validateGoogleEmailVerified(payload: GoogleIdTokenPayload): void {
  if (payload.email_verified !== true) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.EmailNotVerified,
      'ID token email is not verified',
    );
  }
}

/**
 * ステップ 7（任意）: `nonce` が期待値と一致することを検証する。
 *
 * `expectedNonce` を渡さなければ何もしない。渡した場合、`nonce` が無いトークンは拒否する。
 *
 * @throws {GoogleLoginError} `invalid_nonce`
 */
export function validateGoogleIdTokenNonce(payload: GoogleIdTokenPayload, expectedNonce?: string): void {
  if (expectedNonce === undefined) return;
  if (!isNonEmptyString(payload.nonce) || payload.nonce !== expectedNonce) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.InvalidNonce,
      'ID token nonce does not match the expected value',
    );
  }
}

/**
 * Google の ID トークンを検証し、検証済みのヘッダーとペイロードを返す。
 *
 * 各ステップ関数を Google のドキュメントの順序（署名 → aud → iss → exp → hd）で合成した
 * 関数。生成コードはこの合成関数ではなく個々のステップ関数を順に呼び出すため、
 * 利用者は検証を削除したり独自処理を差し込んだりできる。
 *
 * @throws {GoogleLoginError} 検証失敗時
 */
export async function verifyGoogleIdToken(
  idToken: string,
  options: VerifyGoogleIdTokenOptions,
): Promise<VerifiedGoogleIdToken> {
  const decoded = decodeGoogleIdToken(idToken);

  const key = await resolveGoogleSigningKey(decoded.header, options.keyProvider);
  await verifyGoogleIdTokenSignature(decoded, key);

  validateGoogleIdTokenAudience(decoded.payload, options.clientId);
  validateGoogleIdTokenIssuer(decoded.payload);
  validateGoogleIdTokenExpiration(decoded.payload, options);
  validateGoogleHostedDomain(decoded.payload, options.hostedDomain);
  if (options.requireVerifiedEmail) {
    validateGoogleEmailVerified(decoded.payload);
  }
  validateGoogleIdTokenNonce(decoded.payload, options.expectedNonce);

  return { header: decoded.header, payload: decoded.payload };
}
