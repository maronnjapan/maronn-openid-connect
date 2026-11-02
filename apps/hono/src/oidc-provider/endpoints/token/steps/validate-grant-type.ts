import {
  type TokenRequestParams,
  type TokenClientInfo,
  validateGrantTypeSupported,
  validateClientGrantType,
} from '@maronn-openid-connect/core';
import { features } from '../../../features/enabled.js';
import { tokenGrantsOf } from '../../../features/feature.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-grant-type',
  endpoint: 'token',
  kind: 'validate',
  label: 'Validate grant_type',
  spec: 'RFC 6749 §5.2',
  function: 'validateTokenGrantType',
  consumes: ['params', 'tokenClient'],
  produces: ['grantType'],
  removable: false,
});

/**
 * `grant_type` を検証し、そのグラントタイプを返す。
 *
 * この OP が扱わない値なら `unsupported_grant_type` を、クライアントに許可していない値なら `unauthorized_client` を、`TokenError` として投げる。
 * この OP が扱う値は、常に扱う `authorization_code` と、有効にした機能がトークンエンドポイントに加えたグラント（`refresh-token` 機能の `refresh_token`）である。
 *
 * @spec RFC 6749 §5.2
 */
export function validateTokenGrantType(
  params: TokenRequestParams,
  tokenClient: TokenClientInfo,
): 'authorization_code' | 'refresh_token' {
  // `grant_type` がこの OP の扱う値かどうかを確かめ、扱わない値なら `unsupported_grant_type` にする（RFC 6749 §5.2）。
  // `authorization_code` は常に扱い、`refresh_token` は `refresh-token` 機能がトークンエンドポイントに加えたとき（その機能の `feature.ts` の `token.grants`）だけ扱う。
  // 機能が自分で応答するグラントは、このステップより前で処理を終えている。
  const grantType = validateGrantTypeSupported(params.grant_type, [
    'authorization_code',
    ...tokenGrantsOf(features),
  ]);

  // クライアントにこの `grant_type` が許可されているかを確かめ、許可されていなければ `unauthorized_client` にする（RFC 6749 §5.2）。
  validateClientGrantType(tokenClient, grantType);

  return grantType;
}
