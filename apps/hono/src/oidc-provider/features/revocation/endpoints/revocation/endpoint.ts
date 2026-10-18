import { defineEndpoint } from '../../../../endpoints/step.js';

/** Token Revocation. RFC 7009 §2 */
export const endpoint = defineEndpoint({
  id: 'revocation',
  label: 'Token revocation endpoint',
  path: '/revoke',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'token-management', label: 'Token management' },
  spec: 'RFC 7009 §2',
  feature: 'revocation',
  rearrangeable: true,
  errorStep: 'respond-error',
  edges: { chain: true },
  journeys: [{ from: 'token', to: 'revocation', label: 'token', kind: 'flow' }],
});
