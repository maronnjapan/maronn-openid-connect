/**
 * The refresh_token grant of the token endpoint (OAuth 2.1 §4.3) and the
 * refresh tokens it issues: token/route.ts calls each function in a
 * (feature: refresh-token) block.
 */
import {
  buildValidatedRefreshTokenRequest,
  clientAllowsRefreshTokenGrant,
  generateRandomString,
  resolveRefreshToken,
  validateRefreshTokenClient,
  validateRefreshTokenExpiration,
  validateRefreshTokenIdleTimeout,
  validateRefreshTokenScope,
  validateRefreshTokenSession,
  validateRefreshTokenUnused,
  TokenError,
  TokenErrorCode,
  type TokenClientInfo,
  type TokenRequestParams,
  type ValidatedTokenRequest,
} from '@maronn-openid-connect/core';
import { config, resolvers, stores } from '../../provider';

/**
 * Validate the refresh_token grant (OAuth 2.1 §4.3.1 / RFC 6749 §6): the
 * validated request of a refresh, undefined for any other grant. Each security
 * rule is a separate core call so it can be removed, replaced, or surrounded
 * with experiment-specific logic.
 */
export async function validateRefreshTokenGrant(
  params: TokenRequestParams,
  authenticatedClientId: string,
  grantType: string,
): Promise<ValidatedTokenRequest | undefined> {
  if (grantType !== 'refresh_token') return undefined;
  const { refreshTokenResolver, authenticationSessionResolver } = resolvers;

  // Resolve the presented refresh token and retain its stored grant context.
  const { refreshTokenInfo } = await resolveRefreshToken(params, refreshTokenResolver);

  // OAuth 2.1 §4.3.1: reject rotation reuse and revoke the token family.
  await validateRefreshTokenUnused(refreshTokenInfo, refreshTokenResolver);

  // Bind the refresh token to the authenticated client.
  validateRefreshTokenClient(refreshTokenInfo, authenticatedClientId);

  // Absolute lifetime: expiresAt <= now is expired.
  validateRefreshTokenExpiration(refreshTokenInfo);

  // Optional inactivity policy. Replace undefined with your timeout in seconds
  // to enable it, or remove this step if your experiment has no idle lifetime.
  validateRefreshTokenIdleTimeout(refreshTokenInfo, undefined);

  // online refresh token（sessionId を持つ RT）は、束縛先のログインセッションが
  // 生きている間だけ使える。ログアウト・別ユーザーでの再ログインでセッションが
  // 消えれば invalid_grant になる。offline_access が付与された RT は sessionId を
  // 持たないため、このステップを素通りしてログアウト後も使い続けられる。
  await validateRefreshTokenSession(refreshTokenInfo, authenticationSessionResolver);

  // RFC 6749 §6: requested scope may only narrow the original grant.
  const effectiveScope = validateRefreshTokenScope(params.scope, refreshTokenInfo.scope);

  return buildValidatedRefreshTokenRequest(refreshTokenInfo, authenticatedClientId, effectiveScope);
}

/** Whether, and how, a refresh token is issued with this response. */
export interface RefreshTokenDecision {
  /** The grant holds offline_access: the refresh token outlives the login session. */
  grantHasOfflineAccess: boolean;
  /** The login session an online refresh token is bound to (undefined: not bound). */
  boundSessionId: string | undefined;
  /** Whether a refresh token is minted at all. */
  issueRefreshToken: boolean;
}

/** Decide whether a refresh token is issued (OIDC Core 1.0 §11 / RFC 9700 §4.14). */
export function decideRefreshTokenIssuance(
  tokenClient: TokenClientInfo,
  validatedRequest: ValidatedTokenRequest,
): RefreshTokenDecision {
  // RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2: grant_types の既定は
  // ["authorization_code"]。refresh_token を登録していないクライアントへ RT を渡しても、
  // 次に grant_type=refresh_token を出した瞬間 validateClientGrantType が
  // unauthorized_client で拒否する。一度も使えない長期資格情報を保存させるだけなので
  // （RFC 9700 §4.14）、登録が無ければ発行しない。
  const clientAllowsRefreshGrant = clientAllowsRefreshTokenGrant(tokenClient);

  // RFC 6749 §6 / OIDC Core 1.0 §11: refresh 時の scope 縮小は当該リクエストの access token /
  // ID Token の権限縮小として扱い、refresh token rotation の可否とは切り離す。rotation 可否は
  // 「元の grant が offline_access を持っていたか」で判断する。
  // - authorization_code grant: 今回付与された scope に offline_access があるか。
  // - refresh_token grant: 元 refresh token の grant が offline_access を持っていたか
  //   (validatedRequest.hadOfflineAccess)。縮小後 scope から offline_access を落としても
  //   元 grant の権限は失われないため rotation を継続する。
  const grantHasOfflineAccess =
    clientAllowsRefreshGrant &&
    (validatedRequest.grantType === 'refresh_token'
      ? validatedRequest.hadOfflineAccess
      : validatedRequest.scope.includes('offline_access'));

  // online refresh token の束縛先セッション。
  // OIDC Core 1.0 §11 は offline_access を「End-User が居ない（not logged in）ときにも
  // 使える Refresh Token」と定義したうえで、Refresh Token の利用がその用途に限られない
  // ことも明示している（"The Authorization Server MAY grant Refresh Tokens in other
  // contexts"）。この OP はその other contexts を online refresh token として実装し、
  // ログインセッションへ束縛する。offline_access がある grant は束縛しない。
  // - authorization_code grant: 認可コードが持つ sessionId（ログイン時に確立したもの）。
  // - refresh_token grant: 元 RT の束縛をそのまま引き継ぎ、rotation で外れないようにする。
  const boundSessionId = grantHasOfflineAccess ? undefined : validatedRequest.sessionId;

  // 束縛先が分からなければ online refresh token は発行しない。ブラウザセッションを
  // 持たない経路（device authorization grant）が該当する。ログアウトで止まる保証を
  // 付けられない RT を配らないための fail-closed。
  const issueRefreshToken =
    clientAllowsRefreshGrant &&
    (grantHasOfflineAccess || (config.onlineRefreshTokenEnabled && boundSessionId !== undefined));

  return { grantHasOfflineAccess, boundSessionId, issueRefreshToken };
}

/**
 * Mint the refresh token the decision asked for and store its record for
 * rotation (OAuth 2.1 §4.3.1). Returns undefined when none is issued.
 *
 * grantId / audience / authTime / nonce / acr / amr / azp propagate through
 * rotations, so descendants can be revoked on code reuse, the audience never
 * expands, and the ID Token a refresh re-issues keeps the values of the first
 * authentication (OIDC Core 1.0 §12.1).
 */
export async function issueRefreshToken(input: {
  decision: RefreshTokenDecision;
  subject: string;
  authTime: number | undefined;
  nonce: string | undefined;
  validatedRequest: ValidatedTokenRequest;
  issuedAt: number;
  audience: string[];
  acr: string | undefined;
  amr: string[] | undefined;
}): Promise<string | undefined> {
  const { decision, subject, authTime, nonce, validatedRequest, issuedAt, audience, acr, amr } = input;
  if (!decision.issueRefreshToken) return undefined;

  // authTime はここで必ず確定する: authorization_code 経由は authCode.authTime、
  // refresh_token 経由は validatedRequest.authTime。
  if (authTime === undefined) {
    throw new TokenError(TokenErrorCode.InvalidGrant, 'authTime is required to issue a refresh token');
  }
  // OAuth 2.1 §6.1: refresh token は initial issuance からの absolute lifetime のみで失効する。
  // rotation を跨いで originalIssuedAt を引き継ぎ、expiresAt はそこからの絶対的な期限で固定する。
  // sliding expiry は持たないため、リフレッシュを繰り返しても失効時刻は前に進まず、
  // 漏洩 RT の長期 abuse を防ぐ。
  const originalIssuedAt =
    validatedRequest.grantType === 'refresh_token' ? validatedRequest.originalIssuedAt : issuedAt;
  // RFC 6749 §6: 縮小後 scope（validatedRequest.scope）から offline_access が落ちても、
  // grant が offline_access を持つ限り次回以降の rotation を継続できるよう、永続化する
  // refresh token の scope には offline_access を保持する。access token は
  // validatedRequest.scope をそのまま使うため、当該リクエストの権限は縮小されたままになる。
  const refreshTokenScope =
    decision.grantHasOfflineAccess && !validatedRequest.scope.includes('offline_access')
      ? [...validatedRequest.scope, 'offline_access']
      : validatedRequest.scope;
  const refreshToken = generateRandomString(32);
  await stores.refreshTokenStore.set(refreshToken, {
    subject,
    clientId: validatedRequest.clientId,
    scope: refreshTokenScope,
    expiresAt: originalIssuedAt + config.refreshTokenAbsoluteLifetime,
    originalIssuedAt,
    used: false,
    grantId: validatedRequest.grantId,
    iat: issuedAt,
    issuer: config.issuer,
    audience,
    authTime,
    nonce,
    // OIDC Core 1.0 §12.1: refresh で再発行する ID Token は初回認証時の acr / amr を保持する。
    // refresh_token grant では、route.ts の resolveAcrAmr() が保存済みの値を返している。
    acr,
    amr,
    azp: validatedRequest.grantType === 'refresh_token' ? validatedRequest.azp : undefined,
    // online refresh token の束縛。undefined なら offline refresh token として
    // セッションから独立し、ログアウト後も使える。
    sessionId: decision.boundSessionId,
  });
  return refreshToken;
}

/**
 * OAuth 2.1 §4.3.1: ローテーションは新トークン保存成功後に旧 RT を失効する。
 * 失敗時にユーザーがリフレッシュ不能になることを防ぐため、必ずこの順序にする。
 */
export async function revokeRotatedRefreshToken(
  params: TokenRequestParams,
  validatedRequest: ValidatedTokenRequest,
): Promise<void> {
  if (validatedRequest.grantType === 'refresh_token' && params.refresh_token) {
    await resolvers.refreshTokenResolver.revokeRefreshToken(params.refresh_token);
  }
}
