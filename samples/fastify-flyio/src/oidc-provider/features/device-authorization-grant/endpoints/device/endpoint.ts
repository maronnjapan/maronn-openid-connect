import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * Let the End-User activate a device: enter the user_code, sign in when there
 * is no session, and approve or deny the client, which the device then learns
 * when it polls the token endpoint.
 *
 * EXPERIMENTAL: generated with --enable device-authorization-grant.
 *
 * @spec RFC 8628 §3.3
 */
export const endpoint = defineEndpoint({
  id: 'device',
  order: 140,
  label: 'Device verification screens',
  path: '/device',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'device-authorization', label: 'Device Authorization Grant (RFC 8628)' },
  spec: 'RFC 8628 §3.3',
  feature: 'device-authorization-grant',
  rearrangeable: false,
  steps: [
    'submit-user-code',
    'submit-login',
    'submit-decision',
  ],
  edges: {
    chain: false,
    extra: [
      { from: 'submit-user-code', to: 'submit-login', label: 'no OP session', kind: 'branch' },
      { from: 'submit-user-code', to: 'submit-decision', label: 'OP session', kind: 'branch' },
      { from: 'submit-login', to: 'submit-decision', kind: 'flow' },
    ],
  },
});
