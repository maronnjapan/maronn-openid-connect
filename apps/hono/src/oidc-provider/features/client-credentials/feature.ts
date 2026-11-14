import { CLIENT_CREDENTIALS_GRANT_TYPE } from '@maronn-openid-connect/core';
import { defineFeature } from '../feature.js';
import './config.js';

/**
 * The client credentials grant (RFC 6749 §4.4 / OAuth 2.1 §4.2).
 *
 * The token endpoint answers grant_type=client_credentials in the
 * dispatch-client-credentials block of endpoints/token/pipeline.ts: a
 * confidential client that registered the grant (grantTypes) gets an access
 * token for itself, without an End-User. The token carries the client_id as
 * its sub (RFC 9068 §2.2), only scopes the client registered (scope), never
 * openid or offline_access, and comes without a refresh token or an ID Token
 * (RFC 6749 §4.4.3). Without the feature the grant is rejected with
 * unsupported_grant_type.
 */
export const clientCredentials = defineFeature({
  id: 'client-credentials',
  // RFC 8707 §2: no audience may be requested until the resources are listed
  // (fail safe). A request without audience gets a token whose aud is the issuer.
  config: { clientCredentialsAllowedAudiences: [] },
  token: { grants: [CLIENT_CREDENTIALS_GRANT_TYPE] },
});
