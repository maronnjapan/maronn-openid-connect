import type { TokenClientInfo } from '@maronn-openid-connect/core';
import { DeviceAuthorizationError } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { describe, expect, it } from 'vitest';
import { validateDeviceAuthorizationRequest } from './validate-request.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function clientWith(overrides: Partial<TokenClientInfo> = {}): TokenClientInfo {
  return { clientId: 'device-client', grantTypes: [DEVICE_GRANT], ...overrides };
}

describe('validateDeviceAuthorizationRequest', () => {
  describe('Grant registration', () => {
    // RFC 6749 §5.2: the client is not registered for the device_code grant.
    it('should reject a client not registered for the device_code grant with unauthorized_client', () => {
      expect(() =>
        validateDeviceAuthorizationRequest({ scope: 'openid' }, clientWith({ grantTypes: ['authorization_code'] })),
      ).toThrow(expect.objectContaining({ code: 'unauthorized_client' }));
    });
  });

  describe('Scope', () => {
    it('should return the requested scope values once each, in order', () => {
      expect(validateDeviceAuthorizationRequest({ scope: ' openid  profile openid ' }, clientWith())).toEqual([
        'openid',
        'profile',
      ]);
    });

    // A profile restriction of this OP: scope (and openid) is required, as at /authorize.
    it('should reject a request without scope with invalid_request', () => {
      expect(() => validateDeviceAuthorizationRequest({}, clientWith())).toThrow(DeviceAuthorizationError);
      expect(() => validateDeviceAuthorizationRequest({}, clientWith())).toThrow(
        expect.objectContaining({ code: 'invalid_request', errorDescription: 'Missing required parameter: scope' }),
      );
    });

    it('should reject a scope without openid with invalid_scope', () => {
      expect(() => validateDeviceAuthorizationRequest({ scope: 'profile' }, clientWith())).toThrow(
        expect.objectContaining({ code: 'invalid_scope', errorDescription: 'The openid scope is required' }),
      );
    });

    // RFC 7591 §2: a client registered with a scope list may only request those scopes.
    it('should reject a scope the client is not registered for with invalid_scope', () => {
      expect(() =>
        validateDeviceAuthorizationRequest(
          { scope: 'openid email phone' },
          clientWith({ scope: ['openid', 'email'] }),
        ),
      ).toThrow(
        expect.objectContaining({ code: 'invalid_scope', errorDescription: 'Client is not registered for scope: phone' }),
      );
    });
  });

  // OIDC Core 1.0 §11: offline_access that can never be granted is ignored, not an error.
  describe('offline_access', () => {
    it('should drop offline_access for a client not registered for refresh_token', () => {
      expect(validateDeviceAuthorizationRequest({ scope: 'openid offline_access' }, clientWith())).toEqual([
        'openid',
      ]);
    });

    it('should keep offline_access for a client registered for refresh_token', () => {
      expect(
        validateDeviceAuthorizationRequest(
          { scope: 'openid offline_access' },
          clientWith({ grantTypes: [DEVICE_GRANT, 'refresh_token'] }),
        ),
      ).toEqual(['openid', 'offline_access']);
    });
  });
});
