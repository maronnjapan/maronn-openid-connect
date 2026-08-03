/**
 * UserInfo Endpoint
 * OIDC Core 1.0 Section 5.3
 */

import { sign, arrayBufferToBase64Url, stringToArrayBuffer, getJwaAlgorithm } from './crypto-utils.js';
import { sanitizeErrorDescription } from './error-utils.js';

/**
 * UserInfoエンドポイントのエラーコード
 * OIDC Core 1.0 Section 5.3.3
 */
export enum UserInfoErrorCode {
  InvalidToken = 'invalid_token',
  InsufficientScope = 'insufficient_scope',
}

/**
 * UserInfoエンドポイントのエラー
 */
export class UserInfoError extends Error {
  public readonly error: UserInfoErrorCode;
  public readonly errorDescription: string;

  constructor(error: UserInfoErrorCode, errorDescription: string) {
    // RFC 6749 Section 5.2: error_description must be limited to a safe character set.
    // The value is also injected into the Bearer challenge header (RFC 6750 Section 3),
    // so disallowed characters (e.g. ", \) must be sanitized here.
    const sanitized = sanitizeErrorDescription(errorDescription);
    super(sanitized);
    this.name = 'UserInfoError';
    this.error = error;
    this.errorDescription = sanitized;
  }

  /**
   * HTTPステータスコード
   * invalid_token: 401, insufficient_scope: 403
   */
  get statusCode(): number {
    return this.error === UserInfoErrorCode.InvalidToken ? 401 : 403;
  }
}

/**
 * アクセストークン情報
 *
 * iat / audience / issuer / jti は RFC 7662 (Token Introspection) の active=true
 * レスポンスに含めるためのフィールド。すべて optional で、未設定の場合は
 * イントロスペクションレスポンスから当該クレームを省略する。
 */
export interface AccessTokenInfo {
  sub: string;
  scope: string[];
  clientId: string;
  expiresAt: number;
  /**
   * 認可付与の一意識別子（任意）。
   * 認可コード再利用検知時に同 grantId のトークンをまとめて失効するためのキー。
   * UserInfo 検証ロジック自体では参照しないが、ストア metadata に保存しておくと
   * 認可サーバ側からトークン失効に利用できる。
   */
  grantId?: string;
  /** 発行時刻（Unix epoch 秒）。RFC 7662 の iat に対応 */
  iat?: number;
  /**
   * RFC 7519 §4.1.5 / RFC 7662 §2.2: "not before"（Unix epoch 秒）。
   * この時刻より前のトークンは未だ有効ではない。JWT / Opaque を問わず保存しておくと、
   * イントロスペクションが nbf を検証（未来なら inactive）・エコーできる。
   */
  nbf?: number;
  /** OIDC アクセストークンの aud。RFC 7662 の aud に対応 */
  audience?: string[];
  /** 発行 OP の issuer URL。RFC 7662 の iss に対応 */
  issuer?: string;
  /** トークンの一意識別子。JWT の jti、Opaque は任意 */
  jti?: string;
  /**
   * Authorization Request の `claims` parameter（OIDC Core 1.0 §5.5）。
   * UserInfo route が `handleUserInfoRequest({ claimsParameter })` へ渡せるよう、
   * 認可コード発行時に解決した claims をアクセストークン metadata として保存する。
   * UserInfo 検証ロジック自体はこのフィールドを参照せず、生成コードが伝播に使う。
   */
  claims?: ClaimsParameter;
}

/**
 * アクセストークンを解決するインターフェース
 */
export interface AccessTokenResolver {
  findAccessToken(token: string): Promise<AccessTokenInfo | null>;
}

/**
 * アドレスクレーム
 * OIDC Core 1.0 Section 5.1.1
 */
export interface AddressClaim {
  formatted?: string;
  street_address?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
}

/**
 * ユーザークレーム
 * OIDC Core 1.0 Section 5.1
 */
export interface UserClaims {
  sub: string;
  // profile scope - OIDC Core 1.0 Section 5.4
  name?: string;
  family_name?: string;
  given_name?: string;
  middle_name?: string;
  nickname?: string;
  preferred_username?: string;
  profile?: string;
  picture?: string;
  website?: string;
  gender?: string;
  birthdate?: string;
  zoneinfo?: string;
  locale?: string;
  updated_at?: number;
  // email scope - OIDC Core 1.0 Section 5.4
  email?: string;
  email_verified?: boolean;
  // address scope - OIDC Core 1.0 Section 5.4
  address?: AddressClaim;
  // phone scope - OIDC Core 1.0 Section 5.4
  phone_number?: string;
  phone_number_verified?: boolean;
}

/**
 * ユーザークレームを解決するインターフェース
 */
export interface UserClaimsResolver {
  findUserClaims(sub: string): Promise<UserClaims | null>;
}

/**
 * 個別 claim 要求の値型。
 * OIDC Core 1.0 §5.5.1: each claim entry is either `null` (default request),
 * or an object with optional `essential`, `value`, `values`.
 */
export interface ClaimRequestEntry {
  essential?: boolean;
  value?: unknown;
  values?: unknown[];
  [key: string]: unknown;
}

export type ClaimRequestValue = ClaimRequestEntry | null;

/**
 * claimsリクエストパラメータ
 * OIDC Core 1.0 Section 5.5
 *
 * `userinfo` と `id_token` の両方のトップレベルメンバーをサポートする。
 */
export interface ClaimsParameter {
  userinfo?: Record<string, ClaimRequestValue>;
  id_token?: Record<string, ClaimRequestValue>;
}

/**
 * UserInfoリクエストのコンテキスト
 */
export interface UserInfoRequestContext {
  accessToken: string;
  accessTokenResolver: AccessTokenResolver;
  userClaimsResolver: UserClaimsResolver;
  claimsParameter?: ClaimsParameter;
  /**
   * UserInfo エンドポイント自身を指す audience 識別子（通常は UserInfo エンドポイント URL）。
   * RFC 9068 §4: アクセストークンの受領側は `aud` に自分を指す識別子が含まれることを検証する。
   * 指定時は JWT / opaque を問わず `tokenInfo.audience` に当該値が含まれることを検証し、
   * 含まれない場合・`tokenInfo.audience` が未設定の場合は `invalid_token`（401）で拒否する。
   * 生成された Provider は本値（UserInfo エンドポイント URL）を常に渡すため、audience 検証は
   * デフォルトで有効になる（opt-in ではない）。値未指定時のみ、比較対象が無いため検証をスキップする。
   *
   * 値は `buildAccessTokenAudience` の `userInfoEndpoint` と同一にすること
   * （不一致だと自前トークンを誤って弾く事故になる）。
   */
  expectedAudience?: string;
}

/**
 * UserInfoレスポンス
 */
export type UserInfoResponse = {
  sub: string;
} & Partial<Omit<UserClaims, 'sub'>>;

/**
 * スコープからクレーム名へのマッピング
 * OIDC Core 1.0 Section 5.4
 */
export const SCOPE_CLAIMS_MAP: Record<string, (keyof UserClaims)[]> = {
  profile: [
    'name',
    'family_name',
    'given_name',
    'middle_name',
    'nickname',
    'preferred_username',
    'profile',
    'picture',
    'website',
    'gender',
    'birthdate',
    'zoneinfo',
    'locale',
    'updated_at',
  ],
  email: ['email', 'email_verified'],
  address: ['address'],
  phone: ['phone_number', 'phone_number_verified'],
};

/**
 * スコープに基づいてクレームをフィルタリングする
 *
 * @param userClaims ユーザーの全クレーム
 * @param scopes 許可されたスコープ
 * @returns フィルタリングされたクレーム
 */
export function filterClaimsByScope(
  userClaims: UserClaims,
  scopes: string[]
): UserInfoResponse {
  const result: Record<string, unknown> = { sub: userClaims.sub };

  // 各スコープに対応するクレームを追加
  for (const scope of scopes) {
    const claimNames = SCOPE_CLAIMS_MAP[scope];
    if (!claimNames) continue;

    for (const claimName of claimNames) {
      const value = userClaims[claimName];
      if (value !== undefined && value !== null) {
        result[claimName] = value;
      }
    }
  }

  return result as UserInfoResponse;
}

/**
 * claimsパラメータで要求されたクレーム名を取得する
 */
function getRequestedClaimNames(
  claimsParameter?: ClaimsParameter
): (keyof UserClaims)[] {
  if (!claimsParameter?.userinfo) return [];
  return Object.keys(claimsParameter.userinfo) as (keyof UserClaims)[];
}

/**
 * JSON 値（プリミティブ / 配列 / プレーンオブジェクト）の深い等価比較。
 * OIDC Core 1.0 Section 5.5.1 の value / values は JSON 値であり、
 * `address` のようなオブジェクト型クレームは構造（メンバーの値）で一致判定する。
 *
 * - プリミティブ: `===`（ただし NaN は両辺 NaN なら一致とみなす）
 * - 配列: 要素数と各要素の深い等価
 * - オブジェクト: キー集合が一致し、各値が深い等価
 * - キーの順序は無視する
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // NaN === NaN は false になるため個別に扱う
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(bObj, key) &&
      deepEqual(aObj[key], bObj[key])
  );
}

/**
 * 個別 claim 要求の value / values 制約に実値が一致するか判定する
 * OIDC Core 1.0 Section 5.5.1 Individual Claims Requests
 *
 * - `null`（制約なし）: 常に一致
 * - `value`: 実値が指定値と深い等価のときだけ一致
 * - `values`: 実値が配列のいずれかと深い等価のときだけ一致
 * - `value` / `values` のどちらも無い（`essential` のみ等）: 値制約なしとして一致
 *
 * 等価判定は深い等価（`deepEqual`）。`address` のようなオブジェクト型クレームも
 * 構造（メンバーの値）で一致判定する。
 */
function matchesRequestedValue(
  actual: unknown,
  entry: ClaimRequestValue
): boolean {
  if (entry === null) return true; // 制約なし

  if (entry.value !== undefined) {
    return deepEqual(actual, entry.value);
  }

  if (Array.isArray(entry.values)) {
    return entry.values.some((candidate) => deepEqual(actual, candidate));
  }

  return true; // essential のみ等、値制約なし
}

/**
 * ステップ 1: 提示されたアクセストークンをストアから解決する
 *
 * OIDC Core 1.0 Section 5.3.1: UserInfo リクエストは Bearer アクセストークンを伴う。
 * トークン未提示・未知のトークンはいずれも invalid_token（401）で拒否する。
 *
 * @param accessToken リクエストから抽出したアクセストークン
 * @param accessTokenResolver アクセストークンを解決するリゾルバ
 * @returns 保存されているアクセストークン情報
 * @throws {UserInfoError} invalid_token
 */
export async function resolveUserInfoAccessToken(
  accessToken: string | undefined,
  accessTokenResolver: AccessTokenResolver
): Promise<AccessTokenInfo> {
  if (!accessToken) {
    throw new UserInfoError(
      UserInfoErrorCode.InvalidToken,
      'Access token is required'
    );
  }

  const tokenInfo = await accessTokenResolver.findAccessToken(accessToken);
  if (!tokenInfo) {
    throw new UserInfoError(
      UserInfoErrorCode.InvalidToken,
      'Access token is invalid'
    );
  }

  return tokenInfo;
}

/**
 * ステップ 2: アクセストークンの有効期限を検証する
 *
 * RFC 6750 Section 3.1: 期限切れトークンは invalid_token（401）。
 *
 * @param tokenInfo アクセストークン情報
 * @param now 現在時刻（Unix epoch 秒）。省略時はシステム時刻
 * @throws {UserInfoError} invalid_token
 */
export function validateUserInfoTokenExpiration(
  tokenInfo: AccessTokenInfo,
  now: number = Math.floor(Date.now() / 1000)
): void {
  if (tokenInfo.expiresAt < now) {
    throw new UserInfoError(
      UserInfoErrorCode.InvalidToken,
      'The access token expired'
    );
  }
}

/**
 * ステップ 3: openid スコープの存在を検証する
 *
 * OIDC Core 1.0 Section 5.3.1: UserInfo エンドポイントは openid スコープを
 * 持つアクセストークンでのみ利用できる。不足時は insufficient_scope（403）。
 *
 * @param tokenInfo アクセストークン情報
 * @throws {UserInfoError} insufficient_scope
 */
export function validateUserInfoScope(tokenInfo: AccessTokenInfo): void {
  if (!tokenInfo.scope.includes('openid')) {
    throw new UserInfoError(
      UserInfoErrorCode.InsufficientScope,
      'The openid scope is required'
    );
  }
}

/**
 * ステップ 4: アクセストークンの audience を検証する（RFC 9068 §4）
 *
 * expectedAudience が指定されていれば、UserInfo エンドポイント自身がトークンの aud に
 * 含まれることを検証する。これにより resource indicator (RFC 8707) で別リソース向けに
 * 発行されたトークンで UserInfo の PII を取得する confused deputy を防ぐ。生成された
 * Provider は JWT / opaque を問わず全アクセストークンに UserInfo エンドポイントを含む aud を
 * 保存するため、aud 未保存のトークンは当 OP が発行したものではない。よって opaque でも
 * 後方互換の緩和はせず、aud 未設定・不一致のいずれも invalid_token で拒否する。
 *
 * @param tokenInfo アクセストークン情報
 * @param expectedAudience UserInfo エンドポイント自身を指す audience 識別子。未指定なら検証しない
 * @throws {UserInfoError} invalid_token
 */
export function validateUserInfoAudience(
  tokenInfo: AccessTokenInfo,
  expectedAudience: string | undefined
): void {
  if (
    expectedAudience !== undefined &&
    (tokenInfo.audience === undefined || !tokenInfo.audience.includes(expectedAudience))
  ) {
    throw new UserInfoError(
      UserInfoErrorCode.InvalidToken,
      'The access token is not intended for the UserInfo endpoint'
    );
  }
}

/**
 * ステップ 5: アクセストークンの subject に対応するユーザークレームを解決する
 *
 * @param tokenInfo アクセストークン情報
 * @param userClaimsResolver ユーザークレームを解決するリゾルバ
 * @returns ユーザーの全クレーム（フィルタリング前）
 * @throws {UserInfoError} invalid_token
 */
export async function resolveUserInfoClaims(
  tokenInfo: AccessTokenInfo,
  userClaimsResolver: UserClaimsResolver
): Promise<UserClaims> {
  const userClaims = await userClaimsResolver.findUserClaims(tokenInfo.sub);
  if (!userClaims) {
    throw new UserInfoError(
      UserInfoErrorCode.InvalidToken,
      'User not found for the given access token'
    );
  }

  return userClaims;
}

/**
 * ステップ 7: claims リクエストパラメータで要求されたクレームを追加する
 * OIDC Core 1.0 Section 5.5 / 5.5.1
 *
 * スコープ由来のレスポンス（`filterClaimsByScope` の結果）へ、`claims.userinfo` で
 * 個別要求されたクレームを重ねる。value / values が指定された場合は実値が一致する
 * クレームだけを返し、一致しない場合は省略する（エラーにはしない）。
 * `sub` はアクセストークンの subject で確定済みのため上書きしない。
 *
 * 入力のレスポンスは変更せず、新しいオブジェクトを返す。
 *
 * @param response スコープでフィルタ済みの UserInfo レスポンス
 * @param userClaims ユーザーの全クレーム
 * @param claimsParameter Authorization Request の claims パラメータ
 * @returns 要求クレームを追加した UserInfo レスポンス
 */
export function applyRequestedClaims(
  response: UserInfoResponse,
  userClaims: UserClaims,
  claimsParameter?: ClaimsParameter
): UserInfoResponse {
  const result: Record<string, unknown> = { ...response };

  const requestedClaims = getRequestedClaimNames(claimsParameter);
  for (const claimName of requestedClaims) {
    if (claimName === 'sub') continue;
    const value = userClaims[claimName];
    if (value === undefined || value === null) continue;

    const entry = claimsParameter?.userinfo?.[claimName] ?? null;
    if (!matchesRequestedValue(value, entry)) continue;

    result[claimName] = value;
  }

  return result as UserInfoResponse;
}

/**
 * UserInfoリクエストを処理する
 *
 * 各ステップ関数を仕様順に合成した後方互換 API。CLI が生成する Provider は
 * この合成関数ではなく個々のステップ関数を順に呼び出すため、利用者は検証を
 * 削除したり独自処理を差し込んだりできる。
 *
 * 処理フロー:
 * 1. アクセストークンの解決（`resolveUserInfoAccessToken`）
 * 2. 有効期限の検証（`validateUserInfoTokenExpiration`）
 * 3. openid スコープの確認（`validateUserInfoScope`）
 * 4. audience の検証（`validateUserInfoAudience`）
 * 5. ユーザークレームの取得（`resolveUserInfoClaims`）
 * 6. スコープに基づくクレームフィルタリング（`filterClaimsByScope`）
 * 7. claims パラメータによる追加クレーム（`applyRequestedClaims`）
 *
 * @param context UserInfoリクエストのコンテキスト
 * @returns UserInfoレスポンス
 * @throws {UserInfoError} バリデーションエラー
 */
export async function handleUserInfoRequest(
  context: UserInfoRequestContext
): Promise<UserInfoResponse> {
  const {
    accessToken,
    accessTokenResolver,
    userClaimsResolver,
    claimsParameter,
    expectedAudience,
  } = context;

  const tokenInfo = await resolveUserInfoAccessToken(accessToken, accessTokenResolver);
  validateUserInfoTokenExpiration(tokenInfo);
  validateUserInfoScope(tokenInfo);
  validateUserInfoAudience(tokenInfo, expectedAudience);

  const userClaims = await resolveUserInfoClaims(tokenInfo, userClaimsResolver);
  const scopedResponse = filterClaimsByScope(userClaims, tokenInfo.scope);

  return applyRequestedClaims(scopedResponse, userClaims, claimsParameter);
}

/**
 * UserInfo を JWT 形式で発行するためのオプション
 * OIDC Core 1.0 Section 5.3.2
 */
export interface UserInfoJwtOptions {
  /** Issuer 識別子 */
  issuer: string;
  /** クライアント識別子（aud クレームに設定） */
  audience: string;
  /** 署名に使用する秘密鍵（CryptoKey） */
  privateKey: CryptoKey;
  /** JOSE ヘッダの kid */
  keyId?: string;
  /** 有効期間（秒）。デフォルト: 3600 */
  expiresIn?: number;
}

/** UserInfo JWT のデフォルト有効期間（秒） */
const DEFAULT_USERINFO_JWT_EXPIRES_IN = 3600;

/**
 * Base64URL エンコード
 */
function base64UrlEncode(str: string): string {
  return arrayBufferToBase64Url(stringToArrayBuffer(str));
}

/**
 * UserInfo レスポンスを署名済み JWT として生成する
 * OIDC Core 1.0 Section 5.3.2
 *
 * クライアントが署名付きレスポンスを要求するか（`userinfo_signed_response_alg`）の判定は
 * クライアントメタデータ層の責務であり、core はこの関数の呼び出し有無を選択するだけで良い。
 *
 * @param userInfoResponse handleUserInfoRequest() の戻り値
 * @param options JWT 生成オプション
 * @returns 署名済み JWT 文字列（content-type: application/jwt として返却する想定）
 */
export async function generateUserInfoJwt(
  userInfoResponse: UserInfoResponse,
  options: UserInfoJwtOptions,
): Promise<string> {
  const { issuer, audience, privateKey, keyId, expiresIn } = options;

  const now = Math.floor(Date.now() / 1000);
  const ttl = expiresIn ?? DEFAULT_USERINFO_JWT_EXPIRES_IN;

  const header: Record<string, string> = {
    alg: getJwaAlgorithm(privateKey),
    typ: 'JWT',
  };
  if (keyId) {
    header.kid = keyId;
  }

  const payload: Record<string, unknown> = {
    ...userInfoResponse,
    iss: issuer,
    aud: audience,
    iat: now,
    exp: now + ttl,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await sign(signingInput, privateKey);

  return `${signingInput}.${signature}`;
}
