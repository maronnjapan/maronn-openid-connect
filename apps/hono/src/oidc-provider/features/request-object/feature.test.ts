import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { discoveryOf, routesOf, tokenGrantsOf, type Feature } from '../feature.js';
import { requestObject } from './feature.js';

describe('requestObject', () => {
  describe('config', () => {
    // OIDC Core 1.0 §6.1: signed Request Objects only, unless enabled for conformance.
    // D-20: the algs core verifies (RFC 7518 §3.3 / §3.4).
    it('should default allowUnsignedRequestObject to false and accept the algs core verifies', () => {
      expect(requestObject.config).toEqual({
        allowUnsignedRequestObject: false,
        requestObjectSigningAlgValuesSupported: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
        // OIDC Core 1.0 §6.2 / RFC 9101 §5.2 / §10.4.
        requestUriParameterSupported: true,
        requireRequestUriRegistration: false,
        allowInsecureRequestUri: false,
        requestUriTimeoutMs: 3000,
        requestUriMaxBytes: 65536,
        requestUriMaxLength: 512,
      });
      expect(createProviderConfig().allowUnsignedRequestObject).toBe(false);
    });
  });

  // OIDC Discovery 1.0 §3.
  describe('discovery', () => {
    it('should advertise the request parameter with the accepted algs', () => {
      expect(discoveryOf([requestObject], {}, TEST_ISSUER, createProviderConfig({ issuer: TEST_ISSUER }))).toEqual({
        request_parameter_supported: true,
        request_object_signing_alg_values_supported: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
        request_uri_parameter_supported: true,
        require_request_uri_registration: false,
      });
    });

    // D-21: none is advertised only when unsigned Request Objects are accepted.
    it('should also advertise none when unsigned Request Objects are accepted', () => {
      const config = createProviderConfig({ issuer: TEST_ISSUER, allowUnsignedRequestObject: true });

      expect(discoveryOf([requestObject], {}, TEST_ISSUER, config)).toEqual({
        request_parameter_supported: true,
        request_object_signing_alg_values_supported: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'none'],
        request_uri_parameter_supported: true,
        require_request_uri_registration: false,
      });
    });

    // UC-6: the list is a setting.
    it('should advertise the algs of requestObjectSigningAlgValuesSupported', () => {
      const config = createProviderConfig({ issuer: TEST_ISSUER, requestObjectSigningAlgValuesSupported: ['RS256'] });

      expect(discoveryOf([requestObject], {}, TEST_ISSUER, config)).toEqual({
        request_parameter_supported: true,
        request_object_signing_alg_values_supported: ['RS256'],
        request_uri_parameter_supported: true,
        require_request_uri_registration: false,
      });
    });
  });

  // OIDC Discovery 1.0 §3: request_uri_parameter_supported and require_request_uri_registration.
  it('should advertise the request_uri settings', () => {
    const config = createProviderConfig({ issuer: TEST_ISSUER, requestUriParameterSupported: false, requireRequestUriRegistration: true });

    expect(discoveryOf([requestObject], {}, TEST_ISSUER, config)).toMatchObject({
      request_uri_parameter_supported: false,
      require_request_uri_registration: true,
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
