import { describe, expect, it } from 'vitest';
import { accessTokenInfo, refreshTokenInfo } from '../../../../test-support/fixtures';
import { createEmptyDatabase } from '../../db/memory/database';
import { createProviderStores } from '../../db/memory/stores';
import { createRevocationResolvers } from './resolvers';

async function storesWithTokens() {
  const db = createEmptyDatabase();
  const stores = createProviderStores(db);
  await stores.accessTokenStore.set('at-grant-1', accessTokenInfo({ grantId: 'grant-1' }));
  await stores.accessTokenStore.set('at-grant-2', accessTokenInfo({ grantId: 'grant-2' }));
  await stores.refreshTokenStore.set('rt-grant-1', refreshTokenInfo({ grantId: 'grant-1' }));
  return { db, stores };
}

describe('createRevocationResolvers', () => {
  describe('Access Tokens', () => {
    it('should find an access token of the store and null for an unknown one', async () => {
      const { stores } = await storesWithTokens();
      const resolvers = createRevocationResolvers(stores);

      expect(await resolvers.findAccessToken('at-grant-1')).toEqual(await stores.accessTokenStore.get('at-grant-1'));
      expect(await resolvers.findAccessToken('unknown')).toBeNull();
    });

    it('should revoke one access token', async () => {
      const { db, stores } = await storesWithTokens();

      await createRevocationResolvers(stores).revokeAccessToken('at-grant-1');

      expect([...db.accessTokens.keys()]).toEqual(['at-grant-2']);
    });

    // RFC 7009 §2.1: the cascade of a revoked refresh token.
    it('should revoke the access tokens of one grant', async () => {
      const { db, stores } = await storesWithTokens();

      await createRevocationResolvers(stores).revokeAccessTokensByGrantId?.('grant-1');

      expect([...db.accessTokens.keys()]).toEqual(['at-grant-2']);
      expect([...db.refreshTokens.keys()]).toEqual(['rt-grant-1']);
    });
  });

  describe('Refresh Tokens', () => {
    it('should find a refresh token of the store and null for an unknown one', async () => {
      const { stores } = await storesWithTokens();
      const resolvers = createRevocationResolvers(stores);

      expect(await resolvers.findRefreshToken?.('rt-grant-1')).toEqual(await stores.refreshTokenStore.get('rt-grant-1'));
      expect(await resolvers.findRefreshToken?.('unknown')).toBeNull();
    });

    it('should revoke one refresh token and keep the access tokens', async () => {
      const { db, stores } = await storesWithTokens();

      await createRevocationResolvers(stores).revokeRefreshToken?.('rt-grant-1');

      expect([...db.refreshTokens.keys()]).toEqual([]);
      expect([...db.accessTokens.keys()]).toEqual(['at-grant-1', 'at-grant-2']);
    });
  });
});
