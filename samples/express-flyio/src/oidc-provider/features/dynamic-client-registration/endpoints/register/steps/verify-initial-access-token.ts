import { verifyInitialAccessToken } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { RegistrationEndpointError } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'verify-initial-access-token',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'validate',
  label: 'Check the initial access token, if one is required',
  spec: 'OIDC Dynamic Client Registration 1.0 §3 / RFC 6750 §3.1',
  function: 'verifyRegistrationAccess',
  calls: ['verifyInitialAccessToken'],
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * Check the initial access token when one is configured, before the body is
 * read. OIDC Dynamic Client Registration 1.0 §3 / RFC 6750 §3.1
 *
 * The two 401 shapes follow RFC 6750 §3.1: no error code without credentials,
 * and error="invalid_token" for presented-but-wrong ones. Neither reflects
 * anything about the expected token.
 */
export async function verifyRegistrationAccess(c: any): Promise<void> {
  const config = c.get('dynamicClientRegistrationConfig');
  if (config.initialAccessToken === undefined) return;
  const authorization = c.req.header('Authorization');
  if (authorization === undefined) {
    throw new RegistrationEndpointError({ status: 401, body: null, headers: { 'WWW-Authenticate': 'Bearer' } });
  }
  const accepted = await verifyInitialAccessToken(authorization, config.initialAccessToken);
  if (!accepted) {
    throw new RegistrationEndpointError({
      status: 401,
      body: null,
      headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
    });
  }
}
