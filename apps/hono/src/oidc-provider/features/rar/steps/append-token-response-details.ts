import type { ValidatedTokenRequest } from '@maronn-openid-connect/core';
import type { TokenEndpointResponse } from '../../../endpoints/token/response.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'append-token-response-details',
  endpoint: 'token',
  feature: 'rar',
  kind: 'transform',
  label: '承認済みの authorization details を応答へ含める',
  spec: 'RFC 9396 §7',
  function: 'appendAuthorizationDetailsToTokenResponse',
  calls: ['rarGrantStore.get'],
  consumes: ['tokenResponse', 'validatedRequest'],
  produces: ['tokenResponse'],
  removable: false,
});

/**
 * グラントに紐づく authorization details があれば、トークンレスポンスのボディへ加えて返す。
 *
 * `validatedRequest.grantId`（authorization_code / refresh_token の両グラントを
 * 貫通する）で grant ストアを引き、あれば承認された配列をそのまま
 * `authorization_details` メンバーとして加える（RFC 9396 §7 の MUST。§7.1 の
 * enrichment はしない）。無ければ応答を変えずに返すので、details を持たない
 * グラントの応答は従来とバイト単位で同じである。
 *
 * 実験的な機能である。
 *
 * @spec RFC 9396 §7
 */
export async function appendAuthorizationDetailsToTokenResponse(
  c: any,
  tokenResponse: TokenEndpointResponse,
  validatedRequest: ValidatedTokenRequest,
): Promise<TokenEndpointResponse> {
  const rarGrantStore = c.get('rarGrantStore');
  const details = await rarGrantStore.get(validatedRequest.grantId);
  if (details === undefined) return tokenResponse;
  return {
    ...tokenResponse,
    body: { ...tokenResponse.body, authorization_details: details },
  };
}
