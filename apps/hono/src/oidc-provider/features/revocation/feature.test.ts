import { describe, expect, it } from 'vitest';
import { TEST_ISSUER, contextOf } from '../../../test-support/context.js';
import { accessTokenInfo } from '../../../test-support/feature-endpoints.js';
import { rs256Key, staticKeyProvider } from '../../../test-support/keys.js';
import { createProviderConfig } from '../../config.js';
import { createEmptyDatabase } from '../../db/memory/database.js';
import { createProviderStores } from '../../db/memory/stores.js';
import { applyContextOf, configOf, discoveryOf, tokenGrantsOf } from '../feature.js';
import { revocationApp } from './endpoints/revocation/pipeline.js';
import { revocation } from './feature.js';

describe('revocation', () => {
  describe('routes', () => {
    // RFC 7009 §2: POST /revoke, with the token endpoint's CORS policy.
    it('should serve POST /revoke with the protected CORS policy', () => {
      expect(revocation.routes).toEqual([{ path: '/revoke', app: revocationApp, methods: ['POST'], cors: 'protected' }]);
    });
  });

  // RFC 8414 §2: revocation endpoint metadata.
  describe('discovery', () => {
    it('should advertise the endpoint under the issuer with the confidential client methods', () => {
      expect(discoveryOf([revocation], {}, TEST_ISSUER, createProviderConfig({ issuer: TEST_ISSUER }))).toEqual({
        revocation_endpoint: 'https://op.example.com/revoke',
        revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    });
  });

  describe('context', () => {
    it('should put revocation resolvers over the stores of the request into the context', async () => {
      const db = createEmptyDatabase();
      const stores = createProviderStores(db);
      const accessToken = accessTokenInfo();
      await stores.accessTokenStore.set('at-1', accessToken);
      const c = contextOf();

      await applyContextOf([revocation], {
        c,
        options: { signingKeyProvider: staticKeyProvider(await rs256Key()) },
        stores,
      });
      const resolvers = c.get('revocationResolvers');

      expect(await resolvers.findAccessToken('at-1')).toEqual(accessToken);
      await resolvers.revokeAccessToken('at-1');
      expect(db.accessTokens.has('at-1')).toBe(false);
    });
  });

  describe('config and token', () => {
    it('should add no provider settings and no token grants', () => {
      expect(configOf([revocation])).toEqual({});
      expect(tokenGrantsOf([revocation])).toEqual([]);
    });
  });
});
