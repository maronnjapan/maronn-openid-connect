import {
  resolveRequestObjectParams,
  type AuthorizationRequestParams,
  type ResolvedRequestObjectParams,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../config';
import { clientKeyResolver, config } from '../../provider';

/**
 * Verify the signed Request Object (request parameter) against the keys the
 * client registered for the request_object purpose, and overlay its claims
 * onto the query parameters (OIDC Core 1.0 §6.1 / §6.3.2).
 *
 * The alg must be one of requestObjectSigningAlgValuesSupported, and the
 * requestObjectSigningAlg of a client that registered one (OIDC Core 1.0
 * §6.3.2); alg=none is accepted only when allowUnsignedRequestObject is
 * enabled (conformance compat). The keys are read only after the JOSE header
 * passed these checks, with the kid of the header as the hint, so a client
 * with a jwks_uri has it fetched again for a key it added (OIDC Core 1.0
 * §10.1.1), and a Request Object rejected anyway fetches nothing.
 */
export async function resolveRequestObject(
  params: AuthorizationRequestParams,
  client: RegisteredClient,
): Promise<ResolvedRequestObjectParams> {
  return resolveRequestObjectParams(params, {
    loadJwks: ({ kid }) => clientKeyResolver.findClientKeys(client.clientId, 'request_object', { kid }),
    supportedSigningAlgs: [...config.requestObjectSigningAlgValuesSupported],
    allowUnsigned: config.allowUnsignedRequestObject,
    requestObjectSigningAlg: client.requestObjectSigningAlg,
  });
}
