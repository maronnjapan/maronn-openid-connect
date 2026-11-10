import { defineFeature } from '../../feature';

/** Token Introspection (RFC 7662): app/(introspection)/introspect/route.ts. */
export const introspection = defineFeature({
  id: 'introspection',
  // RFC 8414: the endpoint requires confidential client authentication.
  discovery: (issuer, config) => ({
    introspection_endpoint: `${issuer}/introspect`,
    introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'private_key_jwt'],
    // RFC 8414 §2: the algs of private_key_jwt (OIDC Core 1.0 §9), the same as the token endpoint's.
    introspection_endpoint_auth_signing_alg_values_supported: [...config.tokenEndpointAuthSigningAlgValuesSupported],
  }),
});
