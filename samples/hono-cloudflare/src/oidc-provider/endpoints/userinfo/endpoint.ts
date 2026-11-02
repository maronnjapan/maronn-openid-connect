import { defineEndpoint } from '../step.js';

/**
 * Return the claims about the End-User of the presented access token that its
 * scopes and claims request allow, as JSON (or as a signed JWT when the client
 * registered userinfo_signed_response_alg). A missing or invalid token is
 * answered with a Bearer error.
 *
 * @spec OIDC Core 1.0 §5.3
 */
export const endpoint = defineEndpoint({
  id: 'userinfo',
  order: 80,
  label: 'UserInfo endpoint',
  path: '/userinfo',
  methods: ['GET', 'POST'],
  layer: 'api',
  group: { id: 'authorization-code', label: 'Authorization Code Flow' },
  spec: 'OIDC Core 1.0 §5.3',
  rearrangeable: true,
  steps: [
    'parse-access-token',
    'resolve-access-token',
    'resolve-claims',
    'build-response',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
  },
});
