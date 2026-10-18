import { AuthorizationError, type AuthorizationErrorCode } from '@maronn-openid-connect/core';
import {
  PushedRequestUriError,
  assertPushedRequestUsed,
  resolvePushedRequestUri,
} from '@maronn-openid-connect/experimental/par';
import { parConfig } from '../config.js';
import { type AuthorizationRequestInput, isAuthorizationRequestParams } from '../../../endpoints/authorize/outcome.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'resolve-pushed-request',
  endpoint: 'authorize',
  feature: 'par',
  kind: 'resolve',
  label: 'Expand the pushed request_uri',
  spec: 'RFC 9126 §4 / §5',
  function: 'resolvePushedAuthorizationRequest',
  calls: ['assertPushedRequestUsed', 'resolvePushedRequestUri'],
  consumes: ['params'],
  produces: ['params'],
  removable: false,
});

/**
 * EXPERIMENTAL — Pushed Authorization Requests (RFC 9126 §4 / §5).
 *
 * Expands a request_uri of the form urn:ietf:params:oauth:request_uri:<ref>
 * into the parameters pushed to /par. The reference is single use and short
 * lived, so a reload of this URL fails with invalid_request_uri by design.
 * Anything that is not a URN (absent, or an OIDC Core §6.2 URL) is left to the
 * normal pipeline, which rejects it with request_uri_not_supported.
 *
 * A request_uri that does not resolve fails with an AuthorizationError that
 * authorizationErrorOutcome() keeps on the OP: without a resolved request
 * there is no verified redirect_uri.
 */
export async function resolvePushedAuthorizationRequest(
  c: any,
  params: AuthorizationRequestInput,
): Promise<AuthorizationRequestInput> {
  const parStore = c.get('parStore');
  try {
    // RFC 9126 §5: when require_pushed_authorization_requests is on, an
    // authorization request that did not go through /par is rejected outright.
    if (parConfig.requirePushedAuthorizationRequests) {
      assertPushedRequestUsed(params);
    }
    const pushedParams = await resolvePushedRequestUri({ params, store: parStore });
    if (pushedParams === null) return params;
    if (!isAuthorizationRequestParams(pushedParams)) {
      // Defensive: client_id was validated when the request was pushed.
      throw new PushedRequestUriError('invalid_request_uri', 'The request_uri is invalid, expired, or has already been used');
    }
    return pushedParams;
  } catch (error) {
    // RFC 9126 §4 / OIDC Core 1.0 §3.1.2.6: a request_uri that cannot be
    // resolved leaves us without a verified redirect_uri, so this error is
    // NEVER redirected (RFC 6749 §4.1.2.1): an AuthorizationError without a
    // redirect URI stays on the OP. Every failure kind (unknown / used /
    // expired / wrong client) carries the identical code and description so
    // the response cannot be used as an existence oracle.
    if (error instanceof PushedRequestUriError) {
      throw new AuthorizationError(error.code as AuthorizationErrorCode, error.errorDescription);
    }
    throw error;
  }
}
