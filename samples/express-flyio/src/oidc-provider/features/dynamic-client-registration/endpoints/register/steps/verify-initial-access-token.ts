import { readBearerToken } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { RegistrationEndpointError } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'verify-initial-access-token',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'validate',
  label: 'Check that the request may register',
  spec: 'OIDC Dynamic Client Registration 1.0 §3 / RFC 6750 §3.1',
  function: 'verifyRegistrationAccess',
  calls: ['readBearerToken', 'verifyInitialAccessToken'],
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * Ask the verifyInitialAccessToken of the config whether the request may
 * register, before the body is read (OIDC Dynamic Client Registration 1.0 §3).
 *
 * No function configured means open registration (RFC 7591 §3.1 SHOULD): every
 * request passes. With one, the request must carry a Bearer token (RFC 6750
 * §2.1) — 401 with a bare challenge without one, as RFC 6750 §3.1 asks for a
 * request without credentials — and the function decides whether that token
 * may register: 401 error="invalid_token" when it says no. Nothing here
 * verifies the token itself, and neither response reflects anything about
 * the expected token.
 */
export async function verifyRegistrationAccess(c: any): Promise<void> {
  const config = c.get('dynamicClientRegistrationConfig');
  if (config.verifyInitialAccessToken === undefined) return;
  const token = readBearerToken(c.req.header('Authorization'));
  if (token === undefined) {
    throw new RegistrationEndpointError({ status: 401, body: null, headers: { 'WWW-Authenticate': 'Bearer' } });
  }
  if (await config.verifyInitialAccessToken(token, config)) return;
  throw new RegistrationEndpointError({
    status: 401,
    body: null,
    headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
  });
}
