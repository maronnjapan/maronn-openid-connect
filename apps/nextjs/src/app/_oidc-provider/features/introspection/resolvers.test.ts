import { describe, expect, it } from 'vitest';
import { accessTokenInfo, refreshTokenInfo } from '../../../../test-support/fixtures';
import { createEmptyDatabase } from '../../db/memory/database';
import { createProviderStores } from '../../db/memory/stores';
import { createIntrospectionResolvers } from './resolvers';

describe('createIntrospectionResolvers', () => {
  describe('introspectionAccessTokenResolver', () => {
    it('should find an access token of the access token store', async () => {
      const stores = createProviderStores(createEmptyDatabase());
      const info = accessTokenInfo();
      await stores.accessTokenStore.set('at-1', info);

      const { introspectionAccessTokenResolver } = createIntrospectionResolvers(stores);

      expect(await introspectionAccessTokenResolver.findAccessToken('at-1')).toEqual(info);
    });

    it('should return null for an access token the store does not hold', async () => {
      const { introspectionAccessTokenResolver } = createIntrospectionResolvers(
        createProviderStores(createEmptyDatabase()),
      );

      expect(await introspectionAccessTokenResolver.findAccessToken('unknown')).toBeNull();
    });
  });

  describe('introspectionRefreshTokenResolver', () => {
    // RFC 7662 §2.2: a rotated refresh token is still found, so it can be reported inactive.
    it('should find a refresh token of the refresh token store, used ones included', async () => {
      const stores = createProviderStores(createEmptyDatabase());
      const info = refreshTokenInfo({ used: true });
      await stores.refreshTokenStore.set('rt-1', info);

      const { introspectionRefreshTokenResolver } = createIntrospectionResolvers(stores);

      expect(await introspectionRefreshTokenResolver.resolve('rt-1')).toEqual(info);
    });

    it('should return null for a refresh token the store does not hold', async () => {
      const { introspectionRefreshTokenResolver } = createIntrospectionResolvers(
        createProviderStores(createEmptyDatabase()),
      );

      expect(await introspectionRefreshTokenResolver.resolve('unknown')).toBeNull();
    });
  });
});
