/**
 * Token Introspection Endpoint (RFC 7662)
 *
 * リソースサーバ（protected resource）または confidential client が、
 * 受け取ったアクセストークン / リフレッシュトークンの有効性と属性を
 * クエリできる純関数を提供する。HTTP 配線は呼び出し側の責務。
 *
 * RFC 7662 §2.1: クライアント認証は必須だが、トークン所有クライアントと
 * caller の一致は要件ではない（protected resource が他クライアント発行の
 * トークンを introspect するのが本来のユースケース）。本実装も同様に
 * 所有チェックは行わず、authenticated confidential client であれば
 * いずれのトークンも introspect 可能。
 *
 * セキュリティ方針:
 * - クライアント認証必須（authenticatedClientId が空なら invalid_client）
 * - active=false のレスポンスは最小限（{ active: false } のみ）
 */

import type { AccessTokenInfo } from './userinfo.js';
import type { RefreshTokenInfo, TokenClientInfo } from './token-request.js';
import { sanitizeErrorDescription } from './error-utils.js';
import { isPublicTokenClient } from './client-auth.js';

/**
 * RFC 7662 で示唆されるエラー。実体は OAuth 2.0 Section 5.2 のエラー。
 */
export enum IntrospectionErrorCode {
  InvalidRequest = 'invalid_request',
  InvalidClient = 'invalid_client',
}

export class IntrospectionError extends Error {
  public readonly error: IntrospectionErrorCode;
  public readonly errorDescription: string;

  constructor(error: IntrospectionErrorCode, errorDescription: string) {
    // RFC 6749 Section 5.2: error_description must be limited to a safe character set.
    const sanitized = sanitizeErrorDescription(errorDescription);
    super(sanitized);
    this.name = 'IntrospectionError';
    this.error = error;
    this.errorDescription = sanitized;
  }

  get statusCode(): number {
    return this.error === IntrospectionErrorCode.InvalidClient ? 401 : 400;
  }

  get wwwAuthenticate(): string | undefined {
    if (this.error === IntrospectionErrorCode.InvalidClient) {
      return 'Basic realm="Client Authentication"';
    }
    return undefined;
  }
}

export interface IntrospectionAccessTokenResolver {
  findAccessToken(token: string): Promise<AccessTokenInfo | null>;
}

export interface IntrospectionRefreshTokenResolver {
  resolve(token: string): Promise<RefreshTokenInfo | null>;
}

/**
 * RFC 7662 Section 2.2 のレスポンス。
 * active=false のときは active のみ。active=true のときは推奨クレームを optional で含む。
 */
export type IntrospectionResponse =
  | { active: false }
  | {
      active: true;
      scope?: string;
      client_id?: string;
      token_type?: 'Bearer' | 'refresh_token';
      exp?: number;
      iat?: number;
      nbf?: number;
      sub?: string;
      aud?: string | string[];
      iss?: string;
      jti?: string;
      /** RFC 9470 §6.2: トークンを発行した認証が満たした acr（OIDC Core 1.0 §2） */
      acr?: string;
    };

/**
 * RFC 7662 §2.2: inactive なトークンのレスポンスは `{ active: false }` のみ。
 * トークンの存在有無を漏らさないため、他のクレームは一切含めない。
 */
export const INACTIVE_INTROSPECTION_RESPONSE: IntrospectionResponse = { active: false };

/**
 * ストアから解決したイントロスペクション対象トークン。
 * どちらの種別として解決されたかで、活性判定とレスポンスクレームが変わる。
 */
export type ResolvedIntrospectionToken =
  | { tokenType: 'access_token'; accessToken: AccessTokenInfo }
  | { tokenType: 'refresh_token'; refreshToken: RefreshTokenInfo };

export interface ResolveIntrospectionTokenOptions {
  token: string;
  /** RFC 7662 §2.1: 検索順のヒント。'refresh_token' のときだけ refresh を先に引く */
  tokenTypeHint?: string;
  accessTokenResolver: IntrospectionAccessTokenResolver;
  refreshTokenResolver?: IntrospectionRefreshTokenResolver;
}

/**
 * 有効期限内で、`nbf` が未来でなければ true を返す。
 *
 * アクセストークンの `expiresAt` が `now` 以前なら false を返す。
 * `notBefore`（`nbf`）が `now` より後なら、まだ使えないトークンなので false を返す。
 * 時刻はすべて UNIX 時間の秒である。
 *
 * @spec RFC 7662 §2.2
 */
export function isAccessTokenActive(
  expiresAt: number,
  notBefore: number | undefined,
  now: number,
): boolean {
  if (expiresAt <= now) return false;
  // `nbf`（使用を始めてよい時刻）が未来なら false を返す（RFC 7519 §4.1.5、RFC 7662 §2.2）。
  // まだ有効になっていないトークンは、無効として報告しなければならない（MUST）。
  // イントロスペクションは保存されたトークンの情報で判定するので、JWT のトークンにも JWT でないトークンにも同じ規則を当てはめる。
  if (notBefore !== undefined && notBefore > now) return false;
  return true;
}

/**
 * リフレッシュトークンが未使用で期限内なら true を返す。
 *
 * `used` が true（ローテーションで使用済み）なら false を返し、`expiresAt` が `now` 以前でも false を返す。
 * 時刻はすべて UNIX 時間の秒である。
 *
 * @spec RFC 7662 §2.2
 */
export function isRefreshTokenActive(
  expiresAt: number,
  used: boolean | undefined,
  now: number,
): boolean {
  if (used) return false;
  if (expiresAt <= now) return false;
  return true;
}

/**
 * 有効なアクセストークンのレスポンスを返す。
 *
 * 保存済みのアクセストークンの情報から、`active: true` のイントロスペクションのレスポンスを組み立てる。
 * `token_type` は `Bearer` にし、`scope` は空白区切りの文字列にする。
 * `client_id`、`sub`、`exp` は常に含め、`iat`、`nbf`、`iss`、`jti`、`acr` は保存されているときだけ、`aud` は `audience` が空でないときだけ含める。
 * `scope` は、スコープが一つもないトークン（スコープを登録していないクライアントの `client_credentials` グラントのトークン）では含めない。
 * 有効期限や `nbf` は確かめず、常に `active: true` を返す。
 *
 * @spec RFC 7662 §2.2
 * @spec RFC 9470 §6.2
 */
function buildAccessTokenResponse(info: AccessTokenInfo): IntrospectionResponse {
  const res: Extract<IntrospectionResponse, { active: true }> = {
    active: true,
    // `scope` は任意のメンバーで、値は一つ以上のスコープを空白で区切った文字列なので、スコープがなければ省く（RFC 7662 §2.2、RFC 6749 §3.3）。
    ...(info.scope.length > 0 ? { scope: info.scope.join(' ') } : {}),
    client_id: info.clientId,
    token_type: 'Bearer',
    sub: info.sub,
    exp: info.expiresAt,
  };
  if (info.iat !== undefined) res.iat = info.iat;
  // `nbf` はレスポンスの任意のメンバーなので、保存されているときだけ含める（RFC 7662 §2.2）。
  if (info.nbf !== undefined) res.nbf = info.nbf;
  if (info.audience !== undefined && info.audience.length > 0) {
    res.aud = info.audience;
  }
  if (info.issuer !== undefined) res.iss = info.issuer;
  if (info.jti !== undefined) res.jti = info.jti;
  // `acr` はイントロスペクションのレスポンスのメンバーなので、保存されていれば含める（RFC 9470 §6.2）。
  // リソースサーバーは、トークンが自己完結型でなくても、エンドユーザーがどう認証されたかを確かめられる。
  if (info.acr !== undefined) res.acr = info.acr;
  return res;
}

/**
 * 有効なリフレッシュトークンのレスポンスを返す。
 *
 * 保存済みのリフレッシュトークンの情報から、`active: true` のイントロスペクションのレスポンスを組み立てる。
 * `token_type` は `refresh_token` にし、`scope` は空白区切りの文字列にする。
 * `client_id`、`sub`（`subject` の値）、`exp` は常に含め、`iat`、`iss` は保存されているときだけ含める。
 * `aud`、`nbf`、`jti`、`acr` は含めない。
 * ローテーションで使用済みか、期限切れかは確かめず、常に `active: true` を返す。
 *
 * @spec RFC 7662 §2.2
 */
function buildRefreshTokenResponse(info: RefreshTokenInfo): IntrospectionResponse {
  const res: Extract<IntrospectionResponse, { active: true }> = {
    active: true,
    scope: info.scope.join(' '),
    client_id: info.clientId,
    token_type: 'refresh_token',
    sub: info.subject,
    exp: info.expiresAt,
  };
  if (info.iat !== undefined) res.iat = info.iat;
  if (info.issuer !== undefined) res.iss = info.issuer;
  return res;
}

/**
 * `token` パラメータがあればその値を返す。
 *
 * `token` は、イントロスペクションのリクエストで必須のパラメータである（RFC 7662 §2.1）。
 *
 * @spec RFC 7662 §2.1
 * @param params イントロスペクションのリクエストのパラメータ
 * @returns `token` の値
 * @throws {IntrospectionError} `invalid_request`: `token` がないか空文字列のとき
 */
export function requireIntrospectionToken(params: { token?: string }): string {
  if (!params.token) {
    throw new IntrospectionError(
      IntrospectionErrorCode.InvalidRequest,
      'Missing required parameter: token',
    );
  }
  return params.token;
}

/**
 * 認証済みのクライアント ID があればそのまま返す。
 *
 * イントロスペクションエンドポイントは、呼び出し元のクライアント認証を求める（RFC 7662 §2.1）。
 *
 * @spec RFC 7662 §2.1
 * @param authenticatedClientId クライアント認証で確かめたクライアント ID（空文字列なら認証されていない）
 * @returns 認証済みのクライアント ID
 * @throws {IntrospectionError} `invalid_client`: `authenticatedClientId` が空文字列のとき
 */
export function requireIntrospectionClient(authenticatedClientId: string): string {
  if (!authenticatedClientId) {
    throw new IntrospectionError(
      IntrospectionErrorCode.InvalidClient,
      'Client authentication required',
    );
  }
  return authenticatedClientId;
}

/**
 * 呼び出し元がパブリッククライアントなら拒否する。
 *
 * イントロスペクションでは、トークンの走査（有効なトークンを探して手当たり次第に問い合わせること）を防ぐため、呼び出し元の認可が必要である（RFC 7662 §2.1）。
 * 認証されていないイントロスペクションのリクエストは、拒否しなければならない（RFC 9701 §5 の MUST）。
 * `tokenEndpointAuthMethods: ['none']` で登録されたパブリッククライアントは、公開情報である `client_id` を示すだけでクライアント認証の処理を通るので、それを認証済みとして扱うと、誰でもトークンを走査できてしまう。
 * そのため、登録した方式が `none` の呼び出し元を `invalid_client` で拒否する。
 *
 * トークンの失効のエンドポイントには使わない（RFC 7009 §2.1 は、パブリッククライアントによる失効のリクエストを正当なものとして認めている）。
 *
 * @spec RFC 7662 §2.1
 * @spec RFC 9701 §5
 * @param client クライアント認証の処理が特定した登録済みのクライアント
 * @throws {IntrospectionError} `invalid_client`: 登録した方式が `none` のとき（ステータスコードは 401 で、`WWW-Authenticate` ヘッダーを付ける）
 * @throws {Error} 登録で `none` をほかの方式と並べているとき（{@link isPublicTokenClient}）
 */
export function requireConfidentialIntrospectionCaller(
  client: Pick<TokenClientInfo, 'tokenEndpointAuthMethods'>,
): void {
  // 登録した方式が `none` なら `invalid_client` を投げる。
  // 方式が登録されていなければ、既定の `client_secret_basic`（コンフィデンシャルクライアント）として扱う（OIDC Core 1.0 §9、RFC 7591 §2）。
  if (isPublicTokenClient(client)) {
    throw new IntrospectionError(
      IntrospectionErrorCode.InvalidClient,
      'Introspection requires an authenticated confidential client',
    );
  }
}

/**
 * 提示されたトークンをストアから探し、種別と情報を返す。
 *
 * `token_type_hint` は探す順のヒントで、外れてもほかの種別を探さなければならない（RFC 7662 §2.1）。
 * `token_type_hint` が `refresh_token` のときだけリフレッシュトークン、アクセストークンの順に探し、それ以外（`access_token`、未知の値、未指定）はアクセストークン、リフレッシュトークンの順に探す。
 * `refreshTokenResolver` を渡さなければ、アクセストークンだけを探す。
 *
 * @spec RFC 7662 §2.1
 * @returns 見つけたトークンの種別と情報。どちらのストアにもなければ `null`
 */
export async function resolveIntrospectionToken(
  options: ResolveIntrospectionTokenOptions,
): Promise<ResolvedIntrospectionToken | null> {
  const { token, tokenTypeHint, accessTokenResolver, refreshTokenResolver } = options;
  const refreshFirst = tokenTypeHint === 'refresh_token';

  if (refreshFirst && refreshTokenResolver) {
    const rt = await refreshTokenResolver.resolve(token);
    if (rt) return { tokenType: 'refresh_token', refreshToken: rt };
    const at = await accessTokenResolver.findAccessToken(token);
    if (at) return { tokenType: 'access_token', accessToken: at };
    return null;
  }

  const at = await accessTokenResolver.findAccessToken(token);
  if (at) return { tokenType: 'access_token', accessToken: at };
  if (refreshTokenResolver) {
    const rt = await refreshTokenResolver.resolve(token);
    if (rt) return { tokenType: 'refresh_token', refreshToken: rt };
  }
  return null;
}

/**
 * 見つけたトークンが有効なら true を返す。
 *
 * RFC 7662 §2.2 の `active` は、トークンがまだ有効期限内で、失効していないことを表す。
 * - アクセストークンは、`exp` を過ぎているか、`nbf` が未来なら false を返す（{@link isAccessTokenActive}）
 * - リフレッシュトークンは、ローテーションで使用済み（`used`）か、`exp` を過ぎていれば false を返す（{@link isRefreshTokenActive}）
 *
 * @spec RFC 7662 §2.2
 * @param resolved {@link resolveIntrospectionToken} が返したトークン
 * @param now 現在時刻（UNIX 時間の秒）。省略するとシステムの時刻を使う
 */
export function isIntrospectionTokenActive(
  resolved: ResolvedIntrospectionToken,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  return resolved.tokenType === 'access_token'
    ? isAccessTokenActive(resolved.accessToken.expiresAt, resolved.accessToken.nbf, now)
    : isRefreshTokenActive(resolved.refreshToken.expiresAt, resolved.refreshToken.used, now);
}

/**
 * 有効なトークンのレスポンスを組み立てて返す。
 *
 * トークンの種別に合わせて、RFC 7662 §2.2 のレスポンスのクレームを組み立てる。
 * 任意のクレーム（`iat`、`nbf`、`aud`、`iss`、`jti`）と、アクセストークンの `acr`（RFC 9470 §6.2）は、保存されていなければ省く。
 * 常に `active: true` を返すので、無効なトークンにはこの関数を使わず、{@link INACTIVE_INTROSPECTION_RESPONSE} を返す。
 *
 * @spec RFC 7662 §2.2
 */
export function buildIntrospectionResponse(
  resolved: ResolvedIntrospectionToken,
): IntrospectionResponse {
  return resolved.tokenType === 'access_token'
    ? buildAccessTokenResponse(resolved.accessToken)
    : buildRefreshTokenResponse(resolved.refreshToken);
}
