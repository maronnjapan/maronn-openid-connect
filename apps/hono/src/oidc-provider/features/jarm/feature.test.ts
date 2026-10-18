import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { configOf, discoveryOf, responseModesOf, routesOf, tokenGrantsOf } from '../feature.js';
import { jarm } from './feature.js';
import { jarmResponseModeHandler } from './response-mode.js';

describe('jarm', () => {
  // JARM §4: authorization server metadata.
  describe('discovery', () => {
    it('should advertise the JWT response modes and RS256 as the only signing alg', () => {
      expect(discoveryOf([jarm], {}, TEST_ISSUER, createProviderConfig({ issuer: TEST_ISSUER }))).toEqual({
        response_modes_supported: ['query.jwt', 'jwt'],
        authorization_signing_alg_values_supported: ['RS256'],
      });
    });
  });

  // JARM §2.3: /consent answers in the response mode the transaction stored.
  describe('authorize', () => {
    it('should answer in the JARM response mode at /consent', () => {
      expect(responseModesOf([jarm])).toEqual([jarmResponseModeHandler]);
      expect(responseModesOf([jarm])[0]).toBe(jarmResponseModeHandler);
    });
  });

  describe('routes, config and token', () => {
    it('should add no routes, no provider settings and no token grants', () => {
      expect(routesOf([jarm])).toEqual([]);
      expect(configOf([jarm])).toEqual({});
      expect(tokenGrantsOf([jarm])).toEqual([]);
    });
  });
});
