import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import {
  configOf,
  discoveryOf,
  responseModesOf,
  responseTypesOf,
  routesOf,
  tokenGrantsOf,
} from '../feature.js';
import { hybridFlow } from './feature.js';
import { hybridResponseTypeHandler } from './response-type.js';

describe('hybridFlow', () => {
  // OIDC Discovery 1.0 §3: grant_types_supported (OIDC Dynamic Client
  // Registration 1.0 §2 pairs the hybrid response types with implicit) and
  // claims_supported (OIDC Core 1.0 §3.3.2.11: c_hash).
  describe('discovery', () => {
    it('should advertise the implicit grant type and the c_hash claim next to those the provider advertises', () => {
      expect(
        discoveryOf(
          [hybridFlow],
          { grant_types_supported: ['authorization_code'], claims_supported: ['sub', 'at_hash'] },
          TEST_ISSUER,
          createProviderConfig({ issuer: TEST_ISSUER }),
        ),
      ).toEqual({
        grant_types_supported: ['authorization_code', 'implicit'],
        claims_supported: ['sub', 'at_hash', 'c_hash'],
      });
    });
  });

  // OIDC Core 1.0 §3.3.1.1: the response types the feature answers. The
  // fragment response mode is the implicit-flow feature's, which this one requires.
  describe('authorize', () => {
    it('should answer code id_token, code token and code id_token token', () => {
      expect(responseTypesOf([hybridFlow])).toEqual([hybridResponseTypeHandler]);
      expect(hybridResponseTypeHandler.names).toEqual(['code id_token', 'code token', 'code id_token token']);
    });

    it('should restore no response mode of its own', () => {
      expect(responseModesOf([hybridFlow])).toEqual([]);
    });
  });

  // The code of the Hybrid Flow is exchanged with the authorization_code
  // grant every provider answers.
  describe('routes, config and token', () => {
    it('should add no routes, no provider settings and no token grants', () => {
      expect(routesOf([hybridFlow])).toEqual([]);
      expect(configOf([hybridFlow])).toEqual({});
      expect(tokenGrantsOf([hybridFlow])).toEqual([]);
    });
  });
});
