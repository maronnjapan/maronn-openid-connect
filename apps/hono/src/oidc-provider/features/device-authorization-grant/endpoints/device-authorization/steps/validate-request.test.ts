import type { TokenClientInfo } from '@maronn-openid-connect/core';
import { DeviceAuthorizationError } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { describe, expect, it } from 'vitest';
import { contextOf, requestTo } from '../../../../../../test-support/context.js';
import { createProviderConfig, type ProviderConfig } from '../../../../../config.js';
import { validateDeviceAuthorizationRequest } from './validate-request.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function clientWith(overrides: Partial<TokenClientInfo> = {}): TokenClientInfo {
  return { clientId: 'device-client', grantTypes: [DEVICE_GRANT], ...overrides };
}

/** A request context with the settings of the provider (the defaults, unless overridden). */
function contextWith(config: Partial<ProviderConfig> = {}) {
  return contextOf(requestTo('/device_authorization'), { config: createProviderConfig(config) });
}

/** A provider that accepts OpenID Connect requests only (requireOpenIdScope). */
const OPENID_ONLY = { requireOpenIdScope: true };

describe('validateDeviceAuthorizationRequest', () => {
  describe('Grant registration', () => {
    // RFC 6749 §5.2: the client is not registered for the device_code grant.
    it('should reject a client not registered for the device_code grant with unauthorized_client', () => {
      expect(() =>
        validateDeviceAuthorizationRequest(contextWith(), { scope: 'openid' }, clientWith({ grantTypes: ['authorization_code'] })),
      ).toThrow(expect.objectContaining({ code: 'unauthorized_client' }));
    });
  });

  describe('Scope', () => {
    it('should return the requested scope values once each, in order', () => {
      expect(validateDeviceAuthorizationRequest(contextWith(), { scope: ' openid  profile openid ' }, clientWith())).toEqual([
        'openid',
        'profile',
      ]);
    });

    // RFC 8628 §3.1: the device authorization grant is an OAuth 2.0 grant; the
    // provider accepts a request without openid unless requireOpenIdScope is set.
    it('should accept a scope without openid as an OAuth 2.0 request', () => {
      expect(validateDeviceAuthorizationRequest(contextWith(), { scope: 'reports.read' }, clientWith())).toEqual([
        'reports.read',
      ]);
    });

    // RFC 6749 §3.3: the provider defines no default scope, so a request without scope fails with invalid_scope.
    it('should reject a request without scope with invalid_scope', () => {
      expect(() => validateDeviceAuthorizationRequest(contextWith(), {}, clientWith())).toThrow(DeviceAuthorizationError);
      expect(() => validateDeviceAuthorizationRequest(contextWith(), {}, clientWith())).toThrow(
        expect.objectContaining({
          code: 'invalid_scope',
          errorDescription: 'Missing scope: this authorization server defines no default scope',
        }),
      );
    });

    // requireOpenIdScope: the provider accepts OpenID Connect requests only, as at /authorize.
    describe('with requireOpenIdScope', () => {
      it('should reject a request without scope with invalid_request', () => {
        expect(() => validateDeviceAuthorizationRequest(contextWith(OPENID_ONLY), {}, clientWith())).toThrow(
          expect.objectContaining({ code: 'invalid_request', errorDescription: 'Missing required parameter: scope' }),
        );
      });

      it('should reject a scope without openid with invalid_scope', () => {
        expect(() =>
          validateDeviceAuthorizationRequest(contextWith(OPENID_ONLY), { scope: 'profile' }, clientWith()),
        ).toThrow(
          expect.objectContaining({ code: 'invalid_scope', errorDescription: 'The openid scope is required' }),
        );
      });

      it('should accept a scope with openid', () => {
        expect(
          validateDeviceAuthorizationRequest(contextWith(OPENID_ONLY), { scope: 'openid profile' }, clientWith()),
        ).toEqual(['openid', 'profile']);
      });
    });

    // RFC 7591 §2: a client registered with a scope list may only request those scopes.
    it('should reject a scope the client is not registered for with invalid_scope', () => {
      expect(() =>
        validateDeviceAuthorizationRequest(
          contextWith(),
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
      expect(validateDeviceAuthorizationRequest(contextWith(), { scope: 'openid offline_access' }, clientWith())).toEqual([
        'openid',
      ]);
    });

    it('should keep offline_access for a client registered for refresh_token', () => {
      expect(
        validateDeviceAuthorizationRequest(
          contextWith(),
          { scope: 'openid offline_access' },
          clientWith({ grantTypes: [DEVICE_GRANT, 'refresh_token'] }),
        ),
      ).toEqual(['openid', 'offline_access']);
    });
  });
});
