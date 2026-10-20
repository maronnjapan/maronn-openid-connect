import { defineFeature } from '../feature.js';
import { FRAGMENT_RESPONSE_MODE_NAME, fragmentResponseModeHandler } from './response-mode.js';
import { implicitResponseTypeHandler } from './response-type.js';

/**
 * Implicit Flow (OIDC Core 1.0 §3.2): response_type=id_token token and
 * id_token return the ID Token — with an access token for id_token token —
 * from the authorization endpoint itself, in the fragment of the redirect
 * URI, without a code, the token endpoint or a refresh token.
 *
 * - The resolve-fragment-response-mode block of endpoints/authorize/
 *   pipeline.ts answers such a request in the fragment (or in form_post when
 *   it asks for it), and the validate-implicit-request block requires nonce,
 *   keeps the tokens out of the query and checks the redirect_uri.
 * - authorize.responseTypes: validate-request accepts the two response types,
 *   discovery advertises them, and issue-authorization-code hands a request
 *   that needs no screen (prompt=none, SSO) to this feature, which returns the
 *   tokens in place of the code. At /consent the issue-implicit-response block
 *   does the same.
 *
 * A client uses the Implicit Flow only once it registers the response types
 * (responseTypes: ['id_token token', 'id_token']); every other client keeps
 * getting unauthorized_client for them. OAuth 2.1 and RFC 9700 §2.1.2 advise
 * against the implicit grant: prefer the Authorization Code Flow with PKCE,
 * and disable this feature when no client needs it.
 */
export const implicitFlow = defineFeature({
  id: 'implicit-flow',
  authorize: {
    responseTypes: [implicitResponseTypeHandler],
    responseModes: [fragmentResponseModeHandler],
  },
  discovery: () => ({
    // OIDC Discovery 1.0 §3: the fragment response mode next to query, and the
    // implicit grant type (OIDC Dynamic Client Registration 1.0 §2 pairs it
    // with the id_token response types).
    response_modes_supported: [FRAGMENT_RESPONSE_MODE_NAME],
    grant_types_supported: ['implicit'],
  }),
});
