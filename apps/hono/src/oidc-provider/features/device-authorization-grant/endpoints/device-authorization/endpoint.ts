import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * Accept a device authorization request: authenticate the client, check the
 * scopes and answer with a device_code, a user_code and the verification URI
 * the End-User opens on another device.
 *
 * EXPERIMENTAL: generated with --enable device-authorization-grant.
 *
 * @spec RFC 8628 §3.1 / §3.2
 */
export const endpoint = defineEndpoint({
  id: 'device-authorization',
  order: 130,
  label: 'Device authorization endpoint',
  path: '/device_authorization',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'device-authorization', label: 'Device Authorization Grant (RFC 8628)' },
  spec: 'RFC 8628 §3.1 / §3.2',
  feature: 'device-authorization-grant',
  rearrangeable: true,
  steps: [
    'parse-request',
    'authenticate-client',
    'validate-request',
    'issue-device-code',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
  },
  journeys: [
    { from: 'device-authorization', to: 'device', label: 'user_code (End-User)', kind: 'flow', order: 130 },
    { from: 'device-authorization', to: 'token', label: 'device_code (polling)', kind: 'flow', order: 140 },
  ],
});
