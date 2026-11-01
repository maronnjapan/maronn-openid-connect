import {
  resolveRequestObjectParams,
  type AuthorizationRequestParams,
  type ClientInfo,
  type ResolvedRequestObjectParams,
} from '@maronn-openid-connect/core';
import { clientKeyResolver, config } from '../../provider';
import { requestObjectConfig } from './config';

/**
 * Resolve the Request Object of the request and overlay its claims onto the
 * query parameters (OIDC Core 1.0 §6.1 / §6.2 / §6.3.2).
 *
 * - request (by value, §6.1): the signed JWS is verified against the keys the
 *   client registered for the request_object purpose.
 * - request_uri (by reference, §6.2): the URL is matched against the
 *   request_uris the client registered (client.requestUris) while
 *   config.requireRequestUriRegistration is on, fetched with a GET
 *   (requestObjectConfig.requestUriFetch, or globalThis.fetch), and the
 *   retrieved JWT is verified the same way. A request_uri that is not
 *   registered, cannot be fetched or returns no Request Object is
 *   invalid_request_uri, kept on the OP (§3.1.2.6). A pushed request_uri of
 *   RFC 9126 (a URN) never reaches here: the par feature expands it before
 *   the client is resolved.
 *
 * RS256 is required; alg=none is accepted only when allowUnsignedRequestObject
 * is enabled (conformance compat). A client registered with
 * request_object_signing_alg is held to that alg (OIDC Dynamic Client
 * Registration 1.0 §2). The keys are read only for a request that carries a
 * Request Object.
 */
export async function resolveRequestObject(
  params: AuthorizationRequestParams,
  client: ClientInfo,
): Promise<ResolvedRequestObjectParams> {
  const jwks = params.request === undefined && params.request_uri === undefined
    ? undefined
    : await clientKeyResolver.findClientKeys(client.clientId, 'request_object');
  return resolveRequestObjectParams(params, {
    jwks,
    allowUnsigned: config.allowUnsignedRequestObject,
    requiredSigningAlg: client.requestObjectSigningAlg,
    requestUri: {
      registeredRequestUris: client.requestUris,
      requireRegistration: config.requireRequestUriRegistration,
      fetch: requestObjectConfig.requestUriFetch,
    },
  });
}
