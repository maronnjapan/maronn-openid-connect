import { defineEndpoint } from '../../../../endpoints/step.js';

/** EXPERIMENTAL — the backchannel authentication endpoint (poll mode). CIBA Core 1.0 §7 */
export const endpoint = defineEndpoint({
  id: 'backchannel-authentication',
  label: 'Backchannel authentication endpoint',
  path: '/backchannel_authentication',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'backchannel-authentication', label: 'CIBA (poll mode)' },
  spec: 'CIBA Core 1.0 §7',
  feature: 'ciba',
  rearrangeable: true,
  errorStep: 'respond-error',
  edges: { chain: true },
  journeys: [
    { from: 'backchannel-authentication', to: 'ciba', label: 'End-User approves', kind: 'flow' },
    { from: 'backchannel-authentication', to: 'token', label: 'auth_req_id (polling)', kind: 'flow' },
  ],
});
