import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { discoveryOf, routesOf, tokenGrantsOf, type Feature } from '../feature.js';
import { requestObject } from './feature.js';

describe('requestObject', () => {
  describe('config', () => {
    // OIDC Core 1.0 §6.1: signed Request Objects only, unless enabled for conformance.
    it('should default allowUnsignedRequestObject to false', () => {
      expect(requestObject.config).toEqual({ allowUnsignedRequestObject: false });
      expect(createProviderConfig().allowUnsignedRequestObject).toBe(false);
    });
  });

  // OIDC Discovery 1.0 §3.
  describe('discovery', () => {
    it('should advertise the request parameter with RS256 only', () => {
      expect(discoveryOf([requestObject], {}, TEST_ISSUER, createProviderConfig({ issuer: TEST_ISSUER }))).toEqual({
        request_parameter_supported: true,
        request_object_signing_alg_values_supported: ['RS256'],
      });
    });

    it('should also advertise none when unsigned Request Objects are accepted', () => {
      const config = createProviderConfig({ issuer: TEST_ISSUER, allowUnsignedRequestObject: true });

      expect(discoveryOf([requestObject], {}, TEST_ISSUER, config)).toEqual({
        request_parameter_supported: true,
        request_object_signing_alg_values_supported: ['RS256', 'none'],
      });
    });
  });

  describe('routes, context and token', () => {
    it('should add no routes, no context values and no token grants', () => {
      expect(routesOf([requestObject])).toEqual([]);
      expect((requestObject as Feature).context).toBeUndefined();
      expect(tokenGrantsOf([requestObject])).toEqual([]);
    });
  });
});
