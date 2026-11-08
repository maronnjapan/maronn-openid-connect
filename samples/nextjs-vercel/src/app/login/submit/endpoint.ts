import { defineEndpoint } from '../../_oidc-provider/endpoint';

/** Verify the login form's transaction references and CSRF token before authenticating and creating a session. */
export const endpoint = defineEndpoint({
  path: '/login/submit',
  steps: [
    { id: 'reject-cross-origin-post', consumes: [], produces: [] },
    { id: 'load-transaction', consumes: [], produces: ['form', 'transactionId', 'transaction'] },
    { id: 'validate-csrf-token', consumes: ['form', 'transaction'], produces: [] },
    { id: 'authenticate-user', consumes: ['form'], produces: ['user'] },
    { id: 'record-login-failure', consumes: ['user', 'transactionId', 'transaction'], produces: [] },
    { id: 'establish-session', consumes: ['transactionId', 'transaction', 'user'], produces: [] },
  ],
});
