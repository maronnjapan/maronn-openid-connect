import { TokenError } from '@maronn-openid-connect/core';
import { BackchannelAuthenticationError } from '@maronn-openid-connect/experimental/ciba';
import { BackchannelAuthenticationEndpointError, noStore } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'backchannel-authentication',
  feature: 'ciba',
  kind: 'respond',
  label: 'Respond with the OAuth error',
  spec: 'CIBA Core 1.0 §13',
  function: 'respondBackchannelAuthenticationError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * CIBA §13 / RFC 6749 §5.2 error shape. Authentication failures are core
 * TokenErrors (with their 401); everything the experimental package rejects
 * is a BackchannelAuthenticationError.
 */
export function respondBackchannelAuthenticationError(c: any, error: unknown): Response {
  noStore(c);
  if (error instanceof BackchannelAuthenticationEndpointError) {
    for (const [name, value] of Object.entries(error.response.headers ?? {})) {
      c.header(name, value);
    }
    return c.json(error.response.body, error.response.status);
  }
  if (error instanceof BackchannelAuthenticationError) {
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
