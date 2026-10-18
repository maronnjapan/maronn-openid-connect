import { defineEndpoint } from '../../../../endpoints/step.js';

/** EXPERIMENTAL — the device verification screens. RFC 8628 §3.3 */
export const endpoint = defineEndpoint({
  id: 'device',
  label: 'Device verification screens',
  path: '/device',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'device-authorization', label: 'Device Authorization Grant (RFC 8628)' },
  spec: 'RFC 8628 §3.3',
  feature: 'device-authorization-grant',
  rearrangeable: false,
  edges: {
    chain: false,
    extra: [
      { from: 'submit-user-code', to: 'submit-login', label: 'no OP session', kind: 'branch' },
      { from: 'submit-user-code', to: 'submit-decision', label: 'OP session', kind: 'branch' },
      { from: 'submit-login', to: 'submit-decision', kind: 'flow' },
    ],
  },
});
