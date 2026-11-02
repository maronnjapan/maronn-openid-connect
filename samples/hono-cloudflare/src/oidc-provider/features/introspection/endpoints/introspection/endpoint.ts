import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * Tell an authenticated client whether a token is active and, when it is,
 * describe it (scope, client_id, sub, exp and more), as JSON or as a signed
 * JWT when the client asks for application/token-introspection+jwt; an unknown
 * or expired token is answered with only active: false.
 *
 * @spec RFC 7662 §2
 */
export const endpoint = defineEndpoint({
  id: 'introspection',
  order: 90,
  label: 'Token introspection endpoint',
  path: '/introspect',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'token-management', label: 'Token management' },
  spec: 'RFC 7662 §2',
  feature: 'introspection',
  rearrangeable: true,
  steps: [
    'parse-request',
    'authenticate-client',
    'resolve-token',
    'build-response',
    'sign-response',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
    extra: [
      { from: 'sign-response', to: 'respond', label: 'application/token-introspection+jwt', kind: 'branch' },
    ],
  },
  journeys: [
    { from: 'token', to: 'introspection', label: 'token', kind: 'flow', order: 110 },
  ],
});
