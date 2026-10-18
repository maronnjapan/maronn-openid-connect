import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { configOf, discoveryOf, routesOf, tokenGrantsOf, type Feature } from '../feature.js';
import { jwtIntrospectionResponse } from './feature.js';

describe('jwtIntrospectionResponse', () => {
  // RFC 9701 §7: authorization server metadata.
  describe('discovery', () => {
    it('should advertise RS256 as the only introspection response signing alg', () => {
      expect(
        discoveryOf([jwtIntrospectionResponse], {}, TEST_ISSUER, createProviderConfig({ issuer: TEST_ISSUER })),
      ).toEqual({ introspection_signing_alg_values_supported: ['RS256'] });
    });
  });

  // The response is answered by the introspection endpoint of the introspection feature.
  describe('routes, context, config and token', () => {
    it('should add no routes, no context values, no provider settings and no token grants', () => {
      expect(routesOf([jwtIntrospectionResponse])).toEqual([]);
      expect((jwtIntrospectionResponse as Feature).context).toBeUndefined();
      expect(configOf([jwtIntrospectionResponse])).toEqual({});
      expect(tokenGrantsOf([jwtIntrospectionResponse])).toEqual([]);
    });
  });
});
