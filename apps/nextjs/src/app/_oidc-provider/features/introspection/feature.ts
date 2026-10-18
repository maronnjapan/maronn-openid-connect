import { defineFeature } from '../../feature';

/** Token Introspection (RFC 7662): app/(introspection)/introspect/route.ts. */
export const introspection = defineFeature({
  id: 'introspection',
  // RFC 8414: the endpoint requires confidential client authentication.
  discovery: (issuer) => ({
    introspection_endpoint: `${issuer}/introspect`,
    introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  }),
});
