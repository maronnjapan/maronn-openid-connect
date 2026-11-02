/**
 * The resolvers the revocation endpoint finds and revokes the presented token
 * with, on the stores of the request.
 */
import type { RevocationTokenResolvers } from '@maronn-openid-connect/core';
import type { ProviderStores } from '../../store';

/** The resolvers the revocation endpoint finds and revokes tokens through, on top of the access token and refresh token stores. */
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
