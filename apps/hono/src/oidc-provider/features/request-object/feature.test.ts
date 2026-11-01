import { describe, expect, it } from 'vitest';
import { providerContext, TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { discoveryOf, routesOf, tokenGrantsOf } from '../feature.js';
import { requestObject } from './feature.js';

describe('requestObject', () => {
  describe('config', () => {
    // OIDC Core 1.0 §6.1: signed Request Objects only, unless enabled for
    // conformance; §6.2: only pre-registered request_uri values are fetched.
    it('should default allowUnsignedRequestObject to false and requireRequestUriRegistration to true', () => {
      expect(requestObject.config).toEqual({ allowUnsignedRequestObject: false, requireRequestUriRegistration: true });
      expect(createProviderConfig().allowUnsignedRequestObject).toBe(false);
      expect(createProviderConfig().requireRequestUriRegistration).toBe(true);
    });
  });

  // OIDC Discovery 1.0 §3.
  describe('discovery', () => {
    it('should advertise the request and request_uri parameters with RS256 only, and the registration requirement', () => {
      expect(discoveryOf([requestObject], {}, TEST_ISSUER, createProviderConfig({ issuer: TEST_ISSUER }))).toEqual({
        request_parameter_supported: true,
        request_uri_parameter_supported: true,
        require_request_uri_registration: true,
        request_object_signing_alg_values_supported: ['RS256'],
      });
    });

    it('should also advertise none when unsigned Request Objects are accepted', () => {
      const config = createProviderConfig({ issuer: TEST_ISSUER, allowUnsignedRequestObject: true });

      expect(discoveryOf([requestObject], {}, TEST_ISSUER, config)).toEqual({
        request_parameter_supported: true,
        request_uri_parameter_supported: true,
        require_request_uri_registration: true,
        request_object_signing_alg_values_supported: ['RS256', 'none'],
      });
    });

    it('should advertise require_request_uri_registration false when the config turns it off', () => {
      const config = createProviderConfig({ issuer: TEST_ISSUER, requireRequestUriRegistration: false });

      expect(discoveryOf([requestObject], {}, TEST_ISSUER, config)).toMatchObject({
        request_uri_parameter_supported: true,
        require_request_uri_registration: false,
      });
    });
  });

  describe('routes, context and token', () => {
    it('should add no routes and no token grants', () => {
      expect(routesOf([requestObject])).toEqual([]);
      expect(tokenGrantsOf([requestObject])).toEqual([]);
    });

    // OIDC Core 1.0 §6.2.3: the fetch of the requestUriFetch option, when given.
    it('should put the requestUriFetch option into the context, and nothing without it', async () => {
      const requestUriFetch = (async () => new Response('')) as typeof fetch;
      const withOption = await providerContext({ options: { requestUriFetch } });
      const withoutOption = await providerContext();

      expect(withOption.c.get('requestUriFetch')).toBe(requestUriFetch);
      expect(withoutOption.c.get('requestUriFetch')).toBeUndefined();
    });
  });
});
