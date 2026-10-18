import { defineEndpoint } from '../_oidc-provider/endpoint';

/** The steps of route.ts (Authorization Endpoint, OIDC Core 1.0 §3.1.2). */
export const endpoint = defineEndpoint({
  path: '/authorize',
  steps: [
    { id: 'load-signing-keys', consumes: [], produces: ['keys'] },
    { id: 'parse-request', consumes: [], produces: ['params', 'responseMode', 'issuer'] },
    { id: 'resolve-pushed-request', feature: 'par', consumes: ['params'], produces: ['params'] },
    { id: 'resolve-client', consumes: ['params'], produces: ['client'] },
    { id: 'resolve-request-object', feature: 'request-object', consumes: ['params', 'client'], produces: ['effectiveParams', 'requestObjectClaims'] },
    { id: 'resolve-redirect-uri', consumes: ['effectiveParams', 'params', 'client'], produces: ['requestParams', 'redirectUri', 'state'] },
    { id: 'resolve-jarm-response-mode', feature: 'jarm', consumes: ['requestParams', 'client', 'redirectUri', 'state', 'issuer', 'keys'], produces: ['responseMode'] },
    { id: 'validate-request', consumes: ['params', 'requestParams', 'effectiveParams', 'requestObjectClaims', 'client', 'redirectUri', 'state'], produces: ['validatedRequest'] },
    { id: 'create-transaction', consumes: ['validatedRequest', 'responseMode'], produces: ['transactionId', 'transaction', 'transactionTtlSeconds'] },
    { id: 'validate-prompt-combination', consumes: ['transaction', 'transactionId', 'responseMode'], produces: ['promptValues'] },
    { id: 'verify-id-token-hint', consumes: ['transaction', 'transactionId', 'issuer', 'keys', 'responseMode'], produces: ['verifiedHintSubject'] },
    { id: 'authenticate-silently', consumes: ['promptValues', 'transaction', 'transactionId', 'verifiedHintSubject', 'responseMode'], produces: [] },
    { id: 'reuse-session', consumes: ['promptValues', 'transaction', 'transactionId', 'transactionTtlSeconds', 'verifiedHintSubject', 'responseMode'], produces: [] },
    { id: 'continue-to-login', consumes: ['transactionId', 'transactionTtlSeconds'], produces: [] },
    { id: 'respond-error', consumes: ['responseMode'], produces: [] },
  ],
});
