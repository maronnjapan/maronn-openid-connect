import { defineEndpoint } from '../../../../endpoints/step.js';

/** EXPERIMENTAL — the client registration endpoint. RFC 7591 §3 */
export const endpoint = defineEndpoint({
  id: 'register',
  label: 'Client registration endpoint',
  path: '/register',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'client-registration', label: 'Dynamic Client Registration (RFC 7591)' },
  spec: 'RFC 7591 §3',
  feature: 'dynamic-client-registration',
  rearrangeable: true,
  errorStep: 'respond-error',
  edges: { chain: true },
  journeys: [{ from: 'register', to: 'authorize', label: 'client_id', kind: 'flow' }],
});
