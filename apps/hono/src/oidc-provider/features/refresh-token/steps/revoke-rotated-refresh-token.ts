import type { TokenRequestParams, ValidatedTokenRequest } from '@maronn-openid-connect/core';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'revoke-rotated-refresh-token',
  endpoint: 'token',
  feature: 'refresh-token',
  kind: 'persist',
  label: '古いリフレッシュトークンを失効させる',
  spec: 'OAuth 2.1 §4.3.1',
  function: 'revokeRotatedRefreshToken',
  consumes: ['params', 'validatedRequest'],
  produces: [],
  removable: true,
  after: ['issue-refresh-token'],
});

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
  c: any,
  params: TokenRequestParams,
  validatedRequest: ValidatedTokenRequest,
): Promise<void> {
  if (validatedRequest.grantType !== 'refresh_token' || !params.refresh_token) return;
  const refreshTokenResolver = c.get('refreshTokenResolver');
  await refreshTokenResolver.revokeRefreshToken(params.refresh_token);
}
