/**
 * The response types of the Implicit Flow (OIDC Core 1.0 §3.2.2.1), as the
 * authorization endpoint answers them for a request that needs no screen:
 * prompt=none, or SSO with prior consent. The issue-authorization-code step
 * hands such a request here instead of issuing a code
 * (endpoints/authorize/response-type.ts). A request that goes through the
 * consent screen gets its tokens from the issue-implicit-response step of
 * /consent.
 */
import {
  completeAuthTransaction,
  IMPLICIT_RESPONSE_TYPES,
} from '@maronn-openid-connect/core';
import type { AuthorizationResponseTypeHandler } from '../../endpoints/authorize/response-type.js';
import { contribute } from '../../endpoints/step.js';
import { implicitResponseModeOf } from './response-mode.js';
import { issueImplicitTokens } from './tokens.js';

/**
 * What the Implicit Flow adds to the issue-authorization-code box of the
 * authorization endpoint: an id_token / id_token token request gets its
 * tokens there in place of a code.
 */
export const contribution = contribute({
  endpoint: 'authorize',
  step: 'issue-authorization-code',
  feature: 'implicit-flow',
  calls: ['issueImplicitTokens'],
  spec: 'OIDC Core 1.0 §3.2.2.5',
});

export const implicitResponseTypeHandler: AuthorizationResponseTypeHandler = {
  names: IMPLICIT_RESPONSE_TYPES,
  async respond(c, { transactionId, transaction, session, issuer, responseMode }) {
    const transactionStore = c.get('transactionStore');
    const consentResolver = c.get('consentResolver');

    // transaction.scope is what authenticate-silently / reuse-session left
    // after the scope policy (resolveGrantableScopes in scopes.ts), and
    // offline_access is never in it: applyOfflineAccessPolicy drops it for a
    // response type without a code (OIDC Core 1.0 §11).
    const grantedScope = transaction.scope.split(' ').filter(Boolean);

    // One-time use: the transaction is finished before anything is issued.
    const responseParams = await completeAuthTransaction(transactionId, transaction, transactionStore);
    const { parameters, grantId } = await issueImplicitTokens(c, {
      responseType: transaction.responseType,
      responseParams,
      session,
      grantedScope,
    });
    // Withdrawing the consent revokes the access token of this grant.
    await consentResolver?.recordGrant?.(session.subject, transaction.clientId, grantId);

    const mode = implicitResponseModeOf(responseMode, issuer);
    return { kind: 'authorization_response', response: await mode.respond(transaction.redirectUri, parameters) };
  },
};
