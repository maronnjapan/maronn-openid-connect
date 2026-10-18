import { defineFeature } from '../../feature';

/** Token Revocation (RFC 7009): app/(revocation)/revoke/route.ts. */
export const revocation = defineFeature({
  id: 'revocation',
  // RFC 8414: confidential clients authenticate with their registered method.
  discovery: (issuer) => ({
    revocation_endpoint: `${issuer}/revoke`,
    revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  }),
});
