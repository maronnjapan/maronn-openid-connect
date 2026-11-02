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
 * `refresh_token` を検証し、検証済みリクエストを返す。
 *
 * `grant_type` が `refresh_token` でなければ何もせずに `undefined` を返し、検証は `route.ts` の `validateAuthorizationCodeGrant()` に任せる。
 * `refresh_token` がない、リフレッシュトークンが見つからない、ローテーションで使用済み、ほかのクライアントに発行された、期限切れ、結び付けたログインセッションがない、要求されたスコープが元のグラントを超えるときは、中で呼ぶ core の関数が `TokenError`（`invalid_grant` など）を投げる。
 * 使用済みのリフレッシュトークンが再び提示されたときは、同じグラントのトークンを失効させてから拒否する。
 *
 * 安全のための規則はそれぞれ core の別々の関数なので、一つずつ取り除いたり、差し替えたり、実験用の処理を前後に挟んだりできる。
 *
 * @spec OAuth 2.1 §4.3.1
 * @spec RFC 6749 §6
 */
export async function validateRefreshTokenGrant(
  params: TokenRequestParams,
  authenticatedClientId: string,
  grantType: string,
): Promise<ValidatedTokenRequest | undefined> {
  if (grantType !== 'refresh_token') return undefined;
  const { refreshTokenResolver, authenticationSessionResolver } = resolvers;

  // `refresh_token` パラメータがあることを確かめ、提示されたリフレッシュトークンのレコード（保存したグラントの情報）をストアから取得する。
  const { refreshTokenInfo } = await resolveRefreshToken(params, refreshTokenResolver);

  // ローテーションで使用済みのリフレッシュトークンなら、同じグラントのトークンを失効させてから拒否する（OAuth 2.1 §4.3.1）。
  await validateRefreshTokenUnused(refreshTokenInfo, refreshTokenResolver);

  // リフレッシュトークンが、認証したクライアントに発行されたものであることを確かめる。
  validateRefreshTokenClient(refreshTokenInfo, authenticatedClientId);

  // 最初の発行から数えた有効期限（`expiresAt`）が現在時刻以前なら、期限切れとして拒否する。
  validateRefreshTokenExpiration(refreshTokenInfo);

  // 一定の時間使われなかったリフレッシュトークンを失効させる確認は任意で、既定では行わない。
  // 有効にするときは `undefined` を秒数に置き換え、この制限を設けない実験ならこの呼び出しを消す。
  validateRefreshTokenIdleTimeout(refreshTokenInfo, undefined);

  // リフレッシュトークンを結び付けたログインセッションが、まだ続いていることを確かめる。
  // `sessionId` を持つリフレッシュトークン（オンラインのリフレッシュトークン）は、そのセッションが続いている間だけ使える。
  // ログアウトや、別のユーザーでの再ログインでセッションがなくなれば、`invalid_grant` になる。
  // `offline_access` を許可したリフレッシュトークンは `sessionId` を持たないので、この確認を通り、ログアウトした後も使い続けられる。
  await validateRefreshTokenSession(refreshTokenInfo, authenticationSessionResolver);

  // 要求されたスコープが、元のグラントのスコープに収まることを確かめる（RFC 6749 §6）。
  // `scope` が省略されたときは、元のグラントのスコープを使う。
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

/**
 * リフレッシュトークンを発行するかと、その種類を返す。
 *
 * 種類は、ログインセッションに結び付けるもの（オンライン）と、ログインセッションが終わっても使えるもの（`offline_access`）の二つである。
 * クライアントが `grant_types` に `refresh_token` を登録しているときに限り、次のどちらかが成り立てば発行する。
 * - グラントが `offline_access` を持つ。
 * - 設定の `onlineRefreshTokenEnabled` が true で、結び付けるセッションがある。
 *
 * @spec OIDC Core 1.0 §11
 * @spec RFC 9700 §4.14
 * @spec RFC 6749 §6
 */
export function decideRefreshTokenIssuance(
  tokenClient: TokenClientInfo,
  validatedRequest: ValidatedTokenRequest,
): RefreshTokenDecision {
  // クライアントが `grant_types` に `refresh_token` を登録しているかを確かめ、登録していなければリフレッシュトークンを発行しない。
  // `grant_types` の既定値は `["authorization_code"]` である（RFC 7591 §2、OpenID Connect Dynamic Client Registration 1.0 §2）。
  // 登録していないクライアントにリフレッシュトークンを渡しても、`grant_type=refresh_token` で使った時点で `validateClientGrantType()` が `unauthorized_client` で拒否する。
  // 一度も使えない長期の認証情報をクライアントに保存させるだけになるので、発行しない（RFC 9700 §4.14）。
  const clientAllowsRefreshGrant = clientAllowsRefreshTokenGrant(tokenClient);

  // グラントが `offline_access` を持つかを決める（RFC 6749 §6、OIDC Core 1.0 §11）。
  // リフレッシュでスコープを狭めたときは、このリクエストで発行するアクセストークンと ID トークンの権限を狭めるだけにし、リフレッシュトークンのローテーションを続けるかどうかとは切り離す。
  // ローテーションを続けるかは、元のグラントが `offline_access` を持っていたかで決める。
  // - `authorization_code` グラント: 今回許可したスコープに `offline_access` があるか。
  // - `refresh_token` グラント: 元のリフレッシュトークンのグラントが `offline_access` を持っていたか（`validatedRequest.hadOfflineAccess`）。
  //   狭めたスコープから `offline_access` を外しても、元のグラントの権限は失われないので、ローテーションを続ける。
  const grantHasOfflineAccess =
    clientAllowsRefreshGrant &&
    (validatedRequest.grantType === 'refresh_token'
      ? validatedRequest.hadOfflineAccess
      : validatedRequest.scope.includes('offline_access'));

  // オンラインのリフレッシュトークンを結び付けるセッションを決め、`offline_access` を持つグラントでは結び付けない。
  // OIDC Core 1.0 §11 は、`offline_access` を「エンドユーザーがログインしていないときにも使えるリフレッシュトークン」と定義したうえで、リフレッシュトークンの用途がそれに限られないことも明示している（「認可サーバーは、ほかの状況でもリフレッシュトークンを発行してよい（MAY）」）。
  // この OP は、その「ほかの状況」をオンラインのリフレッシュトークンとして実装し、ログインセッションに結び付ける。
  // - `authorization_code` グラント: 認可コードが持つ `sessionId`（ログインしたときに作ったもの）。
  // - `refresh_token` グラント: 元のリフレッシュトークンの結び付きをそのまま引き継ぎ、ローテーションで外れないようにする。
  const boundSessionId = grantHasOfflineAccess ? undefined : validatedRequest.sessionId;

  // 結び付けるセッションが分からなければ、オンラインのリフレッシュトークンは発行しない。
  // ブラウザのセッションを持たないグラント（デバイス認可グラント）がこれに当たる。
  // ログアウトしても使えなくならないリフレッシュトークンを渡さないよう、分からないときは発行しない側に倒す。
  const issueRefreshToken =
    clientAllowsRefreshGrant &&
    (grantHasOfflineAccess || (config.onlineRefreshTokenEnabled && boundSessionId !== undefined));

  return { grantHasOfflineAccess, boundSessionId, issueRefreshToken };
}

/**
 * リフレッシュトークンを発行し、保存して返す。
 *
 * 発行しないと決めたときは、何もせずに `undefined` を返す。
 * 発行するときは、ランダムな文字列のリフレッシュトークンを作り、ローテーションに使うレコードをストアに保存する。
 * `authTime` が `undefined` なら、`TokenError`（`invalid_grant`）を投げる。
 * 有効期限は、最初に発行した時刻に設定の `refreshTokenAbsoluteLifetime` を足した時刻で、ローテーションしても延びない。
 *
 * `grantId`、`audience`、`authTime`、`acr`、`amr`、`azp` は、ローテーションしても同じ値を引き継ぐ。
 * 引き継ぐので、認可コードが再利用されたときに後から発行したトークンもまとめて失効させられ、`aud` が広がることもなく、リフレッシュで発行し直す ID トークンは最初の認証のときの値を保つ（OIDC Core 1.0 §12.1）。
 * `nonce` は最初の発行のときだけ保存し、ローテーションでは引き継がない（リフレッシュでは `undefined` になる）。
 *
 * @spec OAuth 2.1 §4.3.1
 * @spec OAuth 2.1 §6.1
 * @spec OIDC Core 1.0 §12.1
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

  // `authTime` がなければ、リフレッシュトークンを発行せずに `invalid_grant` で拒否する。
  // ここでは `authTime` が決まっているはずである（`authorization_code` グラントでは認可コードの `authTime`、`refresh_token` グラントでは `validatedRequest.authTime`）。
  if (authTime === undefined) {
    throw new TokenError(TokenErrorCode.InvalidGrant, 'authTime is required to issue a refresh token');
  }
  // リフレッシュトークンの有効期限は、最初に発行した時刻から数えた絶対的な期間だけで決める（OAuth 2.1 §6.1）。
  // ローテーションしても最初の発行時刻（`originalIssuedAt`）を引き継ぎ、`expiresAt` をそこから数えた期限に固定する。
  // 使うたびに期限を延ばす方式はとらないので、リフレッシュを繰り返しても有効期限は先に延びず、漏れたリフレッシュトークンが長く使われることを防ぐ。
  // - `authorization_code` グラント: 今回が最初の発行なので、`originalIssuedAt` は `issuedAt` と同じ。
  // - `refresh_token` グラント: 元のリフレッシュトークンの `originalIssuedAt` をそのまま引き継ぐ。
  const originalIssuedAt =
    validatedRequest.grantType === 'refresh_token' ? validatedRequest.originalIssuedAt : issuedAt;
  // 保存するリフレッシュトークンのスコープには、グラントが `offline_access` を持つ限り `offline_access` を残す（RFC 6749 §6）。
  // 狭めたスコープ（`validatedRequest.scope`）から `offline_access` が外れても、次のローテーションを続けられるようにするためである。
  // アクセストークンには `validatedRequest.scope` をそのまま使うので、このリクエストで発行するトークンの権限は狭めたままになる。
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
    // リフレッシュで発行し直す ID トークンには、最初の認証のときの `acr` と `amr` を入れる（OIDC Core 1.0 §12.1）。
    // `refresh_token` グラントでは、`route.ts` の `resolveAcrAmr()` が保存済みの値を返している。
    acr,
    amr,
    azp: validatedRequest.grantType === 'refresh_token' ? validatedRequest.azp : undefined,
    // オンラインのリフレッシュトークンを結び付けるセッションを保存する。
    // `undefined` なら、セッションに結び付かないオフラインのリフレッシュトークンになり、ログアウトした後も使える。
    sessionId: decision.boundSessionId,
  });
  return refreshToken;
}

/**
 * 提示されたリフレッシュトークンを失効させる。
 *
 * `refresh_token` グラントで、リクエストに `refresh_token` があるときだけ失効させ、ほかのグラントでは何もしない。
 * 新しいリフレッシュトークンを発行したかどうかにかかわらず、提示されたものは失効させる。
 * ローテーションでは、新しいリフレッシュトークンを保存した後に、古いものを失効させる。
 * 順番を逆にすると、新しいトークンの保存に失敗したときに、エンドユーザーが使えるリフレッシュトークンがなくなるためである。
 *
 * @spec OAuth 2.1 §4.3.1
 */
export async function revokeRotatedRefreshToken(
  params: TokenRequestParams,
  validatedRequest: ValidatedTokenRequest,
): Promise<void> {
  if (validatedRequest.grantType === 'refresh_token' && params.refresh_token) {
    await resolvers.refreshTokenResolver.revokeRefreshToken(params.refresh_token);
  }
}
