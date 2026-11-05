import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../../test-support/context';
import { createProviderConfig } from '../../config';
import { discoveryOf } from '../../feature';
import { requestObject } from './feature';

describe('requestObject', () => {
  describe('config', () => {
    // OIDC Core 1.0 §6.1: signed Request Objects only, unless enabled for conformance.
    // D-20: the algs core verifies (RFC 7518 §3.3 / §3.4).
    it('should default allowUnsignedRequestObject to false and accept the algs core verifies', () => {
      expect(requestObject.config).toEqual({
        allowUnsignedRequestObject: false,
        requestObjectSigningAlgValuesSupported: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
      });
    });
  });

  // OIDC Discovery 1.0 §3.
  describe('discovery', () => {
    it('should advertise the request parameter with the accepted algs', () => {
      expect(discoveryOf([requestObject], {}, TEST_ISSUER, createProviderConfig({ issuer: TEST_ISSUER }))).toEqual({
        request_parameter_supported: true,
        request_object_signing_alg_values_supported: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
      });
    });

    // D-21: none is advertised only when unsigned Request Objects are accepted.
    it('should also advertise none when unsigned Request Objects are accepted', () => {
      const config = createProviderConfig({ issuer: TEST_ISSUER, allowUnsignedRequestObject: true });

      expect(discoveryOf([requestObject], {}, TEST_ISSUER, config)).toEqual({
        request_parameter_supported: true,
        request_object_signing_alg_values_supported: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'none'],
      });
    });

    // UC-6: the list is a setting.
    it('should advertise the algs of requestObjectSigningAlgValuesSupported', () => {
      const config = createProviderConfig({ issuer: TEST_ISSUER, requestObjectSigningAlgValuesSupported: ['RS256'] });

      expect(discoveryOf([requestObject], {}, TEST_ISSUER, config)).toEqual({
        request_parameter_supported: true,
        request_object_signing_alg_values_supported: ['RS256'],
      });
    });
  });
});
