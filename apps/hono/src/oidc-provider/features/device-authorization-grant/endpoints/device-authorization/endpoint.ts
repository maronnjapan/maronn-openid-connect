import { defineEndpoint } from '../../../../endpoints/step.js';

/** EXPERIMENTAL — the device authorization endpoint. RFC 8628 §3.1 / §3.2 */
export const endpoint = defineEndpoint({
  id: 'device-authorization',
  label: 'Device authorization endpoint',
  path: '/device_authorization',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'device-authorization', label: 'Device Authorization Grant (RFC 8628)' },
  spec: 'RFC 8628 §3.1 / §3.2',
  feature: 'device-authorization-grant',
  rearrangeable: true,
  errorStep: 'respond-error',
  edges: { chain: true },
  journeys: [
    { from: 'device-authorization', to: 'device', label: 'user_code (End-User)', kind: 'flow' },
    { from: 'device-authorization', to: 'token', label: 'device_code (polling)', kind: 'flow' },
  ],
});
