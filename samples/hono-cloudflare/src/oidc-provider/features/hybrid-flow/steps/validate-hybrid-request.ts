import {
  isHybridResponseType,
  requireHybridNonce,
  validateHybridResponseMode,
  type AuthorizationRequestParams,
  type ValidatedAuthorizationRequest,
} from '@maronn-openid-connect/core';
import type { AuthorizationResponseMode } from '../../../endpoints/authorize/response-mode.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'validate-hybrid-request',
  endpoint: 'authorize',
  feature: 'hybrid-flow',
  kind: 'validate',
  label: 'Validate the Hybrid Flow request (response_mode, nonce)',
  spec: 'OIDC Core 1.0 §3.3.2.1 / §3.3.2.11 / OAuth 2.0 Multiple Response Type Encoding Practices §5',
  function: 'validateHybridRequest',
  calls: ['isHybridResponseType', 'validateHybridResponseMode', 'requireHybridNonce'],
  consumes: ['validatedRequest', 'params', 'effectiveParams', 'responseMode'],
  optional: ['effectiveParams', 'responseMode'],
  produces: [],
  removable: false,
});

/**
 * What a request of the Hybrid Flow (response_type=code id_token, code token
 * or code id_token token) needs on top of validate-request, checked before
 * the transaction is created. Each check is a core function; every failure
 * is a redirectable invalid_request, sent back in the response mode of the
 * request (the fragment by default, OIDC Core 1.0 §3.3.2.6). A request of
 * the code flow or of the Implicit Flow passes untouched.
 *
 * - response_mode: query must not carry the tokens (OAuth 2.0 Multiple
 *   Response Type Encoding Practices §5 / §7), and a response mode the OP
 *   does not answer this request in (JARM's query.jwt, a value it does not
 *   know) is refused instead of being swapped for the fragment
 * - nonce is REQUIRED when the authorization endpoint returns an ID Token
 *   (code id_token, code id_token token; OIDC Core 1.0 §3.3.2.11), and stays
 *   optional for code token as in the code flow
 *
 * The redirect_uri rules are those of the code flow (§3.3.2.1 refers to
 * §3.1.2.1), and PKCE binds the code as validate-request checked it.
 */
export function validateHybridRequest(
  validatedRequest: ValidatedAuthorizationRequest,
  params: AuthorizationRequestParams,
  responseMode: AuthorizationResponseMode | undefined,
): void {
  if (!isHybridResponseType(validatedRequest.responseType)) return;
  const { redirectUri, state } = validatedRequest;

  const requested = (params as { response_mode?: unknown }).response_mode;
  validateHybridResponseMode(
    typeof requested === 'string' ? requested : undefined,
    responseMode === undefined ? [] : [responseMode.name],
    redirectUri,
    state,
  );
  requireHybridNonce(validatedRequest.responseType, validatedRequest.nonce, redirectUri, state);
}
