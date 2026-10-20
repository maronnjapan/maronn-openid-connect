/**
 * The response types of the Hybrid Flow (OIDC Core 1.0 §3.3.1.1), as the
 * authorization endpoint answers them for a request that needs no screen:
 * prompt=none, or SSO with prior consent. The issue-authorization-code step
 * hands such a request here instead of issuing the code alone
 * (endpoints/authorize/response-type.ts). A request that goes through the
 * consent screen gets its code and tokens from the issue-hybrid-response step
 * of /consent.
 */
import { completeAuthTransaction, HYBRID_RESPONSE_TYPES } from '@maronn-openid-connect/core';
import type { AuthorizationResponseTypeHandler } from '../../endpoints/authorize/response-type.js';
import { contribute } from '../../endpoints/step.js';
import { createFragmentResponseMode } from '../implicit-flow/response-mode.js';
import { issueHybridTokens } from './tokens.js';

/**
 * What the Hybrid Flow adds to the issue-authorization-code box of the
 * authorization endpoint: a code id_token / code token / code id_token token
 * request gets its code and tokens there.
 */
export const contribution = contribute({
  endpoint: 'authorize',
  step: 'issue-authorization-code',
  feature: 'hybrid-flow',
  calls: ['issueHybridTokens'],
  spec: 'OIDC Core 1.0 §3.3.2.5',
});

export const hybridResponseTypeHandler: AuthorizationResponseTypeHandler = {
  names: HYBRID_RESPONSE_TYPES,
  async respond(c, { transactionId, transaction, session, issuer, responseMode }) {
    const transactionStore = c.get('transactionStore');
    const consentResolver = c.get('consentResolver');

    // transaction.scope is what authenticate-silently / reuse-session left
    // after the scope policy (resolveGrantableScopes in scopes.ts), and the
    // offline_access policy was applied when the request was validated: the
    // code returns a refresh token under the same rules as the code flow.
    const grantedScope = transaction.scope.split(' ').filter(Boolean);

    // One-time use: the transaction is finished before anything is issued.
    const responseParams = await completeAuthTransaction(transactionId, transaction, transactionStore);
    const { parameters, grantId } = await issueHybridTokens(c, {
      responseType: transaction.responseType,
      responseParams,
      session,
      grantedScope,
    });
    // Withdrawing the consent revokes the tokens of this grant: those of the
    // authorization endpoint and those the token endpoint issues for the code.
    await consentResolver?.recordGrant?.(session.subject, transaction.clientId, grantId);

    // The response mode the request asked for (form_post), or else the
    // fragment: the tokens never travel in the query (OAuth 2.0 Multiple
    // Response Type Encoding Practices §5).
    const mode = responseMode ?? createFragmentResponseMode({ issuer });
    return { kind: 'authorization_response', response: await mode.respond(transaction.redirectUri, parameters) };
  },
};
