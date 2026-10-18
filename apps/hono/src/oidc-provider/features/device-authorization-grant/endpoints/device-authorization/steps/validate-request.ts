import { type TokenClientInfo, findUnregisteredClientScopes } from '@maronn-openid-connect/core';
import {
  DeviceAuthorizationError,
  applyOfflineAccessPolicy,
  validateDeviceAuthorizationScope,
  validateDeviceGrantAllowed,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { findUnsupportedScopes } from '../../../../../scopes.js';
import { features } from '../../../../enabled.js';
import { tokenGrantsOf } from '../../../../feature.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'validate-request',
  endpoint: 'device-authorization',
  feature: 'device-authorization-grant',
  kind: 'validate',
  label: 'Validate the grant registration and the scope',
  spec: 'RFC 8628 §3.1 / RFC 7591 §2 / OIDC Core 1.0 §11',
  function: 'validateDeviceAuthorizationRequest',
  calls: ['validateDeviceGrantAllowed', 'validateDeviceAuthorizationScope', 'findUnregisteredClientScopes', 'applyOfflineAccessPolicy'],
  consumes: ['params', 'client'],
  produces: ['scope'],
  removable: false,
});

/**
 * Validate the grant registration and the requested scope, and apply the
 * offline_access policy. RFC 8628 §3.1 / RFC 7591 §2 / OIDC Core 1.0 §11
 *
 * Each check is an independent function from the experimental package or
 * core. Delete a call to drop that validation, or insert your own logic
 * between steps.
 */
export function validateDeviceAuthorizationRequest(
  params: Record<string, string>,
  client: TokenClientInfo,
): string[] {
  // RFC 6749 §5.2: the client must be registered for the device_code grant.
  validateDeviceGrantAllowed(client);

  // RFC 8628 §3.1 leaves scope OPTIONAL, but this OP requires scope and openid
  // everywhere (same rule as /authorize). Requests that omit scope — legal per
  // RFC 8628 — are therefore rejected: a known, deliberate profile restriction.
  const requestedScope = validateDeviceAuthorizationScope(params['scope']);

  // RFC 7591 §2: a client registered with a scope list (client.scope) may only
  // request those scopes, the same rule as /authorize.
  const unregisteredScopes = findUnregisteredClientScopes(requestedScope, client.scope);
  if (unregisteredScopes.length > 0) {
    throw new DeviceAuthorizationError(
      'invalid_scope',
      'Client is not registered for scope: ' + unregisteredScopes.join(' '),
    );
  }

  // OIDC Core 1.0 §11: drop offline_access when it could never be granted:
  // the client is not registered for refresh_token, or the provider has no
  // refresh_token grant (the refresh-token feature is not generated).
  const scope = applyOfflineAccessPolicy(requestedScope, {
    client,
    refreshTokenFeatureEnabled: tokenGrantsOf(features).includes('refresh_token'),
  });

  // RFC 6749 §3.3: reject a scope this OP never declared, the same way
  // /authorize does. Checked after applyOfflineAccessPolicy so an
  // offline_access that the policy already dropped stays ignored rather than
  // becoming invalid_scope (OIDC Core 1.0 §11).
  const unsupportedScopes = findUnsupportedScopes(scope);
  if (unsupportedScopes.length > 0) {
    throw new DeviceAuthorizationError(
      'invalid_scope',
      'Unsupported scope: ' + unsupportedScopes.join(' '),
    );
  }

  return scope;
}
