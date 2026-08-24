import { TokenError, TokenErrorCode } from './token-error.js';
import type { AuthenticationSessionResolver } from './authentication-session.js';
import type {
  RefreshTokenInfo,
  RefreshTokenResolver,
  TokenRequestContext,
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
  params: TokenRequestParams,
  refreshTokenResolver: RefreshTokenResolver | undefined,
): Promise<ResolvedRefreshToken> {
  const refreshToken = params.refresh_token;
  if (!refreshToken) {
    throw new TokenError(
      TokenErrorCode.InvalidRequest,
      'Missing required parameter: refresh_token'
    );
  }

  if (!refreshTokenResolver) {
    throw new TokenError(
      TokenErrorCode.InvalidRequest,
      'Refresh token resolver not provided'
    );
  }

  const refreshTokenInfo = await refreshTokenResolver.resolve(refreshToken);
  if (!refreshTokenInfo) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Refresh token not found'
    );
  }

  return { refreshToken, refreshTokenInfo };
}

/**
 * ローテーション済み refresh token の再利用を拒否する。
 *
 * OAuth 2.1 §4.3.1 / RFC 9700 §4.14: 再利用時は同じ grantId の token family を
 * 可能なら失効してから invalid_grant を返す。
 */
export async function validateRefreshTokenUnused(
  refreshTokenInfo: RefreshTokenInfo,
  refreshTokenResolver: RefreshTokenResolver,
): Promise<void> {
  if (!refreshTokenInfo.used) {
    return;
  }

  if (refreshTokenResolver.revokeTokensByGrantId) {
    await refreshTokenResolver.revokeTokensByGrantId(refreshTokenInfo.grantId);
  }
  throw new TokenError(
    TokenErrorCode.InvalidGrant,
    'Refresh token has already been used'
  );
}

/**
 * refresh token が認証済みクライアントへ発行されたものか検証する。
 */
export function validateRefreshTokenClient(
  refreshTokenInfo: RefreshTokenInfo,
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
  refreshTokenInfo: RefreshTokenInfo,
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
  refreshTokenInfo: RefreshTokenInfo,
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
  refreshTokenInfo: RefreshTokenInfo,
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

  const session = await sessionResolver.findSession(sessionId);
  if (!session) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'The authentication session bound to this refresh token has ended'
    );
  }

  if (session.subject !== refreshTokenInfo.subject) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'The authentication session bound to this refresh token belongs to another subject'
    );
  }
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

  const requestedScopes =
    requestedScope.split(' ').filter((scope) => scope.length > 0);
  if (requestedScopes.length === 0) {
    throw new TokenError(
      TokenErrorCode.InvalidScope,
      'Requested scope must not be empty'
    );
  }

  const uniqueRequestedScopes = [...new Set(requestedScopes)];
  const originalScopeSet = new Set(originalScope);
  const invalidScopes =
    uniqueRequestedScopes.filter((scope) => !originalScopeSet.has(scope));
  if (invalidScopes.length > 0) {
    throw new TokenError(
      TokenErrorCode.InvalidScope,
      `Requested scope exceeds original grant: ${invalidScopes.join(' ')}`
    );
  }

  return uniqueRequestedScopes;
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
 * refresh_token グラント固有の検証を行う合成関数。
 *
 * 後方互換の高水準 API として、機能単位のステップ関数を安全な順序で呼び出す。
 * CLI 生成コードはカスタマイズしやすいよう、下記ステップを直接呼び出す。
 *
 * 1. {@link resolveRefreshToken}
 * 2. {@link validateRefreshTokenUnused}
 * 3. {@link validateRefreshTokenClient}
 * 4. {@link validateRefreshTokenExpiration}
 * 5. {@link validateRefreshTokenIdleTimeout}
 * 6. {@link validateRefreshTokenSession}
 * 7. {@link validateRefreshTokenScope}
 * 8. {@link buildValidatedRefreshTokenRequest}
 *
 * grant_type の検証・クライアント認証・クライアント別 grant 認可を含む
 * フルの検証経路は {@link validateTokenRequest} が担う。この関数を直接使う場合、
 * それらの前段検証は呼び出し側の責務となる。
 *
 * @throws {TokenError} バリデーションエラー
 */
export async function validateRefreshTokenGrant(
  context: TokenRequestContext
): Promise<ValidatedRefreshTokenRequest> {
  const {
    params,
    authenticatedClientId,
    refreshTokenResolver,
    refreshTokenIdleTimeoutSeconds,
    authenticationSessionResolver,
  } = context;
  const { refreshTokenInfo } = await resolveRefreshToken(
    params,
    refreshTokenResolver,
  );

  // resolveRefreshToken guarantees this before returning.
  const resolver = refreshTokenResolver as RefreshTokenResolver;
  await validateRefreshTokenUnused(refreshTokenInfo, resolver);
  validateRefreshTokenClient(refreshTokenInfo, authenticatedClientId);
  validateRefreshTokenExpiration(refreshTokenInfo);
  validateRefreshTokenIdleTimeout(
    refreshTokenInfo,
    refreshTokenIdleTimeoutSeconds,
  );
  await validateRefreshTokenSession(
    refreshTokenInfo,
    authenticationSessionResolver,
  );
  const effectiveScope = validateRefreshTokenScope(
    params.scope,
    refreshTokenInfo.scope,
  );

  return buildValidatedRefreshTokenRequest(
    refreshTokenInfo,
    authenticatedClientId,
    effectiveScope,
  );
}
