/**
 * Token Revocation Endpoint (RFC 7009)
 *
 * クライアントが自発的にアクセストークン / リフレッシュトークンを失効させる
 * エンドポイント用の純関数。HTTP / クライアント認証の配線は呼び出し側の責務。
 *
 * セキュリティ方針:
 * - クライアント認証必須（authenticatedClientId が空なら invalid_client）
 * - **別クライアントが発行した token を指定したら invalid_grant エラー**
 *   （RFC 7009 §2.1: "verifies whether the token was issued to the client
 *    making the revocation request. If this validation fails, the request is
 *    refused and the client is informed of the error"）
 * - トークンが見つからない場合は 200 OK 成功（RFC 7009 §2.2）
 *
 * リフレッシュトークン関連トークンの扱い (RFC 7009 §2.1):
 *   refresh を revoke → 同 grantId のアクセストークンも全て revoke (SHOULD、片方向 cascade)
 *   access  を revoke → 関連 refresh は revoke しない (MAY、本実装では採用しない)
 */

import type { AccessTokenInfo } from './userinfo.js';
import type { RefreshTokenInfo } from './token-request.js';
import { sanitizeErrorDescription } from './error-utils.js';

export enum RevocationErrorCode {
  InvalidRequest = 'invalid_request',
  InvalidClient = 'invalid_client',
  /** RFC 7009 §2.2.1: トークンが requesting client 以外に発行されていた場合 */
  InvalidGrant = 'invalid_grant',
}

export class RevocationError extends Error {
  public readonly error: RevocationErrorCode;
  public readonly errorDescription: string;

  constructor(error: RevocationErrorCode, errorDescription: string) {
    // RFC 6749 Section 5.2: error_description must be limited to a safe character set.
    const sanitized = sanitizeErrorDescription(errorDescription);
    super(sanitized);
    this.name = 'RevocationError';
    this.error = error;
    this.errorDescription = sanitized;
  }

  get statusCode(): number {
    return this.error === RevocationErrorCode.InvalidClient ? 401 : 400;
  }
  // 400 InvalidRequest, 400 InvalidGrant, 401 InvalidClient

  get wwwAuthenticate(): string | undefined {
    if (this.error === RevocationErrorCode.InvalidClient) {
      return 'Basic realm="Client Authentication"';
    }
    return undefined;
  }
}

export interface RevocationTokenResolvers {
  findAccessToken(token: string): Promise<AccessTokenInfo | null>;
  revokeAccessToken(token: string): Promise<void>;
  findRefreshToken?(token: string): Promise<RefreshTokenInfo | null>;
  revokeRefreshToken?(token: string): Promise<void>;
  /**
   * RFC 7009 Section 2.1 SHOULD: refresh token 失効時に
   * 同 grantId のアクセストークンも全て失効する。
   */
  revokeAccessTokensByGrantId?(grantId: string): Promise<void>;
}

/**
 * ストアから解決した失効対象トークン。
 * どちらの種別として解決されたかで、失効方法と cascade の要否が変わる。
 */
export type ResolvedRevocationToken =
  | { tokenType: 'access_token'; accessToken: AccessTokenInfo }
  | { tokenType: 'refresh_token'; refreshToken: RefreshTokenInfo };

export interface ResolveRevocationTargetOptions {
  token: string;
  /** RFC 7009 §2.1: 検索順のヒント。'refresh_token' のときだけ refresh を先に引く */
  tokenTypeHint?: string;
  resolvers: RevocationTokenResolvers;
}

/**
 * `token` パラメータの値を確かめて返す。
 *
 * `token` パラメータがないか空文字列なら、`RevocationError`（`invalid_request`）を投げる。
 * `token` は必須のパラメータである（RFC 7009 §2.1）。
 *
 * @spec RFC 7009 §2.1
 * @throws {RevocationError} `invalid_request`: `token` パラメータがないか空のとき
 */
export function requireRevocationToken(params: { token?: string }): string {
  if (!params.token) {
    throw new RevocationError(
      RevocationErrorCode.InvalidRequest,
      'Missing required parameter: token',
    );
  }
  return params.token;
}

/**
 * 認証したクライアントの ID を確かめて返す。
 *
 * 呼び出し側は、クライアント認証で確かめた（または `client_id` で特定した）クライアントの ID を渡す。
 * `authenticatedClientId` が空文字列なら、`RevocationError`（`invalid_client`）を投げる。
 * 失効エンドポイントは、リクエストしたクライアントを特定しなければならない（RFC 7009 §2.1）。
 *
 * @spec RFC 7009 §2.1
 * @throws {RevocationError} `invalid_client`: `authenticatedClientId` が空のとき
 */
export function requireRevocationClient(authenticatedClientId: string): string {
  if (!authenticatedClientId) {
    throw new RevocationError(
      RevocationErrorCode.InvalidClient,
      'Client authentication required',
    );
  }
  return authenticatedClientId;
}

/**
 * 失効させるトークンをストアから探して返す。
 *
 * アクセストークンとリフレッシュトークンのストアを探し、見つかったトークンの種別と保存済みの情報を返す。
 * どちらにもなければ `null` を返し、呼び出し側は成功として応答する（RFC 7009 §2.2）。
 *
 * 探す順序は `token_type_hint` で決める。
 * `refresh_token` ならリフレッシュトークン、アクセストークンの順に、それ以外（`access_token`、未知の値、指定なし）ならアクセストークン、リフレッシュトークンの順に探す。
 * `token_type_hint` は探す順序のヒントにすぎず、外れても、もう一方の種別を探さなければならない（RFC 7009 §2.1）。
 *
 * リフレッシュトークンは、リゾルバに `findRefreshToken` と `revokeRefreshToken` の両方があるときだけ探す。
 * 失効させられない種別のトークンを見つけても、使い道がないためである。
 *
 * @spec RFC 7009 §2.1
 * @spec RFC 7009 §2.2
 * @returns 見つかったトークンの種別と情報（どちらのストアにもなければ `null`）
 */
export async function resolveRevocationTarget(
  options: ResolveRevocationTargetOptions,
): Promise<ResolvedRevocationToken | null> {
  const { token, tokenTypeHint, resolvers } = options;

  const findRefresh = resolvers.findRefreshToken;
  const canRevokeRefresh = findRefresh !== undefined && resolvers.revokeRefreshToken !== undefined;

  const resolveAccess = async (): Promise<ResolvedRevocationToken | null> => {
    const info = await resolvers.findAccessToken(token);
    return info ? { tokenType: 'access_token', accessToken: info } : null;
  };

  const resolveRefresh = async (): Promise<ResolvedRevocationToken | null> => {
    if (!canRevokeRefresh || !findRefresh) return null;
    const info = await findRefresh(token);
    return info ? { tokenType: 'refresh_token', refreshToken: info } : null;
  };

  if (tokenTypeHint === 'refresh_token') {
    return (await resolveRefresh()) ?? (await resolveAccess());
  }
  return (await resolveAccess()) ?? (await resolveRefresh());
}

/**
 * 別のクライアントに発行されたトークンなら拒否する。
 *
 * 見つかったトークンの `clientId` が `authenticatedClientId` と一致しなければ、`RevocationError`（`invalid_grant`）を投げる。
 * 認可サーバーは、トークンがリクエストしたクライアントに発行されたものかを確かめ、そうでなければリクエストを拒否して、クライアントにエラーを知らせる（RFC 7009 §2.1）。
 *
 * @spec RFC 7009 §2.1
 * @throws {RevocationError} `invalid_grant`: トークンが別のクライアントに発行されていたとき
 */
export function validateRevocationTokenClient(
  resolved: ResolvedRevocationToken,
  authenticatedClientId: string,
): void {
  const clientId =
    resolved.tokenType === 'access_token'
      ? resolved.accessToken.clientId
      : resolved.refreshToken.clientId;

  if (clientId !== authenticatedClientId) {
    throw new RevocationError(
      RevocationErrorCode.InvalidGrant,
      'Token was not issued to the requesting client',
    );
  }
}

/**
 * 提示されたトークンを失効させる。
 *
 * 見つかったのがアクセストークンなら `revokeAccessToken()` で、リフレッシュトークンなら `revokeRefreshToken()` で失効させる。
 * リゾルバに `revokeRefreshToken` がなければ何もしない（その場合、{@link resolveRevocationTarget} はリフレッシュトークンを返さない）。
 * 同じグラントのアクセストークンは、ここでは失効させない（{@link revokeGrantAccessTokens} が失効させる）。
 *
 * @param token リクエストで提示されたトークンの文字列
 * @param resolved {@link resolveRevocationTarget} が返したトークン
 * @param resolvers 失効に使うリゾルバ
 */
export async function revokeResolvedToken(
  token: string,
  resolved: ResolvedRevocationToken,
  resolvers: RevocationTokenResolvers,
): Promise<void> {
  if (resolved.tokenType === 'access_token') {
    await resolvers.revokeAccessToken(token);
    return;
  }
  await resolvers.revokeRefreshToken?.(token);
}

/**
 * 同じグラントのアクセストークンをすべて失効させる。
 *
 * `resolved` がリフレッシュトークンのときだけ、そのグラント ID を渡して `revokeAccessTokensByGrantId()` を呼ぶ。
 * アクセストークンのときと、リゾルバに `revokeAccessTokensByGrantId` がないときは何もしない。
 *
 * 認可サーバーは、リフレッシュトークンを失効させたら、同じグラントで発行したアクセストークンも失効させるべきである（SHOULD、RFC 7009 §2.1）。
 * 逆に、アクセストークンを失効させたときに関連するリフレッシュトークンも失効させてよい（MAY）が、この実装ではそうしない。
 *
 * @spec RFC 7009 §2.1
 */
export async function revokeGrantAccessTokens(
  resolved: ResolvedRevocationToken,
  resolvers: RevocationTokenResolvers,
): Promise<void> {
  if (resolved.tokenType !== 'refresh_token') return;
  await resolvers.revokeAccessTokensByGrantId?.(resolved.refreshToken.grantId);
}
