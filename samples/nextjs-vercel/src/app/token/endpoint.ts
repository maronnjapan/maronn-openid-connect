import { defineEndpoint } from '../_oidc-provider/endpoint';

/** The steps of route.ts (Token Endpoint, OIDC Core 1.0 §3.1.3). */
export const endpoint = defineEndpoint({
  path: '/token',
  steps: [
    { id: 'load-signing-keys', consumes: [], produces: ['keys'] },
    { id: 'parse-request', consumes: [], produces: ['params'] },
    { id: 'authenticate-client', consumes: ['params'], produces: ['tokenClient', 'authenticatedClientId'] },
    { id: 'dispatch-device-code', feature: 'device-authorization-grant', consumes: ['params', 'tokenClient', 'keys'], produces: [] },
    { id: 'dispatch-ciba', feature: 'ciba', consumes: ['params', 'tokenClient', 'keys'], produces: [] },
    { id: 'validate-grant-type', consumes: ['params', 'tokenClient'], produces: ['grantType'] },
    { id: 'validate-refresh-token-grant', feature: 'refresh-token', consumes: ['params', 'authenticatedClientId', 'grantType'], produces: ['refreshTokenRequest'] },
    { id: 'validate-authorization-code-grant', consumes: ['refreshTokenRequest', 'params', 'authenticatedClientId'], produces: ['validatedRequest'] },
    { id: 'select-signing-keys', consumes: ['tokenClient', 'keys'], produces: ['idTokenKey'] },
    { id: 'resolve-subject', consumes: ['validatedRequest'], produces: ['subject', 'authTime', 'nonce', 'effectiveAudience'] },
    { id: 'decide-refresh-token-issuance', feature: 'refresh-token', consumes: ['tokenClient', 'validatedRequest'], produces: ['refreshTokenDecision'] },
    { id: 'resolve-acr-amr', consumes: ['subject', 'validatedRequest'], produces: ['acr', 'amr'] },
    { id: 'issue-access-token', consumes: ['subject', 'validatedRequest', 'effectiveAudience', 'acr', 'keys'], produces: ['issuedAt', 'accessTokenPayload', 'accessToken'] },
    { id: 'issue-id-token', consumes: ['accessToken', 'idTokenKey', 'subject', 'validatedRequest', 'issuedAt', 'nonce', 'authTime', 'acr', 'amr'], produces: ['idToken'] },
    { id: 'persist-access-token', consumes: ['accessToken', 'accessTokenPayload', 'subject', 'validatedRequest', 'issuedAt', 'effectiveAudience', 'acr'], produces: [] },
    { id: 'issue-refresh-token', feature: 'refresh-token', consumes: ['refreshTokenDecision', 'subject', 'authTime', 'nonce', 'validatedRequest', 'issuedAt', 'effectiveAudience', 'acr', 'amr'], produces: ['refreshToken'] },
    { id: 'revoke-rotated-refresh-token', feature: 'refresh-token', consumes: ['params', 'validatedRequest'], produces: [] },
    { id: 'build-token-response', consumes: ['accessToken', 'idToken', 'refreshToken', 'validatedRequest'], produces: ['tokenResponse'] },
    { id: 'respond', consumes: ['tokenResponse'], produces: [] },
    { id: 'respond-error', consumes: [], produces: [] },
  ],
});
