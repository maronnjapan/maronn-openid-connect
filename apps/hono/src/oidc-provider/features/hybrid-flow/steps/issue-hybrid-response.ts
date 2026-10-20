import {
  AuthorizationError,
  completeAuthTransaction,
  isHybridResponseType,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import { buildClearedTransactionCookie } from '../../../cookies.js';
import {
  restoreResponseMode,
  type AuthorizationResponseParameters,
  type ResponseModeTransaction,
} from '../../../endpoints/authorize/response-mode.js';
import type { ConsentOutcome } from '../../../endpoints/consent/screen.js';
import { recordConsentDecision } from '../../../endpoints/consent/steps/record-consent.js';
import { step } from '../../../endpoints/step.js';
import { resolveGrantableScopes } from '../../../scopes.js';
import type { AuthSessionInfo } from '../../../store.js';
import { createFragmentResponseMode } from '../../implicit-flow/response-mode.js';
import { issueHybridTokens } from '../tokens.js';

export const meta = step({
  id: 'issue-hybrid-response',
  endpoint: 'consent',
  feature: 'hybrid-flow',
  kind: 'dispatch',
  label: 'Hybrid Flow: issue the code together with the ID Token and/or the access token',
  spec: 'OIDC Core 1.0 §3.3.2.5',
  function: 'issueHybridConsentResponse',
  calls: ['isHybridResponseType', 'completeAuthTransaction', 'resolveGrantableScopes', 'issueHybridTokens', 'recordConsentDecision', 'restoreResponseMode'],
  consumes: ['transactionId', 'transaction', 'session', 'issuer'],
  produces: ['outcome'],
  removable: false,
});

/**
 * The End-User approved a request of the Hybrid Flow (response_type=code
 * id_token, code token or code id_token token): finish the transaction, issue
 * the code with the ID Token and/or the access token for the granted scope,
 * record the consent and the grant, and answer the client in the response
 * mode of the request — the fragment by default (OIDC Core 1.0 §3.3.2.5),
 * never the query. Returns undefined for a request of any other response
 * type, which the steps after this one answer.
 */
export async function issueHybridConsentResponse(
  c: any,
  input: {
    transactionId: string;
    transaction: AuthTransaction;
    session: AuthSessionInfo;
    issuer: string;
  },
): Promise<ConsentOutcome | undefined> {
  const { transactionId, transaction, session, issuer } = input;
  if (!isHybridResponseType(transaction.responseType)) return undefined;

  const responseMode =
    restoreResponseMode(c, transaction as ResponseModeTransaction) ?? createFragmentResponseMode({ issuer });
  const answer = async (parameters: AuthorizationResponseParameters): Promise<ConsentOutcome> => ({
    kind: 'authorization_response',
    response: await responseMode.respond(transaction.redirectUri, parameters),
    // The transaction is over; drop the cookie that named it.
    cookies: [buildClearedTransactionCookie()],
  });

  const responseParams = await completeAuthTransaction(transactionId, transaction, c.get('transactionStore'));
  // The scope policy (resolveGrantableScopes in scopes.ts), applied as the
  // issue-authorization-code step applies it to a code: a dropped scope
  // narrows the grant (RFC 6749 §3.3), and the response reports the scope.
  const grantedScope = await resolveGrantableScopes(
    transaction.scope.split(' ').filter(Boolean),
    session.subject,
  );

  let issued;
  try {
    issued = await issueHybridTokens(c, {
      responseType: transaction.responseType,
      responseParams,
      session,
      grantedScope,
    });
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    return answer({ error: error.error, error_description: error.errorDescription, state: transaction.state });
  }

  // Record the consent and the grant, and clear the hand-off of the login
  // step, as the record-consent step does after a code.
  await recordConsentDecision(c, transactionId, transaction, session, issued, grantedScope);
  return answer(issued.parameters);
}
