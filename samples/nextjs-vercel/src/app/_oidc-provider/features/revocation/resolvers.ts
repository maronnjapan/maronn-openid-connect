/**
 * The resolvers the revocation endpoint finds and revokes the presented token
 * with, on the stores of the request.
 */
import type { RevocationTokenResolvers } from '@maronn-openid-connect/core';
import type { ProviderStores } from '../../store';

/**
 * トークンを探して失効させるリゾルバを作って返す。
 *
 * 失効エンドポイントが使う。
 * アクセストークンとリフレッシュトークンをストアから探す関数（なければ `null` を返す）、それぞれを失効させる関数、同じグラントのアクセストークンをまとめて失効させる関数を持つ。
 */
export function createRevocationResolvers(stores: ProviderStores): RevocationTokenResolvers {
  const { accessTokenStore, refreshTokenStore } = stores;
  return {
    async findAccessToken(token) {
      return (await accessTokenStore.get(token)) ?? null;
    },
    async revokeAccessToken(token) {
      await accessTokenStore.revoke(token);
    },
    async findRefreshToken(token) {
      return (await refreshTokenStore.get(token)) ?? null;
    },
    async revokeRefreshToken(token) {
      await refreshTokenStore.revoke(token);
    },
    async revokeAccessTokensByGrantId(grantId) {
      await accessTokenStore.revokeByGrantId(grantId);
    },
  };
}
