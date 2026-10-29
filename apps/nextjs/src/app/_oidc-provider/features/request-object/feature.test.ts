import { describe, expect, it } from 'vitest';
import { createProviderConfig } from '../../config';
import { discoveryOf } from '../../feature';
import { requestObject } from './feature';

const ISSUER = 'https://op.example.com';

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
      expect(discoveryOf([requestObject], {}, ISSUER, createProviderConfig({ issuer: ISSUER }))).toEqual({
        request_parameter_supported: true,
        request_uri_parameter_supported: true,
        require_request_uri_registration: true,
        request_object_signing_alg_values_supported: ['RS256'],
      });
    });

    it('should also advertise none when unsigned Request Objects are accepted', () => {
      const config = createProviderConfig({ issuer: ISSUER, allowUnsignedRequestObject: true });

      expect(discoveryOf([requestObject], {}, ISSUER, config)).toEqual({
        request_parameter_supported: true,
        request_uri_parameter_supported: true,
        require_request_uri_registration: true,
        request_object_signing_alg_values_supported: ['RS256', 'none'],
      });
    });

    it('should advertise require_request_uri_registration false when the config turns it off', () => {
      const config = createProviderConfig({ issuer: ISSUER, requireRequestUriRegistration: false });

      expect(discoveryOf([requestObject], {}, ISSUER, config)).toMatchObject({
        request_uri_parameter_supported: true,
        require_request_uri_registration: false,
      });
    });
  });
});
