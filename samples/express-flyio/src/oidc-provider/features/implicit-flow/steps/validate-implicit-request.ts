import {
  isImplicitResponseType,
  requireNonce,
  validateImplicitRedirectUri,
  validateImplicitResponseMode,
  type AuthorizationRequestParams,
  type ClientInfo,
  type ValidatedAuthorizationRequest,
} from '@maronn-openid-connect/core';
import type { AuthorizationResponseMode } from '../../../endpoints/authorize/response-mode.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'validate-implicit-request',
  endpoint: 'authorize',
  feature: 'implicit-flow',
  kind: 'validate',
  label: 'Validate the Implicit Flow request (response_mode, nonce, redirect_uri)',
  spec: 'OIDC Core 1.0 §3.2.2.1 / OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5',
  function: 'validateImplicitRequest',
  calls: ['isImplicitResponseType', 'validateImplicitResponseMode', 'requireNonce', 'validateImplicitRedirectUri'],
  consumes: ['validatedRequest', 'params', 'effectiveParams', 'client', 'responseMode'],
  optional: ['effectiveParams', 'responseMode'],
  produces: [],
  removable: false,
});

/**
 * What a request of the Implicit Flow (response_type=id_token or id_token
 * token) needs on top of validate-request, checked before the transaction is
 * created. Each check is a core function; every failure is a redirectable
 * invalid_request, sent back in the response mode of the request (the
 * fragment by default, OIDC Core 1.0 §3.2.2.6). A request of the code flow
 * passes untouched.
 *
 * - response_mode: query must not carry the tokens (OAuth 2.0 Multiple
 *   Response Type Encoding Practices §3 / §5 / §7), and a response mode the
 *   OP does not answer this request in (JARM's query.jwt, a value it does not
 *   know) is refused instead of being swapped for the fragment
 * - nonce is REQUIRED (OIDC Core 1.0 §3.2.2.1)
 * - redirect_uri: https, or http on a loopback host for a public (native)
 *   client (OIDC Core 1.0 §3.2.2.1)
 */
export function validateImplicitRequest(
  validatedRequest: ValidatedAuthorizationRequest,
  params: AuthorizationRequestParams,
  client: ClientInfo,
  responseMode: AuthorizationResponseMode | undefined,
): void {
  if (!isImplicitResponseType(validatedRequest.responseType)) return;
  const { redirectUri, state } = validatedRequest;

  const requested = (params as { response_mode?: unknown }).response_mode;
  validateImplicitResponseMode(
    typeof requested === 'string' ? requested : undefined,
    responseMode === undefined ? [] : [responseMode.name],
    redirectUri,
    state,
  );
  requireNonce(validatedRequest.nonce, redirectUri, state);
  validateImplicitRedirectUri(redirectUri, client.clientType, state);
}
