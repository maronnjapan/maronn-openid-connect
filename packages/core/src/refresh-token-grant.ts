import { TokenError, TokenErrorCode } from './token-error.js';
import { parseScope } from './scope.js';
import type { AuthenticationSessionResolver } from './authentication-session.js';
import type {
  RefreshTokenInfo,
  RefreshTokenResolver,
  TokenRequestParams,
  ValidatedRefreshTokenRequest,
} from './token-request.js';

/**
 * {@link resolveRefreshToken} の戻り値。
 */
export interface ResolvedRefreshToken {
  refreshToken: string;
  refreshTokenInfo: RefreshTokenInfo;
}

/**
 * 必須の refresh_token パラメータを検証し、保存済みトークンを解決する。
 */
export async function resolveRefreshToken(
  params: Pick<TokenRequestParams, 'refresh_token'>,
  refreshTokenResolver: Pick<RefreshTokenResolver, 'resolve'> | undefined,
): Promise<ResolvedRefreshToken> {
  const refreshToken = requireRefreshToken(params.refresh_token);

  if (!refreshTokenResolver) {
    throw new TokenError(
      TokenErrorCode.InvalidRequest,
      'Refresh token resolver not provided'
    );
  }

  const refreshTokenInfo = requireStoredRefreshToken(
    await refreshTokenResolver.resolve(refreshToken),
  );

  return { refreshToken, refreshTokenInfo };
}

/**
 * ローテーション済み refresh token の再利用を拒否する。
 *
 * OAuth 2.1 §4.3.1 / RFC 9700 §4.14: 再利用時は同じ grantId の token family を
 * 可能なら失効してから invalid_grant を返す。
 */
export async function validateRefreshTokenUnused(
  refreshTokenInfo: Pick<RefreshTokenInfo, 'used' | 'grantId'>,
  refreshTokenResolver: Pick<RefreshTokenResolver, 'revokeTokensByGrantId'>,
): Promise<void> {
  const used = refreshTokenInfo.used;
  if (!used) {
    return;
  }

  if (refreshTokenResolver.revokeTokensByGrantId) {
    await refreshTokenResolver.revokeTokensByGrantId(refreshTokenInfo.grantId);
  }
  validateRefreshTokenNotUsed(used);
}

/**
 * refresh token が認証済みクライアントへ発行されたものか検証する。
 */
export function validateRefreshTokenClient(
  refreshTokenInfo: Pick<RefreshTokenInfo, 'clientId'>,
  authenticatedClientId: string,
): void {
  if (refreshTokenInfo.clientId !== authenticatedClientId) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Refresh token was issued to a different client'
    );
  }
}

/**
 * refresh token の絶対有効期限を検証する。
 *
 * RFC 7519 §4.1.4 の exp 慣例と同じく expiresAt <= currentTime を失効済みとする。
 */
export function validateRefreshTokenExpiration(
  refreshTokenInfo: Pick<RefreshTokenInfo, 'expiresAt'>,
  currentTime: number = Math.floor(Date.now() / 1000),
): void {
  if (refreshTokenInfo.expiresAt <= currentTime) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Refresh token has expired'
    );
  }
}

/**
 * refresh token の任意の idle（非活動）タイムアウトを検証する。
 *
 * timeout 未指定・0以下・lastUsedAt 未保存の場合は検証をスキップする。
 * `currentTime - lastUsedAt > timeout` のとき失効する（境界値と等しい場合は有効）。
 */
export function validateRefreshTokenIdleTimeout(
  refreshTokenInfo: Pick<RefreshTokenInfo, 'lastUsedAt'>,
  idleTimeoutSeconds: number | undefined,
  currentTime: number = Math.floor(Date.now() / 1000),
): void {
  if (
    idleTimeoutSeconds !== undefined &&
    idleTimeoutSeconds > 0 &&
    refreshTokenInfo.lastUsedAt !== undefined &&
    currentTime - refreshTokenInfo.lastUsedAt > idleTimeoutSeconds
  ) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Refresh token expired due to inactivity'
    );
  }
}

/**
 * online refresh token の束縛先セッションがまだ生きていることを検証する。
 *
 * OIDC Core 1.0 §11 は `offline_access` を「End-User が居ない（not logged in）ときにも
 * 使える Refresh Token」と定義し、Refresh Token の利用がその用途に限られないことも
 * 明示している（"The use of Refresh Tokens is not exclusive to the `offline_access`
 * use case. The Authorization Server MAY grant Refresh Tokens in other contexts"）。
 * 本実装ではその「other contexts」を online refresh token とし、`sessionId` で
 * 認証セッションへ束縛する。
 *
 * - `sessionId` 無し（offline refresh token）: 何も検証しない。セッションから独立している。
 * - `sessionId` あり（online refresh token）: セッションが解決できなければ
 *   `invalid_grant`。解決できても subject が変わっていれば `invalid_grant`。
 *
 * リゾルバー未指定で online refresh token が提示された場合は fail-closed で拒否する。
 * 「確認できないので通す」にすると、ログアウト後も使える RT が生まれてしまう。
 */
export async function validateRefreshTokenSession(
  refreshTokenInfo: Pick<RefreshTokenInfo, 'sessionId' | 'subject'>,
  sessionResolver: AuthenticationSessionResolver | undefined,
): Promise<void> {
  const { sessionId } = refreshTokenInfo;
  if (sessionId === undefined) {
    return;
  }

  if (!sessionResolver) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Authentication session resolver not provided'
    );
  }

  const session = requireRefreshTokenSession(
    await sessionResolver.findSession(sessionId),
  );
  validateRefreshTokenSessionSubject(session.subject, refreshTokenInfo.subject);
}

/**
 * refresh_token grant の要求 scope を検証・正規化する。
 *
 * 未指定なら元 grant の scope を返す。指定時は空値を拒否し、重複を除去したうえで
 * 元 scope のサブセットだけを許可する（RFC 6749 §6）。
 */
export function validateRefreshTokenScope(
  requestedScope: string | undefined,
  originalScope: string[],
): string[] {
  if (requestedScope === undefined) {
    return originalScope;
  }

  const requestedScopes = parseScope(requestedScope);
  validateRefreshTokenScopeNotEmpty(requestedScopes);
  validateRefreshTokenScopeWithinGrant(requestedScopes, originalScope);

  return requestedScopes;
}

/**
 * 各ステップの結果からバリデーション済み refresh_token request を組み立てる。
 */
export function buildValidatedRefreshTokenRequest(
  refreshTokenInfo: RefreshTokenInfo,
  authenticatedClientId: string,
  effectiveScope: string[],
): ValidatedRefreshTokenRequest {
  return {
    grantType: 'refresh_token',
    clientId: authenticatedClientId,
    subject: refreshTokenInfo.subject,
    scope: effectiveScope,
    grantId: refreshTokenInfo.grantId,
    audience: refreshTokenInfo.audience,
    authTime: refreshTokenInfo.authTime,
    nonce: refreshTokenInfo.nonce,
    acr: refreshTokenInfo.acr,
    amr: refreshTokenInfo.amr,
    azp: refreshTokenInfo.azp,
    // OAuth 2.1 §6.1: rotation を跨いで初回発行時刻を保持する。
    originalIssuedAt: refreshTokenInfo.originalIssuedAt,
    // RFC 6749 §6 / OIDC Core 1.0 §11: rotation 可否は縮小後ではなく元 grant で判定する。
    hadOfflineAccess: refreshTokenInfo.scope.includes('offline_access'),
    // online refresh token の束縛は rotation を跨いで維持する。ここで落とすと
    // 1 回リフレッシュしただけでセッション束縛が外れた offline RT に化ける。
    sessionId: refreshTokenInfo.sessionId,
  };
}

/**
 * Token Request の refresh_token パラメータがあることを確かめる。ストアを引く前に呼ぶ。
 */
export function requireRefreshToken(refreshToken: string | undefined): string {
  if (!refreshToken) {
    throw new TokenError(
      TokenErrorCode.InvalidRequest,
      'Missing required parameter: refresh_token'
    );
  }
  return refreshToken;
}

/**
 * ストアから読み取った refresh token があることを確かめる。見つからなければ invalid_grant。
 */
export function requireStoredRefreshToken<T>(refreshTokenInfo: T | null | undefined): T {
  if (!refreshTokenInfo) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Refresh token not found'
    );
  }
  return refreshTokenInfo;
}

/**
 * ローテーション済みの refresh token でないことを検証する。
 * 再利用時の token family の失効（RFC 9700 §4.14）は呼び出し側が先に済ませておく前提。
 */
export function validateRefreshTokenNotUsed(used: boolean | undefined): void {
  if (!used) return;
  throw new TokenError(
    TokenErrorCode.InvalidGrant,
    'Refresh token has already been used'
  );
}

/**
 * online refresh token の束縛先セッションが存続していることを確かめる。
 * セッションの読み取りは呼び出し側が行い、見つからなければ null を渡す。
 */
export function requireRefreshTokenSession<T>(session: T | null | undefined): T {
  if (!session) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'The authentication session bound to this refresh token has ended'
    );
  }
  return session;
}

/**
 * 束縛先セッションの subject が refresh token の subject と一致することを検証する。
 */
export function validateRefreshTokenSessionSubject(
  sessionSubject: string,
  refreshTokenSubject: string,
): void {
  if (sessionSubject !== refreshTokenSubject) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'The authentication session bound to this refresh token belongs to another subject'
    );
  }
}

/**
 * refresh_token grant で指定された scope が空でないことを検証する。
 */
export function validateRefreshTokenScopeNotEmpty(requestedScopes: readonly string[]): void {
  if (requestedScopes.length === 0) {
    throw new TokenError(
      TokenErrorCode.InvalidScope,
      'Requested scope must not be empty'
    );
  }
}

/**
 * RFC 6749 §6: 要求 scope が元の grant の scope に収まることを検証する。
 */
export function validateRefreshTokenScopeWithinGrant(
  requestedScopes: readonly string[],
  originalScope: readonly string[],
): void {
  const originalScopeSet = new Set(originalScope);
  const invalidScopes =
    requestedScopes.filter((scope) => !originalScopeSet.has(scope));
  if (invalidScopes.length > 0) {
    throw new TokenError(
      TokenErrorCode.InvalidScope,
      `Requested scope exceeds original grant: ${invalidScopes.join(' ')}`
    );
  }
}
