import { defineEndpoint } from '../step.js';

/** The token endpoint. OIDC Core 1.0 §3.1.3 */
export const endpoint = defineEndpoint({
  id: 'token',
  label: 'Token endpoint',
  path: '/token',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'authorization-code', label: 'Authorization Code Flow' },
  spec: 'OIDC Core 1.0 §3.1.3',
  rearrangeable: true,
  errorStep: 'respond-error',
  // The grant is validated by one of two steps, chosen by grant_type: the
  // chain goes from validate-grant-type through either of them. A grant a
  // feature answers itself (a dispatch step) goes straight to respond.
  edges: {
    chain: true,
    extra: [
      { from: 'validate-grant-type', to: 'validate-authorization-code-grant', label: 'authorization_code', kind: 'branch' },
      { from: 'validate-grant-type', to: 'validate-refresh-token-grant', label: 'refresh_token', kind: 'branch' },
    ],
  },
  journeys: [{ from: 'token', to: 'userinfo', label: 'access_token', kind: 'flow' }],
});
