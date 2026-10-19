/**
 * The Form Post Response Mode (OAuth 2.0 Form Post Response Mode §2): the
 * parameters of the authorization response and iss (RFC 9207 §2) become the
 * fields of an HTML form whose action is the client's redirect URI, and the
 * browser posts them (respondToClient() in authorize/response-mode.ts renders
 * the form). None of them appears in a URL, the browser history or a Referer
 * header (§4).
 */
import type {
  AuthorizationResponseMode,
  AuthorizationResponseModeHandler,
} from '../../../authorize/response-mode';

/** The response_mode value (Form Post Response Mode §2), and the name the transaction stores. */
export const FORM_POST_RESPONSE_MODE_NAME = 'form_post';

export function createFormPostResponseMode(input: { issuer: string }): AuthorizationResponseMode {
  return {
    name: FORM_POST_RESPONSE_MODE_NAME,
    async respond(redirectUri, parameters) {
      const fields: Record<string, string> = {};
      for (const [name, value] of Object.entries(parameters)) {
        if (value !== undefined) fields[name] = value;
      }
      // RFC 9207 §2: iss is a parameter of every authorization response, in
      // whichever response mode it is returned.
      fields['iss'] = input.issuer;
      // Form Post Response Mode §2: the action is the redirect URI, query included.
      return { method: 'form_post', action: redirectUri, fields };
    },
  };
}

/** /consent answers in form_post for a transaction whose authorization request asked for it. */
export const formPostResponseModeHandler: AuthorizationResponseModeHandler = {
  names: [FORM_POST_RESPONSE_MODE_NAME],
  async restore({ issuer }) {
    return createFormPostResponseMode({ issuer });
  },
};
