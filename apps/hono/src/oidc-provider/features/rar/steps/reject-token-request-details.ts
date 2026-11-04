import { AUTHORIZATION_DETAILS_PARAM } from '@maronn-openid-connect/experimental/rar';
import { TokenEndpointError } from '../../../endpoints/token/response.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'reject-token-request-details',
  endpoint: 'token',
  feature: 'rar',
  kind: 'validate',
  label: 'トークンリクエストの authorization_details を拒否する',
  spec: 'RFC 9396 §6',
  function: 'rejectTokenRequestAuthorizationDetails',
  consumes: ['params'],
  produces: [],
  removable: false,
});

/**
 * トークンリクエストに `authorization_details` があれば、400 の `invalid_authorization_details` で拒否する。
 *
 * RFC 9396 §6 のトークンリクエストでの再指定（narrowing）には対応しない。黙って
 * 無視すると「絞り込まれた」とクライアントに誤認させるので、明示的に拒否する。
 * このステップは feature grant の dispatch 群の直後・`[validate-grant-type]` の前に
 * 置き、トークンの発行・保存・提示リフレッシュトークンのローテーション失効という
 * どの副作用よりも前に拒否を確定させる（応答組み立て時の拒否は、拒否済み
 * リクエストの副作用を残すため禁止している）。
 *
 * 実験的な機能である。
 *
 * @spec RFC 9396 §6
 * @throws {TokenEndpointError} 400 `invalid_authorization_details`: リクエストに `authorization_details` パラメータがあるとき
 */
export function rejectTokenRequestAuthorizationDetails(params: Record<string, string>): void {
  if (params[AUTHORIZATION_DETAILS_PARAM] === undefined) return;
  throw new TokenEndpointError({
    status: 400,
    body: {
      error: 'invalid_authorization_details',
      error_description: 'authorization_details is not accepted at the token endpoint',
    },
  });
}
