import { defineEndpoint } from '../../_oidc-provider/endpoint';

/** The steps of route.ts (Token Introspection, RFC 7662). */
export const endpoint = defineEndpoint({
  path: '/introspect',
  steps: [
    { id: 'load-signing-keys', consumes: [], produces: ['keys'] },
    { id: 'parse-request', consumes: [], produces: ['params'] },
    { id: 'authenticate-client', consumes: ['params'], produces: ['authenticatedClientId'] },
    { id: 'resolve-token', consumes: ['params', 'authenticatedClientId'], produces: ['resolved'] },
    { id: 'build-response', consumes: ['resolved'], produces: ['response'] },
    { id: 'respond', consumes: ['response'], produces: [] },
    { id: 'respond-error', consumes: [], produces: [] },
  ],
});
