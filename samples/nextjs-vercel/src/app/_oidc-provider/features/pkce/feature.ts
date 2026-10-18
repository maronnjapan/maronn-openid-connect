import { defineFeature } from '../../feature';

/**
 * PKCE (RFC 7636) for every authorization code request: the authorization
 * endpoint requires code_challenge with S256 (OAuth 2.1 §4.1.1 / §7.5).
 */
export const pkce = defineFeature({
  id: 'pkce',
  // OIDF Basic OP static-client compatibility (OAuth 2.1 makes PKCE mandatory):
  // set OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW=1 only for conformance runs.
  config: {
    allowNonPkceAuthorizationCodeFlow: process.env.OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW === '1',
  },
});
