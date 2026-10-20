import { defaultResponseModeOf, type AuthorizationRequestParams } from '@maronn-openid-connect/core';
import type { AuthorizationResponseMode } from '../../../endpoints/authorize/response-mode.js';
import { step } from '../../../endpoints/step.js';
import { createFragmentResponseMode, FRAGMENT_RESPONSE_MODE_NAME } from '../response-mode.js';

export const meta = step({
  id: 'resolve-fragment-response-mode',
  endpoint: 'authorize',
  feature: 'implicit-flow',
  kind: 'resolve',
  label: 'Answer the Implicit Flow in the fragment',
  spec: 'OAuth 2.0 Multiple Response Type Encoding Practices §2.1 / §3 / §5',
  function: 'resolveFragmentResponseContext',
  calls: ['defaultResponseModeOf'],
  consumes: ['params', 'effectiveParams', 'issuer'],
  optional: ['effectiveParams'],
  produces: ['responseMode'],
  removable: false,
});

/**
 * Answer in the fragment response mode when that is the default of the
 * request's response_type — any response type that returns an ID Token or an
 * access token, the Implicit Flow's id_token and id_token token among them
 * (Multiple Response Type Encoding Practices §3 / §5) — or when the request
 * asked for response_mode=fragment (§2.1).
 *
 * Runs after the blocks of the response modes a request asks for by name
 * (form_post, JARM), each of which assigns the response mode only while it is
 * unset, so a request of the Implicit Flow with response_mode=form_post is
 * posted. Its errors go back in the fragment from here on (OIDC Core 1.0
 * §3.2.2.6), the rejection of response_mode=query included
 * (validate-implicit-request). Any other request is left to the plain query
 * response: undefined.
 */
export function resolveFragmentResponseContext(
  params: AuthorizationRequestParams,
  issuer: string,
): AuthorizationResponseMode | undefined {
  const requested = (params as { response_mode?: unknown }).response_mode;
  if (requested === FRAGMENT_RESPONSE_MODE_NAME) return createFragmentResponseMode({ issuer });
  if (params.response_type !== undefined && defaultResponseModeOf(params.response_type) === 'fragment') {
    return createFragmentResponseMode({ issuer });
  }
  return undefined;
}
