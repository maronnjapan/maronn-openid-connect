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
import type { RefreshTokenInfo } from './token-request.js';
import { sanitizeErrorDescription } from './error-utils.js';

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

export interface IntrospectionRequestContext {
  params: { token?: string; token_type_hint?: string };
  /** クライアント認証済みのclientId。空文字なら invalid_client */
  authenticatedClientId: string;
  accessTokenResolver: IntrospectionAccessTokenResolver;
  refreshTokenResolver?: IntrospectionRefreshTokenResolver;
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
    };

/**
 * RFC 7662 §2.2: inactive なトークンのレスポンスは `{ active: false }` のみ。
 * トークンの存在有無を漏らさないため、他のクレームは一切含めない。
 */
export const INACTIVE_INTROSPECTION_RESPONSE: IntrospectionResponse = { active: false };

const INACTIVE = INACTIVE_INTROSPECTION_RESPONSE;

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

function isAccessTokenActive(info: AccessTokenInfo, now: number): boolean {
  if (info.expiresAt <= now) return false;
  // RFC 7519 §4.1.5 / RFC 7662 §2.2: a token whose nbf ("not before") is in the
  // future is not yet valid, so it MUST be reported inactive. Applies to both JWT
  // and opaque tokens because the stored token info drives introspection.
  if (info.nbf !== undefined && info.nbf > now) return false;
  return true;
}

function isRefreshTokenActive(info: RefreshTokenInfo, now: number): boolean {
  if (info.used) return false;
  if (info.expiresAt <= now) return false;
  return true;
}

function buildAccessTokenResponse(info: AccessTokenInfo): IntrospectionResponse {
  const res: Extract<IntrospectionResponse, { active: true }> = {
    active: true,
    scope: info.scope.join(' '),
    client_id: info.clientId,
    token_type: 'Bearer',
    sub: info.sub,
    exp: info.expiresAt,
  };
  if (info.iat !== undefined) res.iat = info.iat;
  // RFC 7662 §2.2: nbf is an OPTIONAL response member; echo it when stored.
  if (info.nbf !== undefined) res.nbf = info.nbf;
  if (info.audience !== undefined && info.audience.length > 0) {
    res.aud = info.audience;
  }
  if (info.issuer !== undefined) res.iss = info.issuer;
  if (info.jti !== undefined) res.jti = info.jti;
  return res;
}

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
 * ステップ 1: `token` パラメータの存在を検証する
 * RFC 7662 §2.1: token は REQUIRED。
 *
 * @param params イントロスペクションリクエストのパラメータ
 * @returns 検証済みの token 値
 * @throws {IntrospectionError} invalid_request
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
 * ステップ 2: 呼び出し元がクライアント認証済みであることを検証する
 * RFC 7662 §2.1: イントロスペクションエンドポイントはクライアント認証を要求する。
 *
 * @param authenticatedClientId クライアント認証済みの clientId。空文字なら未認証
 * @returns 認証済み clientId
 * @throws {IntrospectionError} invalid_client
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
 * ステップ 3: 提示されたトークンをストアから解決する
 *
 * RFC 7662 §2.1: `token_type_hint` は検索順のヒントであり、外れても他方の種別を
 * 検索しなければならない。hint=refresh_token のときだけ refresh → access の順、
 * それ以外（access_token / 不明値 / 未指定）は access → refresh の順で検索する。
 *
 * @returns 解決したトークン。どちらのストアにも無ければ null
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
 * ステップ 4: 解決したトークンが active かどうかを判定する
 *
 * RFC 7662 §2.2 の "active" は「まだ有効期限内で、失効・回収されていない」こと。
 * - アクセストークン: `exp` 超過、または `nbf` が未来なら inactive
 * - リフレッシュトークン: rotation 済み（`used`）または `exp` 超過なら inactive
 *
 * @param resolved 解決済みトークン
 * @param now 現在時刻（Unix epoch 秒）。省略時はシステム時刻
 */
export function isIntrospectionTokenActive(
  resolved: ResolvedIntrospectionToken,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  return resolved.tokenType === 'access_token'
    ? isAccessTokenActive(resolved.accessToken, now)
    : isRefreshTokenActive(resolved.refreshToken, now);
}

/**
 * ステップ 5: active なトークンの RFC 7662 §2.2 レスポンスクレームを組み立てる
 *
 * 保存されていない optional クレーム（iat / nbf / aud / iss / jti）は省略する。
 * inactive なトークンには使わず、`INACTIVE_INTROSPECTION_RESPONSE` を返すこと。
 */
export function buildIntrospectionResponse(
  resolved: ResolvedIntrospectionToken,
): IntrospectionResponse {
  return resolved.tokenType === 'access_token'
    ? buildAccessTokenResponse(resolved.accessToken)
    : buildRefreshTokenResponse(resolved.refreshToken);
}

/**
 * Token Introspection 本体。
 *
 * 各ステップ関数を仕様順に合成した後方互換 API。CLI が生成する Provider は
 * この合成関数ではなく個々のステップ関数を順に呼び出すため、利用者は検証を
 * 削除したり独自処理を差し込んだりできる。
 *
 * 1. token / authenticatedClientId のバリデーション
 *    （`requireIntrospectionToken` / `requireIntrospectionClient`）
 * 2. token_type_hint に応じて access → refresh または refresh → access の順で検索
 *    （`resolveIntrospectionToken`）
 * 3. 見つかれば exp / nbf / used をチェックして active 判定
 *    （`isIntrospectionTokenActive`）
 * 4. active なら推奨クレームを最大限詰めて返す（`buildIntrospectionResponse`）。
 *    inactive なら `{ active: false }` のみ。
 */
export async function handleIntrospectionRequest(
  ctx: IntrospectionRequestContext,
): Promise<IntrospectionResponse> {
  const { params, authenticatedClientId, accessTokenResolver, refreshTokenResolver } = ctx;

  const token = requireIntrospectionToken(params);
  requireIntrospectionClient(authenticatedClientId);

  const resolved = await resolveIntrospectionToken({
    token,
    tokenTypeHint: params.token_type_hint,
    accessTokenResolver,
    refreshTokenResolver,
  });

  if (resolved === null || !isIntrospectionTokenActive(resolved)) {
    return INACTIVE;
  }

  return buildIntrospectionResponse(resolved);
}
