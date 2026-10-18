import { DEVICE_CODE_GRANT_TYPE } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { defineFeature } from '../../feature';

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628):
 * app/(device-authorization-grant)/ (device_authorization and the device
 * verification pages), and the (feature: device-authorization-grant) block of
 * the token endpoint (grant.ts).
 */
export const deviceAuthorizationGrant = defineFeature({
  id: 'device-authorization-grant',
  // RFC 8628 §4 metadata.
  discovery: (issuer) => ({
    device_authorization_endpoint: `${issuer}/device_authorization`,
  }),
  token: { grants: [DEVICE_CODE_GRANT_TYPE] },
});
