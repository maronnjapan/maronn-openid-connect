import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * Let the End-User decide on CIBA requests on the authentication device: sign
 * in, see the pending requests addressed to them, and approve or deny one,
 * which the polling client then learns at the token endpoint.
 *
 * EXPERIMENTAL: generated with --enable ciba.
 *
 * @spec CIBA Core 1.0 §7.1
 */
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
