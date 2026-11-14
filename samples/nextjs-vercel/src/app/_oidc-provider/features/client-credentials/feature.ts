import { CLIENT_CREDENTIALS_GRANT_TYPE } from '@maronn-openid-connect/core';
import { defineFeature } from '../../feature';
import './config';

/**
 * The client credentials grant (RFC 6749 §4.4 / OAuth 2.1 §4.2), answered by
 * the (feature: client-credentials) block of the token endpoint (grant.ts): a
 * confidential client that registered the grant gets an access token for
 * itself, without an End-User. The token carries the client_id as its sub
 * (RFC 9068 §2.2), only scopes the client registered, never openid or
 * offline_access, and comes without a refresh token or an ID Token
 * (RFC 6749 §4.4.3).
 */
export const clientCredentials = defineFeature({
  id: 'client-credentials',
  config: {
    // RFC 8707 §2: no audience may be requested until the resources are listed
    // (fail safe). OIDC_CLIENT_CREDENTIALS_ALLOWED_AUDIENCES lists them,
    // separated by commas (the match takes every run of characters that is
    // neither a comma nor white space); a request without audience gets a
    // token whose aud is the issuer.
    clientCredentialsAllowedAudiences: process.env.OIDC_CLIENT_CREDENTIALS_ALLOWED_AUDIENCES?.match(/[^\s,]+/g) ?? [],
  },
  token: { grants: [CLIENT_CREDENTIALS_GRANT_TYPE] },
});
