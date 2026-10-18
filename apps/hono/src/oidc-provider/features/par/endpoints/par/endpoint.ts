import { defineEndpoint } from '../../../../endpoints/step.js';

/** EXPERIMENTAL — the pushed authorization request endpoint. RFC 9126 §2 */
export const endpoint = defineEndpoint({
  id: 'par',
  label: 'Pushed authorization request endpoint',
  path: '/par',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'pushed-authorization', label: 'Pushed Authorization Requests (RFC 9126)' },
  spec: 'RFC 9126 §2',
  feature: 'par',
  rearrangeable: true,
  errorStep: 'respond-error',
  edges: { chain: true },
  journeys: [{ from: 'par', to: 'authorize', label: 'request_uri', kind: 'flow' }],
});
