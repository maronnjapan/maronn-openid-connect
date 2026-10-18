import {
  AuthorizationError,
  type AuthorizationErrorCode,
  type AuthorizationRequestParams,
} from '@maronn-openid-connect/core';
import {
  PushedRequestUriError,
  assertPushedRequestUsed,
  resolvePushedRequestUri,
} from '@maronn-openid-connect/experimental/par';
import { parConfig } from './config';
import { parStore } from './store';

/** The parameters of an authorization request as the endpoint reads them. */
type AuthorizationRequestInput = Record<string, string> & AuthorizationRequestParams;

/**
 * Expand a request_uri of the form urn:ietf:params:oauth:request_uri:<ref>
 * into the parameters pushed to /par (RFC 9126 §4). The reference is single
 * use and short lived, so reloading the authorization URL fails with
 * invalid_request_uri by design. Anything that is not such a URN (absent, or
 * an OIDC Core §6.2 URL) is left as it is, and the authorization endpoint
 * rejects it with request_uri_not_supported.
 */
export async function resolvePushedAuthorizationRequest(
  params: AuthorizationRequestInput,
): Promise<AuthorizationRequestInput> {
  try {
    // RFC 9126 §5: when require_pushed_authorization_requests is on, an
    // authorization request that did not go through /par is rejected outright.
    if (parConfig.requirePushedAuthorizationRequests) {
      assertPushedRequestUsed(params);
    }
    const pushedParams = await resolvePushedRequestUri({ params, store: parStore });
    if (pushedParams === null) return params;
    if (typeof pushedParams['client_id'] !== 'string') {
      // Defensive: client_id was validated when the request was pushed.
      throw new PushedRequestUriError('invalid_request_uri', 'The request_uri is invalid, expired, or has already been used');
    }
    return pushedParams as AuthorizationRequestInput;
  } catch (error) {
    // RFC 9126 §4 / OIDC Core 1.0 §3.1.2.6: a request_uri that cannot be
    // resolved leaves us without a verified redirect_uri, so this error is
    // NEVER redirected (RFC 6749 §4.1.2.1): an AuthorizationError without a
    // redirect URI stays on the OP. Every failure kind (unknown / used /
    // expired / another client's) carries the identical code and description
    // so the response cannot be used as an existence oracle.
    if (error instanceof PushedRequestUriError) {
      throw new AuthorizationError(error.code as AuthorizationErrorCode, error.errorDescription);
    }
    throw error;
  }
}
