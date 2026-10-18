import { defineEndpoint } from '../../../../endpoints/step.js';

/** Token Introspection. RFC 7662 §2 */
export const endpoint = defineEndpoint({
  id: 'introspection',
  label: 'Token introspection endpoint',
  path: '/introspect',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'token-management', label: 'Token management' },
  spec: 'RFC 7662 §2',
  feature: 'introspection',
  rearrangeable: true,
  errorStep: 'respond-error',
  edges: {
    chain: true,
    extra: [
      { from: 'sign-response', to: 'respond', label: 'application/token-introspection+jwt', kind: 'branch' },
    ],
  },
  journeys: [{ from: 'token', to: 'introspection', label: 'token', kind: 'flow' }],
});
