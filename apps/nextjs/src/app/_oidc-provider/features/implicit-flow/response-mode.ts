/**
 * The fragment response mode (OAuth 2.0 Multiple Response Type Encoding
 * Practices §2.1): the parameters of the authorization response and iss (RFC
 * 9207 §2) go into the fragment of the redirect URI,
 * application/x-www-form-urlencoded (buildFragmentResponseUrl in core).
 *
 * It is the default response mode of the Implicit Flow, success and error
 * alike (OIDC Core 1.0 §3.2.2.5 / §3.2.2.6): the browser does not send the
 * fragment to the client's server or in a Referer header, so only the script
 * of the client's page reads the tokens. A request of the code flow gets it
 * with response_mode=fragment.
 */
import { buildFragmentResponseUrl } from '@maronn-openid-connect/core';
import type {
  AuthorizationResponseMode,
  AuthorizationResponseModeHandler,
} from '../../../authorize/response-mode';

/** The response_mode value (Multiple Response Type Encoding Practices §2.1), and the name the transaction stores. */
export const FRAGMENT_RESPONSE_MODE_NAME = 'fragment';

/** The fragment response mode of an issuer. */
export function createFragmentResponseMode(input: { issuer: string }): AuthorizationResponseMode {
  return {
    name: FRAGMENT_RESPONSE_MODE_NAME,
    async respond(redirectUri, parameters) {
      // RFC 9207 §2: iss is a parameter of every authorization response, in
      // whichever response mode it is returned.
      const location = buildFragmentResponseUrl(redirectUri, { ...parameters, iss: input.issuer });
      return { method: 'redirect', location };
    },
  };
}

/**
 * The response mode an Implicit Flow response is sent in: the one the request
 * asked for (form_post), or else the fragment. The tokens never travel in the
 * query (OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5 / §7).
 */
export function implicitResponseModeOf(
  responseMode: AuthorizationResponseMode | undefined,
  issuer: string,
): AuthorizationResponseMode {
  return responseMode ?? createFragmentResponseMode({ issuer });
}

/**
 * /consent answers in the fragment for a transaction whose authorization
 * request was of the Implicit Flow, or asked for response_mode=fragment.
 */
export const fragmentResponseModeHandler: AuthorizationResponseModeHandler = {
  names: [FRAGMENT_RESPONSE_MODE_NAME],
  async restore({ issuer }) {
    return createFragmentResponseMode({ issuer });
  },
};
