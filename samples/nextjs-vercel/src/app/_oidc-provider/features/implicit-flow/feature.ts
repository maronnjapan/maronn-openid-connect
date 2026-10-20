import { IMPLICIT_RESPONSE_TYPES } from '@maronn-openid-connect/core';
import { defineFeature } from '../../feature';
import { FRAGMENT_RESPONSE_MODE_NAME, fragmentResponseModeHandler } from './response-mode';

/**
 * Implicit Flow (OIDC Core 1.0 §3.2): response_type=id_token token and
 * id_token return the ID Token — with an access token for id_token token —
 * from the authorization endpoint itself, in the fragment of the redirect
 * URI, without a code, the token endpoint or a refresh token.
 *
 * - authorize.responseTypes: the authorization endpoint accepts the two
 *   response types and discovery advertises them.
 * - The (feature: implicit-flow) blocks of authorize/route.ts answer such a
 *   request in the fragment (or in form_post when it asks for it), require
 *   nonce, keep the tokens out of the query, check the redirect_uri, and
 *   return the tokens in place of the code for a request that needs no screen
 *   (prompt=none, SSO). The block of consent/decision/route.ts does the same
 *   after the consent screen.
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
    responseTypes: IMPLICIT_RESPONSE_TYPES,
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
