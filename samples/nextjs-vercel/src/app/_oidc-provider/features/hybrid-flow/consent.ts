/**
 * The (feature: hybrid-flow) block of consent/decision/route.ts: the End-User
 * approved a request of the Hybrid Flow (response_type=code id_token, code
 * token or code id_token token), which gets its code together with the ID
 * Token and/or the access token.
 */
import {
  AuthorizationError,
  completeAuthTransaction,
  isHybridResponseType,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import {
  respondToClient,
  type AuthorizationResponseMode,
  type AuthorizationResponseParameters,
} from '../../../authorize/response-mode';
import { buildClearedTransactionCookie } from '../../cookies';
import { redirectToErrorPage } from '../../http';
import { config, loadSigningKeys, resolvers, stores } from '../../provider';
import { resolveGrantableScopes } from '../../scopes';
import type { AuthSessionInfo } from '../../store';
import { createFragmentResponseMode } from '../implicit-flow/response-mode';
import { issueHybridTokens } from './tokens';

/**
 * Finish the transaction, issue the code with the ID Token and/or the access
 * token for the granted scope, record the consent and the grant, and answer
 * the client in the response mode of the request — the fragment by default
 * (OIDC Core 1.0 §3.3.2.5), never the query. Returns undefined for a request
 * of any other response type, which the blocks after this one answer.
 */
export async function issueHybridConsentResponse(input: {
  transactionId: string;
  transaction: AuthTransaction;
  session: AuthSessionInfo;
  responseMode: AuthorizationResponseMode | undefined;
}): Promise<Response | undefined> {
  const { transactionId, transaction, session } = input;
  if (!isHybridResponseType(transaction.responseType)) return undefined;

  const responseMode = input.responseMode ?? createFragmentResponseMode({ issuer: config.issuer });
  const answer = async (parameters: AuthorizationResponseParameters): Promise<Response> =>
    // The transaction is over; drop the cookie that named it.
    respondToClient(await responseMode.respond(transaction.redirectUri, parameters), [buildClearedTransactionCookie()]);

  // Loaded before anything is recorded, so a key outage stops here, as the
  // restore of the response mode does.
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return redirectToErrorPage('server_error', 'Failed to load the signing keys');

  const responseParams = await completeAuthTransaction(transactionId, transaction, stores.transactionStore);
  // The scope policy (resolveGrantableScopes in scopes.ts), applied as the
  // code of the approval applies it: a dropped scope narrows the grant (RFC
  // 6749 §3.3), and the response reports the scope.
  const grantedScope = await resolveGrantableScopes(transaction.scope.split(' ').filter(Boolean), session.subject);

  let issued;
  try {
    issued = await issueHybridTokens({
      responseType: transaction.responseType,
      responseParams,
      session,
      grantedScope,
      keys,
    });
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    return answer({ error: error.error, error_description: error.errorDescription, state: transaction.state });
  }

  // Record the consent so a later prompt=none (or SSO) request can confirm it
  // without UI (OIDC Core 1.0 §3.1.2.1 / §3.1.2.4), and the grant, so
  // withdrawing that consent revokes the code's tokens. Only the
  // per-transaction hand-off is cleared; the OP session persists for SSO.
  await resolvers.consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);
  await resolvers.consentResolver.recordGrant(session.subject, transaction.clientId, issued.grantId);
  await stores.authSessionStore.delete(transactionId);

  return answer(issued.parameters);
}
