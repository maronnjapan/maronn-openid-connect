import {
  requireIntrospectionToken,
  requireIntrospectionClient,
  resolveIntrospectionToken,
  type ResolvedIntrospectionToken,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'resolve-token',
  endpoint: 'introspection',
  feature: 'introspection',
  kind: 'resolve',
  label: 'Resolve the presented token',
  spec: 'RFC 7662 §2.1',
  function: 'resolveIntrospectedToken',
  consumes: ['params', 'authenticatedClientId'],
  produces: ['resolved'],
  removable: false,
});

/**
 * 提示されたトークンをストアから探して返す。
 *
 * アクセストークンとリフレッシュトークンのストアを探し、どちらにもなければ `null` を返す。
 * `token_type_hint` は探す順番を変えるだけで、`refresh_token` ならリフレッシュトークンから、それ以外ならアクセストークンから探し、見つからなければもう一方も探す。
 * `token` パラメータがなければ `invalid_request` の、クライアントが認証されていなければ `invalid_client` の `IntrospectionError` を投げる。
 *
 * 中の確認はそれぞれ core の独立した関数なので、一つずつ取り除いたり差し替えたりできる。
 *
 * @spec RFC 7662 §2.1
 */
export async function resolveIntrospectedToken(
  c: any,
  params: Record<string, string>,
  authenticatedClientId: string,
): Promise<ResolvedIntrospectionToken | null> {
  const accessTokenResolver = c.get('introspectionAccessTokenResolver');
  const refreshTokenResolver = c.get('introspectionRefreshTokenResolver');

  // `token` パラメータは必須で、なければ `invalid_request` にする（RFC 7662 §2.1）。
  const token = requireIntrospectionToken({
    token: typeof params.token === 'string' ? params.token : undefined,
  });

  // 呼び出し元がクライアントとして認証されていることを確かめ、されていなければ `invalid_client` にする（RFC 7662 §2.1）。
  requireIntrospectionClient(authenticatedClientId);

  return resolveIntrospectionToken({
    token,
    tokenTypeHint:
      typeof params.token_type_hint === 'string' ? params.token_type_hint : undefined,
    accessTokenResolver,
    refreshTokenResolver,
  });
}
