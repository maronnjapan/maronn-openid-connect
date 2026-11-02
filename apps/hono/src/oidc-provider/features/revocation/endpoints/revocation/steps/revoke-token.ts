import {
  type ResolvedRevocationToken,
  validateRevocationTokenClient,
  revokeResolvedToken,
  revokeGrantAccessTokens,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'revoke-token',
  endpoint: 'revocation',
  feature: 'revocation',
  kind: 'persist',
  label: 'Revoke the token and its grant siblings',
  spec: 'RFC 7009 §2.1',
  function: 'revokeToken',
  consumes: ['token', 'resolved', 'authenticatedClientId'],
  produces: [],
  removable: false,
});

/**
 * 提示されたトークンを失効させる。
 *
 * リフレッシュトークンを失効させたときは、同じグラントのアクセストークンも失効させる（RFC 7009 §2.1 の SHOULD）。
 * ほかのクライアントに発行されたトークンなら、`RevocationError`（`invalid_grant`）を投げる。
 * トークンが見つからなかったとき（`resolved` が `null`）は、何もせずに戻る。
 * 見つからないトークンでも成功として応答し、どのトークンの値が存在するかをクライアントが探れないようにするためである（RFC 7009 §2.2）。
 *
 * @spec RFC 7009 §2.1
 * @spec RFC 7009 §2.2
 */
export async function revokeToken(
  c: any,
  token: string,
  resolved: ResolvedRevocationToken | null,
  authenticatedClientId: string,
): Promise<void> {
  if (resolved === null) return;
  const resolvers = c.get('revocationResolvers');

  // ほかのクライアントに発行されたトークンなら、`invalid_grant` で拒否する（RFC 7009 §2.1）。
  validateRevocationTokenClient(resolved, authenticatedClientId);

  await revokeResolvedToken(token, resolved, resolvers);

  // リフレッシュトークンを失効させたときは、同じグラントのアクセストークンも失効させる（RFC 7009 §2.1 の SHOULD）。
  // 提示されたトークンだけを失効させたいときは、この呼び出しを消す。
  await revokeGrantAccessTokens(resolved, resolvers);
}
