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

export interface RevocationRequestContext {
  params: { token?: string; token_type_hint?: string };
  authenticatedClientId: string;
  resolvers: RevocationTokenResolvers;
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
 * ステップ 1: `token` パラメータの存在を検証する
 * RFC 7009 §2.1: token は REQUIRED。
 *
 * @throws {RevocationError} invalid_request
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
 * ステップ 2: 呼び出し元がクライアント認証済み（または client_id 識別済み）であることを検証する
 * RFC 7009 §2.1: revocation エンドポイントはクライアントを識別しなければならない。
 *
 * @throws {RevocationError} invalid_client
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
 * ステップ 3: 失効対象のトークンをストアから解決する
 *
 * RFC 7009 §2.1: `token_type_hint` は検索順のヒントであり、外れても他方の種別を
 * 検索しなければならない。hint=refresh_token のときだけ refresh → access の順、
 * それ以外（access_token / 不明値 / 未指定）は access → refresh の順で検索する。
 *
 * refresh token は検索と失効の両方の resolver が揃っている場合だけ対象にする
 * （失効できない種別を解決しても意味がないため）。
 *
 * @returns 解決したトークン。どちらのストアにも無ければ null（RFC 7009 §2.2: 成功扱い）
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
 * ステップ 4: 解決したトークンが要求元クライアントに発行されたものか検証する
 *
 * RFC 7009 §2.1: "verifies whether the token was issued to the client making the
 * revocation request. If this validation fails, the request is refused and the
 * client is informed of the error"
 *
 * @throws {RevocationError} invalid_grant
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
 * ステップ 5: 解決した種別に応じて、提示されたトークン自体を失効させる
 *
 * @param token リクエストで提示されたトークン値
 * @param resolved 解決済みトークン
 * @param resolvers 失効処理のリゾルバ群
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
 * ステップ 6: リフレッシュトークン失効時に同 grant のアクセストークンも失効させる
 *
 * RFC 7009 §2.1 SHOULD: refresh token を失効させたら、同じ authorization grant で
 * 発行されたアクセストークンも失効させる（片方向 cascade）。アクセストークンの失効では
 * 関連 refresh token を失効させない（MAY、本実装では採用しない）。
 *
 * cascade 用リゾルバ（`revokeAccessTokensByGrantId`）が無い場合は何もしない。
 */
export async function revokeGrantAccessTokens(
  resolved: ResolvedRevocationToken,
  resolvers: RevocationTokenResolvers,
): Promise<void> {
  if (resolved.tokenType !== 'refresh_token') return;
  await resolvers.revokeAccessTokensByGrantId?.(resolved.refreshToken.grantId);
}

/**
 * Revocation 本体。成功時は void を返し、呼び出し側が 200 OK 空ボディを返す。
 *
 * 各ステップ関数を仕様順に合成した後方互換 API。CLI が生成する Provider は
 * この合成関数ではなく個々のステップ関数を順に呼び出すため、利用者は検証を
 * 削除したり独自処理を差し込んだりできる。
 *
 * 検索順:
 * - hint=refresh_token → refresh → access
 * - それ以外（hint=access_token / 不明 / 無し） → access → refresh
 *
 * トークンが見つからなくてもエラーにしない（RFC 7009 §2.2）。
 */
export async function handleRevocationRequest(
  ctx: RevocationRequestContext,
): Promise<void> {
  const token = requireRevocationToken(ctx.params);
  requireRevocationClient(ctx.authenticatedClientId);

  const resolved = await resolveRevocationTarget({
    token,
    tokenTypeHint: ctx.params.token_type_hint,
    resolvers: ctx.resolvers,
  });
  if (resolved === null) return;

  validateRevocationTokenClient(resolved, ctx.authenticatedClientId);
  await revokeResolvedToken(token, resolved, ctx.resolvers);
  await revokeGrantAccessTokens(resolved, ctx.resolvers);
}
