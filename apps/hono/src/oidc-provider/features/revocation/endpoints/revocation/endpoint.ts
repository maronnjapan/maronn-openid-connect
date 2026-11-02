import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * Revoke a token presented by the client it was issued to (a refresh token
 * together with the access tokens of its grant) and answer 200 with an empty
 * body, also for a token the provider does not know.
 *
 * @spec RFC 7009 §2
 */
export const endpoint = defineEndpoint({
  id: 'revocation',
  order: 100,
  label: 'Token revocation endpoint',
  path: '/revoke',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'token-management', label: 'Token management' },
  spec: 'RFC 7009 §2',
  feature: 'revocation',
  rearrangeable: true,
  steps: [
    'parse-request',
    'authenticate-client',
    'resolve-token',
    'revoke-token',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
  },
  journeys: [
    { from: 'token', to: 'revocation', label: 'token', kind: 'flow', order: 120 },
  ],
});
