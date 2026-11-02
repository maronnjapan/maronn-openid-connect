import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * Accept the parameters of an authorization request pushed by an authenticated
 * client, validate them as the authorization endpoint would and answer 201
 * with the request_uri to send to /authorize.
 *
 * EXPERIMENTAL: generated with --enable par.
 *
 * @spec RFC 9126 §2
 */
export const endpoint = defineEndpoint({
  id: 'par',
  order: 110,
  label: 'Pushed authorization request endpoint',
  path: '/par',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'pushed-authorization', label: 'Pushed Authorization Requests (RFC 9126)' },
  spec: 'RFC 9126 §2',
  feature: 'par',
  rearrangeable: true,
  steps: [
    'parse-request',
    'authenticate-client',
    'validate-request',
    'store-request',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
  },
  journeys: [
    { from: 'par', to: 'authorize', label: 'request_uri', kind: 'flow', order: 10 },
  ],
});
