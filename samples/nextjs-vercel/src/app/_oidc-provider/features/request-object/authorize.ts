import {
  resolveRequestObjectParams,
  type AuthorizationRequestParams,
  type ClientInfo,
  type ResolvedRequestObjectParams,
} from '@maronn-openid-connect/core';
import { clientKeyResolver, config } from '../../provider';

/**
 * Verify the signed Request Object (request parameter) against the keys the
 * client registered for the request_object purpose, and overlay its claims
 * onto the query parameters (OIDC Core 1.0 §6.1 / §6.3.2). RS256 is required;
 * alg=none is accepted only when allowUnsignedRequestObject is enabled
 * (conformance compat). The keys are read only for a request that carries a
 * Request Object.
 */
export async function resolveRequestObject(
  params: AuthorizationRequestParams,
  client: ClientInfo,
): Promise<ResolvedRequestObjectParams> {
  const jwks = params.request === undefined
    ? undefined
    : await clientKeyResolver.findClientKeys(client.clientId, 'request_object');
  return resolveRequestObjectParams(params, { jwks, allowUnsigned: config.allowUnsignedRequestObject });
}
