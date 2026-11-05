import {
  type TokenRequestParams,
  resolveRefreshToken,
  validateRefreshTokenUnused,
  validateRefreshTokenClient,
  validateRefreshTokenExpiration,
  validateRefreshTokenIdleTimeout,
  validateRefreshTokenSession,
  validateRefreshTokenScope,
  buildValidatedRefreshTokenRequest,
  type ValidatedRefreshTokenRequest,
} from '@maronn-openid-connect/core';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'validate-refresh-token-grant',
  endpoint: 'token',
  feature: 'refresh-token',
  kind: 'validate',
  label: 'refresh_token グラントを検証する',
  spec: 'OAuth 2.1 §4.3.1 / RFC 6749 §6',
  function: 'validateRefreshTokenGrant',
  consumes: ['params', 'authenticatedClientId', 'grantType'],
  produces: ['refreshTokenRequest'],
  removable: false,
});

/**
 * `refresh_token` を検証し、検証済みリクエストを返す。
 *
 * `grant_type` が `refresh_token` でなければ何もせずに `undefined` を返し、検証は `validate-authorization-code-grant` ステップに任せる。
 * `refresh_token` がない、リフレッシュトークンが見つからない、ローテーションで使用済み、ほかのクライアントに発行された、期限切れ、結び付けたログインセッションがない、要求されたスコープが元のグラントを超えるときは、中で呼ぶ core の関数が `TokenError`（`invalid_grant` など）を投げる。
 * 使用済みのリフレッシュトークンが再び提示されたときは、同じグラントのトークンを失効させてから拒否する。
 *
 * 安全のための規則はそれぞれ core の別々の関数なので、一つずつ取り除いたり、差し替えたり、実験用の処理を前後に挟んだりできる。
 *
 * @spec OAuth 2.1 §4.3.1
 * @spec RFC 6749 §6
 */
export async function validateRefreshTokenGrant(
  c: any,
  params: TokenRequestParams,
  authenticatedClientId: string,
  grantType: string,
): Promise<ValidatedRefreshTokenRequest | undefined> {
  if (grantType !== 'refresh_token') return undefined;
  const refreshTokenResolver = c.get('refreshTokenResolver');
  // オンラインのリフレッシュトークンを結び付けたセッションを `sessionId` から取得するリゾルバを、リクエストコンテキストから取り出す。
  // このリゾルバを差し替えると、セッションが続いているかどうかの判定を差し替えられる。
  const authenticationSessionResolver = c.get('authenticationSessionResolver');

  // `refresh_token` パラメータがあることを確かめ、提示されたリフレッシュトークンのレコード（保存したグラントの情報）をストアから取得する。
  const { refreshTokenInfo } = await resolveRefreshToken(
    params,
    refreshTokenResolver,
  );

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
