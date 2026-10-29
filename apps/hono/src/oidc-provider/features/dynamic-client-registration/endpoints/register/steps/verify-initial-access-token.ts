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
  calls: ['verifyInitialAccessToken'],
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * Ask the registration policy whether the request may register, before the
 * body is read. OIDC Dynamic Client Registration 1.0 §3 / RFC 6750 §3.1
 *
 * verifyInitialAccessToken of the config (policy.ts as generated: open
 * registration until initialAccessToken is set, then the configured Bearer
 * token in constant time) decides. The two 401 shapes follow RFC 6750 §3.1:
 * no error code without credentials, and error="invalid_token" for
 * presented-but-refused ones. Neither reflects anything about the expected
 * token.
 */
export async function verifyRegistrationAccess(c: any): Promise<void> {
  const config = c.get('dynamicClientRegistrationConfig');
  const authorization = c.req.header('Authorization');
  if (await config.verifyInitialAccessToken(authorization, config)) return;
  if (authorization === undefined) {
    throw new RegistrationEndpointError({ status: 401, body: null, headers: { 'WWW-Authenticate': 'Bearer' } });
  }
  throw new RegistrationEndpointError({
    status: 401,
    body: null,
    headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
  });
}
