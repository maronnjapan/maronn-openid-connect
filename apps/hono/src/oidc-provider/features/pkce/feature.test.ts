import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { configOf, discoveryOf, routesOf, tokenGrantsOf, type Feature } from '../feature.js';
import { pkce } from './feature.js';

describe('pkce', () => {
  describe('config', () => {
    // OAuth 2.1 §4.1.1 / §7.5: PKCE is required of every client, confidential ones included.
    it('should set allowNonPkceAuthorizationCodeFlow to false', () => {
      expect(configOf([pkce])).toEqual({ allowNonPkceAuthorizationCodeFlow: false });
    });

    // config.ts keeps true for a provider generated with --disable pkce.
    it('should turn the provider default of allowNonPkceAuthorizationCodeFlow from true to false', () => {
      expect(createProviderConfig().allowNonPkceAuthorizationCodeFlow).toBe(false);
    });

    it('should let the app override the default', () => {
      expect(createProviderConfig({ allowNonPkceAuthorizationCodeFlow: true }).allowNonPkceAuthorizationCodeFlow).toBe(
        true,
      );
    });
  });

  describe('routes, discovery, context and token', () => {
    it('should add no routes, no metadata, no context values and no token grants', () => {
      const metadata = { issuer: TEST_ISSUER, code_challenge_methods_supported: ['S256'] };

      expect(routesOf([pkce])).toEqual([]);
      expect(discoveryOf([pkce], metadata, TEST_ISSUER, createProviderConfig({ issuer: TEST_ISSUER }))).toEqual(metadata);
      expect((pkce as Feature).context).toBeUndefined();
      expect(tokenGrantsOf([pkce])).toEqual([]);
    });
  });
});
