import { CIBA_GRANT_TYPE } from '@maronn-openid-connect/experimental/ciba';
import { defineFeature } from '../../feature';

/**
 * Client-Initiated Backchannel Authentication (CIBA Core 1.0, poll mode):
 * app/(ciba)/ (backchannel_authentication and the authentication device
 * pages), and the (feature: ciba) block of the token endpoint (grant.ts).
 */
export const ciba = defineFeature({
  id: 'ciba',
  // CIBA Core 1.0 §4 metadata. Only the poll delivery mode is implemented.
  discovery: (issuer) => ({
    backchannel_token_delivery_modes_supported: ['poll'],
    backchannel_authentication_endpoint: `${issuer}/backchannel_authentication`,
  }),
  token: { grants: [CIBA_GRANT_TYPE] },
});
