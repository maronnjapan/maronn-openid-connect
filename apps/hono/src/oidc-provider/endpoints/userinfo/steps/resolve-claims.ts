import {
  type AccessTokenInfo,
  resolveUserInfoClaims,
  filterClaimsByScope,
  applyRequestedClaims,
  type UserInfoResponse,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'resolve-claims',
  endpoint: 'userinfo',
  kind: 'resolve',
  label: 'Resolve the claims the token may see',
  spec: 'OIDC Core 1.0 §5.4 / §5.5',
  function: 'resolveUserInfoResponseClaims',
  consumes: ['tokenInfo'],
  produces: ['claims'],
  removable: false,
});

/**
 * このトークンで取得してよいクレームを集めて返す。
 *
 * サブジェクトについて OP が持つすべてのクレームを、許可したスコープで絞り、トークンと一緒に保存した、個別に要求されたクレームを加える。
 *
 * @throws {UserInfoError} `invalid_token`: トークンのサブジェクトのユーザーが見つからないとき。
 * @spec OIDC Core 1.0 §5.4
 * @spec OIDC Core 1.0 §5.5
 */
export async function resolveUserInfoResponseClaims(
  c: any,
  tokenInfo: AccessTokenInfo,
): Promise<UserInfoResponse> {
  const userClaimsResolver = c.get('userClaimsResolver');

  // トークンのサブジェクトについて、OP が持つすべてのクレームを読み込む。
  const userClaims = await resolveUserInfoClaims(tokenInfo, userClaimsResolver);

  // 許可したスコープが認めるクレームだけを残す（OIDC Core 1.0 §5.4）。
  const scopedResponse = filterClaimsByScope(userClaims, tokenInfo.scope);

  // トークンエンドポイントがこのアクセストークンと一緒に保存した、個別に要求されたクレーム（`claims.userinfo` の項目）を重ねる（OIDC Core 1.0 §5.5）。
  return applyRequestedClaims(scopedResponse, userClaims, tokenInfo.claims);
}
