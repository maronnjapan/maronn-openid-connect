import { defineEndpoint } from '../../_oidc-provider/endpoint';

/** The steps of route.ts (the consent decision, OIDC Core 1.0 §3.1.2.4). */
export const endpoint = defineEndpoint({
  path: '/consent/decision',
  steps: [
    { id: 'reject-cross-origin-post', consumes: [], produces: [] },
    { id: 'load-transaction', consumes: [], produces: ['form', 'action', 'transactionId', 'transaction'] },
    { id: 'validate-csrf-token', consumes: ['form', 'transaction'], produces: [] },
    { id: 'restore-response-mode', consumes: ['transaction'], produces: ['responseMode'] },
    { id: 'deny-authorization', consumes: ['action', 'transactionId', 'transaction', 'responseMode'], produces: [] },
    { id: 'validate-decision', consumes: ['action'], produces: [] },
    { id: 'require-authenticated-subject', consumes: ['transactionId'], produces: ['session'] },
    { id: 'issue-implicit-response', feature: 'implicit-flow', consumes: ['transactionId', 'transaction', 'session', 'responseMode'], produces: [] },
    { id: 'issue-hybrid-response', feature: 'hybrid-flow', consumes: ['transactionId', 'transaction', 'session', 'responseMode'], produces: [] },
    { id: 'issue-authorization-code', consumes: ['transactionId', 'transaction', 'session'], produces: ['responseParams', 'grantedScope', 'authCodeData'] },
    { id: 'record-consent', consumes: ['transactionId', 'transaction', 'session', 'grantedScope', 'authCodeData'], produces: [] },
    { id: 'build-authorization-response', consumes: ['transaction', 'responseParams', 'authCodeData', 'responseMode'], produces: [] },
  ],
});
