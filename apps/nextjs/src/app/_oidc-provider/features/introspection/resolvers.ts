/**
 * The resolvers the introspection endpoint looks the presented token up with,
 * on the stores of the request.
 */
import type {
  IntrospectionAccessTokenResolver,
  IntrospectionRefreshTokenResolver,
} from '@maronn-openid-connect/core';
import type { ProviderStores } from '../../store';

/**
 * ストアからトークンを探すリゾルバを作って返す。
 *
 * イントロスペクションエンドポイントが、アクセストークンとリフレッシュトークンを探すのに使う。
 * どちらのリゾルバも、ストアにトークンがなければ `null` を返す。
 */
export function createIntrospectionResolvers(stores: ProviderStores): {
  introspectionAccessTokenResolver: IntrospectionAccessTokenResolver;
  introspectionRefreshTokenResolver: IntrospectionRefreshTokenResolver;
} {
  return {
    introspectionAccessTokenResolver: {
      async findAccessToken(token) {
        return (await stores.accessTokenStore.get(token)) ?? null;
      },
    },
    introspectionRefreshTokenResolver: {
      async resolve(token) {
        return (await stores.refreshTokenStore.get(token)) ?? null;
      },
    },
  };
}
