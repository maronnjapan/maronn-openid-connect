import { defineEndpoint } from '../../_oidc-provider/endpoint';

/** The steps of route.ts (OpenID Provider Configuration, OIDC Discovery 1.0 §4). */
export const endpoint = defineEndpoint({
  path: '/.well-known/openid-configuration',
  steps: [
    { id: 'load-signing-keys', consumes: [], produces: ['keys'] },
    { id: 'build-metadata', consumes: ['keys'], produces: ['issuer', 'metadata'] },
    { id: 'respond', consumes: ['metadata', 'issuer'], produces: [] },
  ],
});
