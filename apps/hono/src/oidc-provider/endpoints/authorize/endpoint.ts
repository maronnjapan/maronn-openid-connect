import { defineEndpoint } from '../step.js';

/** The authorization endpoint. OIDC Core 1.0 §3.1.2 */
export const endpoint = defineEndpoint({
  id: 'authorize',
  label: 'Authorization endpoint',
  path: '/authorize',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'authorization-code', label: 'Authorization Code Flow' },
  spec: 'OIDC Core 1.0 §3.1.2',
  rearrangeable: true,
  // Defined before the first step: the issuer of the provider, and the
  // response mode, which the resolve-jarm-response-mode step sets and the
  // error step reads even when a step before it failed.
  initial: ['issuer', 'responseMode'],
  errorStep: 'respond-error',
  edges: {
    chain: true,
    extra: [
      { from: 'authenticate-silently', to: 'issue-authorization-code', label: 'session + consent', kind: 'branch' },
      { from: 'reuse-session', to: 'issue-authorization-code', label: 'session + prior consent', kind: 'branch' },
      { from: 'reuse-session', to: 'continue-to-login', label: 'consent screen', kind: 'branch' },
    ],
  },
  journeys: [
    { from: 'authorize', to: 'login', label: 'login required', kind: 'flow' },
    { from: 'authorize', to: 'consent', label: 'SSO: consent required', kind: 'flow' },
    { from: 'authorize', to: 'token', label: 'code (prompt=none / SSO)', kind: 'flow' },
  ],
});
