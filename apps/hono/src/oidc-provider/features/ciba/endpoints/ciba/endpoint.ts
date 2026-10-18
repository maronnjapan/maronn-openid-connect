import { defineEndpoint } from '../../../../endpoints/step.js';

/** EXPERIMENTAL — the CIBA authentication device screens. CIBA Core 1.0 §7.1 */
export const endpoint = defineEndpoint({
  id: 'ciba',
  order: 160,
  label: 'CIBA authentication device screens',
  path: '/ciba',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'backchannel-authentication', label: 'CIBA (poll mode)' },
  spec: 'CIBA Core 1.0 §7.1',
  feature: 'ciba',
  rearrangeable: false,
  steps: [
    'prepare-device',
    'submit-login',
    'submit-decision',
  ],
  edges: {
    chain: false,
    extra: [
      { from: 'prepare-device', to: 'submit-login', label: 'no OP session', kind: 'branch' },
      { from: 'prepare-device', to: 'submit-decision', label: 'OP session', kind: 'branch' },
      { from: 'submit-login', to: 'submit-decision', kind: 'flow' },
    ],
  },
});
