import {
  requireRevocationToken,
  requireRevocationClient,
  resolveRevocationTarget,
  type ResolvedRevocationToken,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'resolve-token',
  endpoint: 'revocation',
  feature: 'revocation',
  kind: 'resolve',
  label: 'Resolve the presented token',
  spec: 'RFC 7009 §2.1',
  function: 'resolveRevocationTokenTarget',
  consumes: ['params', 'authenticatedClientId'],
  produces: ['token', 'resolved'],
  removable: false,
});

/**
 * 提示されたトークンをストアから探して返す。
 *
 * 提示されたトークンの値（`token`）と、アクセストークンとリフレッシュトークンのストアを探した結果（`resolved`）を返し、どちらにもなければ `resolved` を `null` にする。
 * `token_type_hint` は探す順番を変えるだけで、`refresh_token` ならリフレッシュトークンから、それ以外ならアクセストークンから探し、見つからなければもう一方も探す。
 * リフレッシュトークンは、リゾルバに探す関数と失効させる関数の両方があるときだけ探す。
 * `token` パラメータがなければ `invalid_request` の、クライアントが識別されていなければ `invalid_client` の `RevocationError` を投げる。
 *
 * 中の確認はそれぞれ core の独立した関数なので、一つずつ取り除いたり差し替えたりできる。
 *
 * @spec RFC 7009 §2.1
 */
export async function resolveRevocationTokenTarget(
  c: any,
  params: Record<string, string>,
  authenticatedClientId: string,
): Promise<{ token: string; resolved: ResolvedRevocationToken | null }> {
  const resolvers = c.get('revocationResolvers');

  // `token` パラメータは必須で、なければ `invalid_request` にする（RFC 7009 §2.1）。
  const token = requireRevocationToken({
    token: typeof params.token === 'string' ? params.token : undefined,
  });

  // 呼び出し元のクライアントが識別されていることを確かめ、されていなければ `invalid_client` にする（RFC 7009 §2.1）。
  requireRevocationClient(authenticatedClientId);

  const resolved = await resolveRevocationTarget({
    token,
    tokenTypeHint:
      typeof params.token_type_hint === 'string' ? params.token_type_hint : undefined,
    resolvers,
  });
  return { token, resolved };
}
