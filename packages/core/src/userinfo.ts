/**
 * UserInfo Endpoint
 * OIDC Core 1.0 Section 5.3
 */

import { buildJoseHeader, signJwt } from './jwt.js';
import { getJwaAlgorithm } from './crypto-utils.js';
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
   * トークンを発行した認証が満たした acr（OIDC Core 1.0 §2 / RFC 9068 §2.2.1）。
   * ID Token の `acr` と同じ値。Opaque トークンはクレームを持たないため、ここに保存した値を
   * イントロスペクションが返す（RFC 9470 §6.2）。
   */
  acr?: string;
  /**
   * Authorization Request の `claims` parameter（OIDC Core 1.0 §5.5）。
   * UserInfo route が `applyRequestedClaims()` へ渡せるよう、
   * 認可コード発行時に解決した claims をアクセストークン metadata として保存する。
   * UserInfo 検証ロジック自体はこのフィールドを参照せず、生成コードが伝播に使う。
   */
  claims?: ClaimsParameter;
  /**
   * このアクセストークンを認可コードを経ずに発行した Auth Transaction の ID（任意）。
   * Implicit Flow（OIDC Core 1.0 §3.2）は認可エンドポイントでトークンを発行するため、
   * ストアがトークンと認可リクエストを結び付けて記録するのに使う。認可コードから
   * 発行したトークンは、コードの transactionId でたどれるので設定しない。
   */
  transactionId?: string;
}

/**
 * アクセストークンを解決するインターフェース
 */
export interface AccessTokenResolver {
  /**
   * アクセストークンの情報を返す（なければ `null`）。
   *
   * 提示されたアクセストークンの保存済みの情報（サブジェクト、スコープ、有効期限など）を返す。
   */
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
  /**
   * エンドユーザーのクレームを返す（なければ `null`）。
   *
   * `sub` で指定したサブジェクトのエンドユーザーのクレームを返す。
   * 返したオブジェクトのプロパティは、外部に開示されることがある。
   * UserInfo レスポンスと ID トークンでは、返されたプロパティを、スコープ（{@link filterClaimsByScope}）と `claims` パラメータの許可リスト（{@link DEFAULT_REQUESTABLE_CLAIMS}）で絞ってから開示する。
   * 既定の許可リストに載っているのは標準のクレームの名前だけなので、許可リストを広げる構成では、データベースの行や内部のユーザーのモデルをそのまま返さず、開示してよいクレームだけを持つオブジェクトに移してから返す。
   */
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
 * `claims` パラメータで要求できるクレーム名の既定アロウリスト。
 * `sub` と、スコープが対応付ける標準クレーム（{@link SCOPE_CLAIMS_MAP}）の全名前。
 *
 * OIDC Core 1.0 §5.5.1: 要求されたクレームを返せない場合でも OP はエラーを
 * 返してはならない（MUST NOT）。したがって未知のクレーム名を黙って返さないことは
 * 常に仕様適合である。§5.1 / §5.1.2 のとおり、クレーム名の語彙は OP が定義する。
 *
 * `claims` のキー名は RP が任意に指定できる。これを resolver が返したオブジェクトの
 * プロパティ名として無検査で読み出すと、利用者が `findUserClaims` から余剰フィールド
 * （DB の行など）を返した場合に、scope を迂回してそのフィールドが開示される。
 * 読み出せるキーを OP が宣言した語彙に限定するのがこのアロウリストの役割で、
 * {@link applyRequestedClaims} と `applyRequestedIdTokenClaims` の既定値になる。
 */
export const DEFAULT_REQUESTABLE_CLAIMS: ReadonlySet<string> = new Set([
  'sub',
  ...Object.values(SCOPE_CLAIMS_MAP).flat(),
]);

/**
 * スコープで許されたクレームだけを返す。
 *
 * `sub` は常に入れ、それ以外は `scopes` の各スコープに対応するクレーム（{@link SCOPE_CLAIMS_MAP}、OIDC Core 1.0 §5.4）のうち、値が `undefined` でも `null` でもないものだけを入れる。
 * 対応するクレームがないスコープ（`openid` など）は無視する。
 *
 * @spec OIDC Core 1.0 §5.4
 * @param userClaims ユーザーのすべてのクレーム
 * @param scopes 許可されたスコープ
 * @returns スコープで絞ったクレーム
 */
export function filterClaimsByScope(
  userClaims: UserClaims,
  scopes: string[]
): UserInfoResponse {
  const result: Record<string, unknown> = { sub: userClaims.sub };

  // スコープごとに、対応するクレームのうち値があるものを加える。
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
 * `claims.userinfo` で要求されたクレームの名前を返す。
 *
 * `claimsParameter` か `claims.userinfo` がなければ空の配列を返す。
 * キーの名前は RP が自由に指定できるので、戻り値は `keyof UserClaims` ではなく、ただの文字列の配列である。
 * 読み出してよい名前かどうかは、呼び出し側が許可リストで判定する（{@link applyRequestedClaims}）。
 */
function getRequestedClaimNames(claimsParameter?: ClaimsParameter): string[] {
  if (!claimsParameter?.userinfo) return [];
  return Object.keys(claimsParameter.userinfo);
}

/**
 * 二つの JSON の値が深く等しければ true を返す。
 *
 * `claims` パラメータの `value` と `values` は JSON の値であり（OIDC Core 1.0 §5.5.1）、`address` のようなオブジェクトのクレームは、メンバーの値で比べる必要がある。
 * 値の種類ごとの比べ方は次のとおりである:
 * - プリミティブは `===` で比べる（ただし、両方が `NaN` なら等しいとする）。
 * - 配列は、要素の数が同じで、各要素が深く等しければ等しいとする。
 * - オブジェクトは、キーの集合が同じで、各キーの値が深く等しければ等しいとする（キーの順序は問わない）。
 * - 配列とオブジェクトは、等しいとしない。
 *
 * @spec OIDC Core 1.0 §5.5.1
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // 数値どうしは、両方が `NaN` のときだけ等しいとする（`NaN === NaN` は false になるため）。
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
 * クレームの値が要求の条件に合えば true を返す。
 *
 * `entry` は、`claims` パラメータで個別に要求されたクレームの指定である（OIDC Core 1.0 §5.5.1）。
 * - `entry` が `null`（値の条件なし）なら true を返す。
 * - `value` があれば、`values` は見ずに、実際の値が `value` と深く等しいときだけ true を返す。
 * - `values` が配列なら、実際の値が `values` のどれかと深く等しいときだけ true を返す。
 * - どちらもないとき（`essential` だけのときなど）は、値の条件がないので true を返す。
 *
 * 等しいかどうかは `deepEqual()` で判定するので、`address` のようなオブジェクトのクレームも、メンバーの値で比べる。
 *
 * @spec OIDC Core 1.0 §5.5.1
 */
export function matchesRequestedClaimValue(
  actual: unknown,
  entry: ClaimRequestValue
): boolean {
  if (entry === null) return true; // 値の条件がないので、一致とする。

  if (entry.value !== undefined) {
    return deepEqual(actual, entry.value);
  }

  if (Array.isArray(entry.values)) {
    return entry.values.some((candidate) => deepEqual(actual, candidate));
  }

  return true; // `essential` だけのときなど、値の条件がないので一致とする。
}

/**
 * 提示されたアクセストークンの保存済みの情報を返す。
 *
 * UserInfo のリクエストには、`Bearer` のアクセストークンが付いている（OIDC Core 1.0 §5.3.1）。
 * トークンがないとき（空文字列を含む）と、`accessTokenResolver.findAccessToken()` がトークンを返さないときは、`UserInfoError`（`invalid_token`、ステータスコード 401）を投げる。
 * 有効期限、スコープ、オーディエンスは、ここでは確かめない。
 *
 * @spec OIDC Core 1.0 §5.3.1
 * @param accessToken リクエストから取り出したアクセストークン
 * @param accessTokenResolver アクセストークンの情報を取得するリゾルバ
 * @returns 保存されているアクセストークンの情報
 * @throws {UserInfoError} `invalid_token`: トークンがないとき、またはストアに見つからないとき
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
 * 有効期限に達したアクセストークンを拒否する。
 *
 * `expiresAt` が `now` 以下なら、`UserInfoError`（`invalid_token`、ステータスコード 401）を投げる。
 * `expiresAt` と `now` が等しいときも期限切れとして拒否する（RFC 7519 §4.1.4 の `exp` と同じ境界）。
 * イントロスペクション（{@link isIntrospectionTokenActive}）とリフレッシュトークンの判定も `expiresAt <= now` を期限切れとするので、同じトークンへの答えがそろう。
 * 期限切れのトークンには `invalid_token` で応答する（RFC 6750 §3.1）。
 *
 * @spec RFC 6750 §3.1
 * @param tokenInfo アクセストークンの情報
 * @param now 現在時刻のエポック秒（省略したときはシステムの時刻）
 * @throws {UserInfoError} `invalid_token`: 有効期限を過ぎているとき
 */
export function validateUserInfoTokenExpiration(
  tokenInfo: Pick<AccessTokenInfo, 'expiresAt'>,
  now: number = Math.floor(Date.now() / 1000)
): void {
  if (tokenInfo.expiresAt <= now) {
    throw new UserInfoError(
      UserInfoErrorCode.InvalidToken,
      'The access token expired'
    );
  }
}

/**
 * `openid` スコープのないアクセストークンを拒否する。
 *
 * トークンのスコープに `openid` がなければ、`UserInfoError`（`insufficient_scope`、ステータスコード 403）を投げる。
 * UserInfo エンドポイントは、`openid` スコープを持つアクセストークンでしか使えない（OIDC Core 1.0 §5.3.1）。
 *
 * @spec OIDC Core 1.0 §5.3.1
 * @param tokenInfo アクセストークンの情報
 * @throws {UserInfoError} `insufficient_scope`: スコープに `openid` がないとき
 */
export function validateUserInfoScope(tokenInfo: Pick<AccessTokenInfo, 'scope'>): void {
  if (!tokenInfo.scope.includes('openid')) {
    throw new UserInfoError(
      UserInfoErrorCode.InsufficientScope,
      'The openid scope is required'
    );
  }
}

/**
 * オーディエンスが合わないアクセストークンを拒否する。
 *
 * `expectedAudience`（UserInfo エンドポイント自身を示す値）を渡したときは、トークンの `audience`（`aud`）にその値がなければ `UserInfoError`（`invalid_token`）を投げる。
 * `audience` が保存されていないトークンも拒否する。
 * `expectedAudience` が `undefined` なら何も確かめない。
 *
 * この検証で、`resource` パラメータ（RFC 8707）で別のリソース向けに発行されたアクセストークンを使って、UserInfo から個人情報を取得する攻撃を防ぐ。
 * 生成された OP は、JWT か不透明な文字列かを問わず、すべてのアクセストークンに UserInfo エンドポイントを含む `aud` を保存するので、`aud` が保存されていないトークンはこの OP が発行したものではない。
 * そのため、不透明なトークンでも `aud` がなければ拒否する。
 *
 * @spec RFC 9068 §4
 * @param tokenInfo アクセストークンの情報
 * @param expectedAudience UserInfo エンドポイント自身を示すオーディエンスの値（`undefined` なら確かめない）。
 *   {@link buildAccessTokenAudience} の `userInfoEndpoint` と同じ値を渡す（違う値を渡すと、この OP が発行したトークンを拒否してしまう）。
 * @throws {UserInfoError} `invalid_token`: `aud` がないとき、または `aud` に `expectedAudience` が含まれないとき
 */
export function validateUserInfoAudience(
  tokenInfo: Pick<AccessTokenInfo, 'audience'>,
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
 * アクセストークンのサブジェクトのクレームを返す。
 *
 * `userClaimsResolver.findUserClaims()` にトークンの `sub` を渡し、返されたクレームをスコープで絞らずに返す。
 * ユーザーが見つからなければ、`UserInfoError`（`invalid_token`）を投げる。
 *
 * @param tokenInfo アクセストークンの情報
 * @param userClaimsResolver ユーザーのクレームを取得するリゾルバ
 * @returns ユーザーのすべてのクレーム（スコープで絞る前）
 * @throws {UserInfoError} `invalid_token`: トークンのサブジェクトのユーザーが見つからないとき
 */
export async function resolveUserInfoClaims(
  tokenInfo: Pick<AccessTokenInfo, 'sub'>,
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
 * 個別に要求されたクレームをレスポンスに加えて返す。
 *
 * スコープで絞ったレスポンス（{@link filterClaimsByScope} の結果）に、`claims` パラメータの `userinfo` メンバーで個別に要求されたクレームを重ねる（OIDC Core 1.0 §5.5）。
 * `value` か `values` が指定されたクレームは、実際の値が一致するときだけ加え、一致しなければエラーにせずに省く。
 * `sub` はアクセストークンのサブジェクトで決まっているので、上書きしない。
 *
 * 読み出すのは、許可リスト（`allowedClaimNames`、既定値は {@link DEFAULT_REQUESTABLE_CLAIMS}）にある名前のクレームだけである。
 * `claims` のキーの名前は RP が自由に指定できるので、確かめずに読むと、リゾルバが返した余分なフィールド（データベースの行など）が、スコープによる制限を通らずに開示されてしまう。
 * 許可リストにないクレームも、エラーにせずに省く（OIDC Core 1.0 §5.5.1 は、要求されたクレームを返せないときにエラーを返すことを禁じている）。
 * オブジェクト自身が持つプロパティだけを読み、プロトタイプチェーン上のプロパティ（ゲッターを持つクラスのインスタンスをリゾルバが返したときのゲッターなど）は読まない。
 *
 * 渡されたレスポンスは変更せず、新しいオブジェクトを返す。
 *
 * @spec OIDC Core 1.0 §5.5
 * @spec OIDC Core 1.0 §5.5.1
 * @param response スコープで絞った UserInfo レスポンス
 * @param userClaims ユーザーのすべてのクレーム
 * @param claimsParameter 認可リクエストの `claims` パラメータ
 * @param allowedClaimNames `claims` で要求されたときに読み出してよいクレームの名前（既定値は標準のクレームの名前）。
 *   ディスカバリーの `claims_supported` と同じ名前を公開する OP は、その一覧を渡す。
 * @returns 要求されたクレームを加えた UserInfo レスポンス
 */
export function applyRequestedClaims(
  response: UserInfoResponse,
  userClaims: UserClaims,
  claimsParameter?: ClaimsParameter,
  allowedClaimNames: ReadonlySet<string> = DEFAULT_REQUESTABLE_CLAIMS
): UserInfoResponse {
  const result: Record<string, unknown> = { ...response };

  const requestedClaims = getRequestedClaimNames(claimsParameter);
  for (const claimName of requestedClaims) {
    if (claimName === 'sub') continue;
    if (!allowedClaimNames.has(claimName)) continue;
    // エンドユーザーのクレームのオブジェクト自身が持つプロパティだけを読み、継承したプロパティ（`constructor`、`toString` など）は読まない。
    if (!Object.prototype.hasOwnProperty.call(userClaims, claimName)) continue;

    const value = (userClaims as unknown as Record<string, unknown>)[claimName];
    if (value === undefined || value === null) continue;

    const entry = claimsParameter?.userinfo?.[claimName] ?? null;
    if (!matchesRequestedClaimValue(value, entry)) continue;

    result[claimName] = value;
  }

  return result as UserInfoResponse;
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
 * UserInfo レスポンスに署名した JWT を返す。
 *
 * ペイロードは、`userInfoResponse` のクレームに、`iss`（`issuer`）、`aud`（`audience`）、`iat`（現在のエポック秒）、`exp`（`iat` に `expiresIn` を足した値、`expiresIn` の既定値は 3600 秒）を加えたものである。
 * レスポンスに同じ名前のクレームがあっても、これらの値で上書きする。
 * ヘッダーの `alg` は `privateKey` のアルゴリズムから決め、`typ` は `JWT` にし、`kid` は `keyId` が空でないときだけ付ける。
 * RSASSA-PKCS1-v1_5 と ECDSA 以外の鍵には `Error` を投げる。
 *
 * クライアントが署名したレスポンスを求めているか（`userinfo_signed_response_alg`）は、クライアントのメタデータを扱う側が判定する。
 * 呼び出し側は、署名したレスポンスが必要なときだけこの関数を呼べばよい。
 *
 * @spec OIDC Core 1.0 §5.3.2
 * @param userInfoResponse `applyRequestedClaims()` が返した UserInfo レスポンス
 * @param options 発行者、オーディエンス（クライアント ID）、署名に使う秘密鍵、鍵の ID、有効期間（秒）
 * @returns 署名した JWT の文字列（`Content-Type: application/jwt` で返すことを想定している）
 * @throws {Error} 秘密鍵のアルゴリズムが RSASSA-PKCS1-v1_5 でも ECDSA でもないとき
 */
export async function generateUserInfoJwt(
  userInfoResponse: UserInfoResponse,
  options: UserInfoJwtOptions,
): Promise<string> {
  const { issuer, audience, privateKey, keyId, expiresIn } = options;

  const now = Math.floor(Date.now() / 1000);
  const ttl = expiresIn ?? DEFAULT_USERINFO_JWT_EXPIRES_IN;

  const header = buildJoseHeader(getJwaAlgorithm(privateKey), 'JWT', keyId);

  const payload: Record<string, unknown> = {
    ...userInfoResponse,
    iss: issuer,
    aud: audience,
    iat: now,
    exp: now + ttl,
  };

  return signJwt(header, payload, privateKey);
}
