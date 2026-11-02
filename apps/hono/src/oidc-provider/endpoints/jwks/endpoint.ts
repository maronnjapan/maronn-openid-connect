import { defineEndpoint } from '../step.js';

/**
 * Publish the public keys the provider signs with (ID Tokens, access tokens,
 * UserInfo responses) as a JWK Set, which clients verify signatures against.
 */
export const endpoint = defineEndpoint({
  id: 'jwks',
  order: 20,
  label: 'JWKS',
  path: '/.well-known/jwks.json',
  methods: ['GET'],
  layer: 'metadata',
  group: { id: 'metadata', label: 'Metadata' },
  spec: 'OIDC Discovery 1.0 §3 (jwks_uri)',
  rearrangeable: true,
  steps: [
    'collect-public-keys',
    'export-jwks',
    'respond',
  ],
  edges: {
    chain: true,
  },
});
