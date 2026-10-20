import { HYBRID_RESPONSE_TYPES } from '@maronn-openid-connect/core';
import { defineFeature } from '../../feature';

/**
 * Hybrid Flow (OIDC Core 1.0 §3.3): response_type=code id_token, code token
 * and code id_token token return the authorization code together with the ID
 * Token and/or an access token from the authorization endpoint itself, in the
 * fragment of the redirect URI. The client then exchanges the code at the
 * token endpoint as in the Authorization Code Flow (§3.3.3).
 *
 * - authorize.responseTypes: the authorization endpoint accepts the three
 *   response types and discovery advertises them.
 * - The (feature: hybrid-flow) blocks of authorize/route.ts keep the tokens
 *   out of the query, require nonce when an ID Token is returned from the
 *   authorization endpoint (code id_token, code id_token token), and return
 *   the code with the tokens for a request that needs no screen (prompt=none,
 *   SSO). The block of consent/decision/route.ts does the same after the
 *   consent screen. The fragment response mode itself comes from the
 *   implicit-flow feature, which this feature requires, together with the
 *   way it issues the tokens.
 * - The code, the access token of the authorization endpoint and the tokens
 *   the token endpoint later issues for the code belong to one grant: a code
 *   replay or a withdrawn consent revokes them together.
 *
 * A client uses the Hybrid Flow only once it registers the response types
 * (responseTypes: ['code id_token token', 'code id_token', 'code token']);
 * every other client keeps getting unauthorized_client for them. PKCE binds
 * the code as in the code flow.
 */
export const hybridFlow = defineFeature({
  id: 'hybrid-flow',
  authorize: {
    responseTypes: HYBRID_RESPONSE_TYPES,
  },
  discovery: () => ({
    // OIDC Dynamic Client Registration 1.0 §2 pairs the hybrid response types
    // with the authorization_code and implicit grant types. OIDC Core 1.0
    // §3.3.2.11: the ID Token returned beside a code carries c_hash.
    grant_types_supported: ['implicit'],
    claims_supported: ['c_hash'],
  }),
});
