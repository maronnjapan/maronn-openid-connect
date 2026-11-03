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
 * 提示されたリフレッシュトークンの保存済みの情報を返す。
 *
 * 返す値は、`refresh_token` パラメータのトークンの文字列と、リゾルバの `resolve()` が返した保存済みの情報の組である。
 * 使用済みかどうか、有効期限、発行先のクライアントは、ここでは確かめない。
 *
 * @throws {TokenError} `invalid_request`: `refresh_token` パラメータがないか空のとき、またはリゾルバが渡されていないとき
 * @throws {TokenError} `invalid_grant`: ストアにトークンが見つからないとき
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
 * 使用済みなら、同じグラントを失効させて拒否する。
 *
 * 使用済み（`used` が `true`）のトークンは、ローテーションで後継のトークンに置き換えられた古いトークンである。
 * 古いトークンが再び提示されたときは、トークンが漏洩した可能性がある。
 * そこで、リゾルバに `revokeTokensByGrantId` があれば、グラント ID が同じアクセストークンとリフレッシュトークンをすべて失効させてから、`TokenError`（`invalid_grant`）を投げる（OAuth 2.1 §4.3.1、RFC 9700 §4.14）。
 * `revokeTokensByGrantId` がなければ、失効させずに投げる。
 * 未使用のトークンには何もしない。
 *
 * @spec OAuth 2.1 §4.3.1
 * @spec RFC 9700 §4.14
 * @throws {TokenError} `invalid_grant`: トークンが使用済みのとき
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
 * 別のクライアントに発行されたトークンなら拒否する。
 *
 * トークンの `clientId` が、認証したクライアントの ID（`authenticatedClientId`）と一致しなければ、`TokenError`（`invalid_grant`）を投げる。
 *
 * @throws {TokenError} `invalid_grant`: トークンが別のクライアントに発行されていたとき
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
 * 有効期限を過ぎたリフレッシュトークンを拒否する。
 *
 * `expiresAt` が `currentTime`（既定値は現在のエポック秒）以下なら、`TokenError`（`invalid_grant`）を投げる。
 * 有効期限と同じ時刻をすでに期限切れとみなすのは、JWT の `exp` と同じ扱いである（RFC 7519 §4.1.4）。
 * ここで確かめる `expiresAt` は、最初の発行から数える有効期限であり、ローテーションしても延びない。
 *
 * @throws {TokenError} `invalid_grant`: 有効期限を過ぎているとき
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
 * 使われない期間が上限を超えたトークンを拒否する。
 *
 * 上限（`idleTimeoutSeconds`）は、トークンが最後に使われてから（`lastUsedAt` から）次に使われるまでに空いてよい秒数で、有効期限とは別に設ける任意の制限である。
 * `currentTime - lastUsedAt` が `idleTimeoutSeconds` を超えたら、`TokenError`（`invalid_grant`）を投げる。
 * 経過した秒数がちょうど `idleTimeoutSeconds` のときは拒否しない。
 * `idleTimeoutSeconds` が `undefined` か 0 以下のとき、またはトークンに `lastUsedAt` が保存されていないときは、何も確かめない。
 *
 * @throws {TokenError} `invalid_grant`: 最後に使われてから `idleTimeoutSeconds` 秒を超えて経過しているとき
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
 * 結び付いたセッションが終了していれば拒否する。
 *
 * `sessionId` を持つリフレッシュトークン（以下、オンラインのリフレッシュトークン）は、OP の認証セッションに結び付いている。
 * `sessionId` を持たないリフレッシュトークン（オフラインのリフレッシュトークン）はセッションから独立しているので、何も確かめない。
 * オンラインのリフレッシュトークンには、次のときに `TokenError`（`invalid_grant`）を投げる:
 * - `sessionResolver` が渡されていない。
 * - `sessionResolver.findSession()` がセッションを返さない（セッションがないか、終了している）。
 * - セッションのサブジェクトが、トークンのサブジェクトと異なる。
 *
 * OIDC Core 1.0 §11 は、`offline_access` を、エンドユーザーがログインしていないときにも使えるリフレッシュトークンを求めるスコープとして定義している。
 * 同じ節は、リフレッシュトークンの用途は `offline_access` に限られず、認可サーバーはほかの場面でもリフレッシュトークンを発行してもよい（MAY）とも書いている。
 * この実装は、そのほかの場面で発行するリフレッシュトークンをオンラインのリフレッシュトークンとし、`sessionId` で認証セッションに結び付ける。
 *
 * リゾルバがないときに通さず拒否するのは、確かめられないトークンを通すと、ログアウトした後も使えるリフレッシュトークンが残るためである。
 *
 * @spec OIDC Core 1.0 §11
 * @throws {TokenError} `invalid_grant`: リゾルバがないとき、セッションが見つからないとき、セッションのサブジェクトが異なるとき
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
 * 発行するトークンのスコープを検証して返す。
 *
 * `requestedScope`（リクエストの `scope` パラメータ）がなければ、元のグラントのスコープ（`originalScope`）をそのまま返す。
 * あれば半角空白で分けて重複を取り除き、すべての値が元のグラントのスコープに含まれることを確かめてから返す（RFC 6749 §6）。
 * 値が一つもないとき（空文字列や空白だけのとき）と、元のグラントにない値を含むときは、`TokenError`（`invalid_scope`）を投げる。
 *
 * @spec RFC 6749 §6
 * @throws {TokenError} `invalid_scope`: 要求されたスコープが空のとき、または元のグラントにない値を含むとき
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
 * 検証済みのリフレッシュトークンのリクエストを返す。
 *
 * それまでのステップの結果から、`grantType` が `refresh_token` のリクエストを組み立てる。
 * クライアント ID には認証したクライアントの ID を、スコープには `effectiveScope`（{@link validateRefreshTokenScope} が返した値）を入れる。
 * サブジェクト、グラント ID、オーディエンス、認証時刻、`nonce`、`acr`、`amr`、`azp`、最初の発行時刻、セッションの ID は、保存済みのトークンの値をそのまま引き継ぐ。
 * `hadOfflineAccess` は、元のトークンのスコープ（縮小する前のスコープ）に `offline_access` があれば `true` にする。
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
    // ローテーションしても、最初の発行時刻を変えずに引き継ぐ（OAuth 2.1 §6.1）。
    // 有効期限を最初の発行から数えるためである。
    originalIssuedAt: refreshTokenInfo.originalIssuedAt,
    // ローテーションするかどうかは、縮小した後のスコープではなく、元のグラントのスコープで判定する（RFC 6749 §6、OIDC Core 1.0 §11）。
    // `offline_access` はグラントに与えた権限なので、リクエストでスコープを縮小しても元のグラントの権限は失われない。
    hadOfflineAccess: refreshTokenInfo.scope.includes('offline_access'),
    // セッションに結び付いた（オンラインの）リフレッシュトークンの `sessionId` は、ローテーションしても引き継ぐ。
    // ここで引き継がないと、1 回リフレッシュしただけで、セッションに結び付かないオフラインのリフレッシュトークンになってしまう。
    sessionId: refreshTokenInfo.sessionId,
  };
}

/**
 * `refresh_token` パラメータの値を確かめて返す。
 *
 * トークンリクエストの `refresh_token` パラメータがないか空文字列なら、`TokenError`（`invalid_request`）を投げる。
 * ストアからトークンを読む前に呼ぶ。
 *
 * @throws {TokenError} `invalid_request`: `refresh_token` パラメータがないか空のとき
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
 * 見つかったトークンの情報を返し、なければ拒否する。
 *
 * ストアから読んだリフレッシュトークンの情報を受け取り、`null` か `undefined`（見つからなかった）なら `TokenError`（`invalid_grant`）を投げる。
 * それ以外は、受け取った値をそのまま返す。
 *
 * @throws {TokenError} `invalid_grant`: トークンが見つからなかったとき
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
 * 使用済みのリフレッシュトークンなら拒否する。
 *
 * `used` が `true`（ローテーション済み）なら、`TokenError`（`invalid_grant`）を投げる。
 * 再利用されたときに同じグラントのトークンをすべて失効させる処理（RFC 9700 §4.14）は、呼び出し側が先に済ませておく。
 *
 * @throws {TokenError} `invalid_grant`: `used` が `true` のとき
 */
export function validateRefreshTokenNotUsed(used: boolean | undefined): void {
  if (!used) return;
  throw new TokenError(
    TokenErrorCode.InvalidGrant,
    'Refresh token has already been used'
  );
}

/**
 * 見つかったセッションを返し、なければ拒否する。
 *
 * `sessionId` を持つ（オンラインの）リフレッシュトークンが結び付いた認証セッションを、呼び出し側がストアから読んで渡す。
 * 渡された値が `null` か `undefined`（セッションがないか、終了している）なら、`TokenError`（`invalid_grant`）を投げる。
 * それ以外は、受け取ったセッションをそのまま返す。
 *
 * @throws {TokenError} `invalid_grant`: セッションが見つからなかったとき
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
 * セッションのサブジェクトがトークンと違えば拒否する。
 *
 * `sessionSubject`（認証セッションのサブジェクト）と `refreshTokenSubject`（リフレッシュトークンのサブジェクト）が異なれば、`TokenError`（`invalid_grant`）を投げる。
 *
 * @throws {TokenError} `invalid_grant`: サブジェクトが異なるとき
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
 * 要求されたスコープが空なら拒否する。
 *
 * `requestedScopes`（リフレッシュトークンのリクエストで指定されたスコープ）に値が一つもなければ、`TokenError`（`invalid_scope`）を投げる。
 *
 * @throws {TokenError} `invalid_scope`: `requestedScopes` が空の配列のとき
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
 * 元のグラントにないスコープが要求されたら拒否する。
 *
 * `requestedScopes` のうち `originalScope` に含まれない値があれば、それらの値をエラーの説明に並べて `TokenError`（`invalid_scope`）を投げる。
 * リフレッシュトークンで要求できるスコープは、元のグラントのスコープの範囲内に限られる（RFC 6749 §6）。
 *
 * @spec RFC 6749 §6
 * @throws {TokenError} `invalid_scope`: 元のグラントにない値を含むとき
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
