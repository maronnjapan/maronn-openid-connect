import {
  type ClientKeyResolver,
  resolveRequestObjectParams,
  type ResolvedRequestObjectParams,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../../config.js';
import type { AuthorizationRequestInput } from '../../../endpoints/authorize/outcome.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'resolve-request-object',
  endpoint: 'authorize',
  feature: 'request-object',
  kind: 'resolve',
  label: 'Verify the Request Object and overlay its claims',
  spec: 'OIDC Core 1.0 §6.1',
  function: 'resolveRequestObject',
  consumes: ['params', 'client'],
  produces: ['effectiveParams', 'requestObjectClaims'],
  removable: false,
});

/**
 * Verify the signed Request Object (request parameter) against the keys the
 * client registered for the request_object purpose and overlay its claims
 * onto the query parameters.
 *
 * The alg must be one of config.requestObjectSigningAlgValuesSupported, and
 * the requestObjectSigningAlg of a client that registered one (OIDC Core 1.0
 * §6.3.2); alg=none is accepted only when config.allowUnsignedRequestObject is
 * enabled (conformance compat). The keys are read only after the JOSE header
 * passed these checks, with the kid of the header as the hint, so a client
 * with a jwks_uri has it fetched again for a key it added (OIDC Core 1.0
 * §10.1.1), and a Request Object rejected anyway fetches nothing.
 * effectiveParams is what every later step validates.
 *
 * @spec OIDC Core 1.0 §6.1 / §6.3.2
 */
export async function resolveRequestObject(
  c: any,
  params: AuthorizationRequestInput,
  client: RegisteredClient,
): Promise<ResolvedRequestObjectParams> {
  const config = c.get('config');
  const clientKeyResolver: ClientKeyResolver = c.get('clientKeyResolver');
  return resolveRequestObjectParams(params, {
    loadJwks: ({ kid }) => clientKeyResolver.findClientKeys(client.clientId, 'request_object', { kid }),
    supportedSigningAlgs: [...config.requestObjectSigningAlgValuesSupported],
    allowUnsigned: config.allowUnsignedRequestObject,
    requestObjectSigningAlg: client.requestObjectSigningAlg,
  });
}
