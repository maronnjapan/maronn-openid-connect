import { TokenError } from '@maronn-openid-connect/core';
import { DeviceAuthorizationError } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { DeviceAuthorizationEndpointError, noStore } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'device-authorization',
  feature: 'device-authorization-grant',
  kind: 'respond',
  label: 'Respond with the OAuth error',
  spec: 'RFC 6749 §5.2',
  function: 'respondDeviceAuthorizationError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * RFC 6749 §5.2 error shape. Authentication failures are core TokenErrors
 * (with their 401); everything the experimental package rejects is a
 * DeviceAuthorizationError.
 */
export function respondDeviceAuthorizationError(c: any, error: unknown): Response {
  noStore(c);
  if (error instanceof DeviceAuthorizationEndpointError) {
    for (const [name, value] of Object.entries(error.response.headers ?? {})) {
      c.header(name, value);
    }
    return c.json(error.response.body, error.response.status);
  }
  if (error instanceof DeviceAuthorizationError) {
    return c.json({ error: error.code, error_description: error.errorDescription }, error.statusCode);
  }
  if (error instanceof TokenError) {
    if (error.wwwAuthenticate) {
      c.header('WWW-Authenticate', error.wwwAuthenticate);
    }
    return c.json({ error: error.error, error_description: error.errorDescription }, error.statusCode);
  }
  return c.json({ error: 'server_error' }, 500);
}
