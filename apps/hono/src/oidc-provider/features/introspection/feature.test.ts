import { describe, expect, it } from 'vitest';
import { TEST_ISSUER, contextOf } from '../../../test-support/context.js';
import { accessTokenInfo, refreshTokenInfo } from '../../../test-support/feature-endpoints.js';
import { rs256Key, staticKeyProvider } from '../../../test-support/keys.js';
import { createProviderConfig } from '../../config.js';
import { createEmptyDatabase } from '../../db/memory/database.js';
import { createProviderStores } from '../../db/memory/stores.js';
import { applyContextOf, configOf, discoveryOf, tokenGrantsOf } from '../feature.js';
import { introspectionApp } from './endpoints/introspection/pipeline.js';
import { introspection } from './feature.js';

describe('introspection', () => {
  describe('routes', () => {
    // RFC 7662 §2: POST /introspect, with the token endpoint's CORS policy.
    it('should serve POST /introspect with the protected CORS policy', () => {
      expect(introspection.routes).toEqual([
        { path: '/introspect', app: introspectionApp, methods: ['POST'], cors: 'protected' },
      ]);
    });
  });

  // RFC 8414 §2: introspection endpoint metadata.
  describe('discovery', () => {
    it('should advertise the endpoint under the issuer with the confidential client methods', () => {
      expect(discoveryOf([introspection], {}, TEST_ISSUER, createProviderConfig({ issuer: TEST_ISSUER }))).toEqual({
        introspection_endpoint: 'https://op.example.com/introspect',
        introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    });
  });

  describe('context', () => {
    it('should put resolvers over the stores of the request into the context', async () => {
      const stores = createProviderStores(createEmptyDatabase());
      const accessToken = accessTokenInfo();
      const refreshToken = refreshTokenInfo();
      await stores.accessTokenStore.set('at-1', accessToken);
      await stores.refreshTokenStore.set('rt-1', refreshToken);
      const c = contextOf();

      await applyContextOf([introspection], {
        c,
        options: { signingKeyProvider: staticKeyProvider(await rs256Key()) },
        stores,
      });

      expect(await c.get('introspectionAccessTokenResolver').findAccessToken('at-1')).toEqual(accessToken);
      expect(await c.get('introspectionRefreshTokenResolver').resolve('rt-1')).toEqual(refreshToken);
    });
  });

  describe('config and token', () => {
    it('should add no provider settings and no token grants', () => {
      expect(configOf([introspection])).toEqual({});
      expect(tokenGrantsOf([introspection])).toEqual([]);
    });
  });
});
