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
import { implicitFlow } from './feature.js';
import { fragmentResponseModeHandler } from './response-mode.js';
import { implicitResponseTypeHandler } from './response-type.js';

describe('implicitFlow', () => {
  // OIDC Discovery 1.0 §3: response_modes_supported and grant_types_supported.
  describe('discovery', () => {
    it('should advertise the fragment response mode and the implicit grant type next to those the provider advertises', () => {
      expect(
        discoveryOf(
          [implicitFlow],
          { response_modes_supported: ['query'], grant_types_supported: ['authorization_code'] },
          TEST_ISSUER,
          createProviderConfig({ issuer: TEST_ISSUER }),
        ),
      ).toEqual({
        response_modes_supported: ['query', 'fragment'],
        grant_types_supported: ['authorization_code', 'implicit'],
      });
    });
  });

  // OIDC Core 1.0 §3.2.2.1: the response types the feature answers, and the
  // fragment response mode /consent restores for them.
  describe('authorize', () => {
    it('should answer id_token and id_token token', () => {
      expect(responseTypesOf([implicitFlow])).toEqual([implicitResponseTypeHandler]);
      expect(implicitResponseTypeHandler.names).toEqual(['id_token', 'id_token token']);
    });

    it('should answer in the fragment response mode at /consent', () => {
      expect(responseModesOf([implicitFlow])).toEqual([fragmentResponseModeHandler]);
    });
  });

  // The implicit grant is answered at the authorization endpoint: the token
  // endpoint must not accept grant_type=implicit.
  describe('routes, config and token', () => {
    it('should add no routes, no provider settings and no token grants', () => {
      expect(routesOf([implicitFlow])).toEqual([]);
      expect(configOf([implicitFlow])).toEqual({});
      expect(tokenGrantsOf([implicitFlow])).toEqual([]);
    });
  });
});
