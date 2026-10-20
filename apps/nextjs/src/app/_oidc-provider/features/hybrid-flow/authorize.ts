/**
 * The (feature: hybrid-flow) blocks of authorize/route.ts: what a request of
 * the Hybrid Flow (response_type=code id_token, code token or code id_token
 * token, OIDC Core 1.0 §3.3.1.1) needs on top of the validation of the code
 * flow, and its code with the tokens for a request that needs no screen
 * (prompt=none, or SSO with prior consent).
 */
import {
  completeAuthTransaction,
  isHybridResponseType,
  requireHybridNonce,
  validateHybridResponseMode,
  type AuthorizationRequestParams,
  type AuthTransaction,
  type SessionInfo,
} from '@maronn-openid-connect/core';
import { respondToClient, type AuthorizationResponseMode } from '../../../authorize/response-mode';
import { config, loadSigningKeys, resolvers, stores } from '../../provider';
import { createFragmentResponseMode } from '../implicit-flow/response-mode';
import { issueHybridTokens } from './tokens';

/**
 * What a request of the Hybrid Flow needs on top of the validation of the
 * code flow, checked before the transaction is created. Each check is a core
 * function; every failure is a redirectable invalid_request, sent back in the
 * response mode of the request (the fragment by default, OIDC Core 1.0
 * §3.3.2.6). A request of the code flow or of the Implicit Flow passes
 * untouched.
 *
 * - response_mode: query must not carry the tokens (OAuth 2.0 Multiple
 *   Response Type Encoding Practices §5 / §7), and a response mode the OP
 *   does not answer this request in (JARM's query.jwt, a value it does not
 *   know) is refused instead of being swapped for the fragment
 * - nonce is REQUIRED when the authorization endpoint returns an ID Token
 *   (code id_token, code id_token token; OIDC Core 1.0 §3.3.2.11), and stays
 *   optional for code token as in the code flow
 *
 * The redirect_uri rules are those of the code flow (§3.3.2.1 refers to
 * §3.1.2.1), and PKCE binds the code as the code flow checked it.
 */
export function validateHybridRequest(
  request: { responseType: string; nonce: string | undefined; redirectUri: string; state: string | undefined },
  params: AuthorizationRequestParams,
  responseMode: AuthorizationResponseMode | undefined,
): void {
  if (!isHybridResponseType(request.responseType)) return;
  const { redirectUri, state } = request;

  const requested = (params as { response_mode?: unknown }).response_mode;
  validateHybridResponseMode(
    typeof requested === 'string' ? requested : undefined,
    responseMode === undefined ? [] : [responseMode.name],
    redirectUri,
    state,
  );
  requireHybridNonce(request.responseType, request.nonce, redirectUri, state);
}

/**
 * The authorization response of a request of the Hybrid Flow that needs no
 * screen: finish the transaction, issue the code with the ID Token and/or the
 * access token for its scope, record the grant, and answer the client in the
 * response mode of the request — the fragment by default (OIDC Core 1.0
 * §3.3.2.5), never the query. Returns undefined for a request of any other
 * response type, which the blocks after this one answer.
 *
 * transaction.scope is what the scope policy (resolveGrantableScopes in
 * scopes.ts) left, and the offline_access policy was applied when the request
 * was validated: the code returns a refresh token under the same rules as the
 * code flow.
 */
export async function issueHybridResponse(input: {
  transactionId: string;
  transaction: AuthTransaction;
  session: SessionInfo;
  responseMode: AuthorizationResponseMode | undefined;
}): Promise<Response | undefined> {
  const { transactionId, transaction, session, responseMode } = input;
  if (!isHybridResponseType(transaction.responseType)) return undefined;

  // Loaded before the transaction is finished, so a key outage leaves it as it was.
  const keys = await loadSigningKeys();
  const grantedScope = transaction.scope.split(' ').filter(Boolean);

  // One-time use: the transaction is finished before anything is issued.
  const responseParams = await completeAuthTransaction(transactionId, transaction, stores.transactionStore);
  const { parameters, grantId } = await issueHybridTokens({
    responseType: transaction.responseType,
    responseParams,
    session,
    grantedScope,
    keys,
  });
  // Withdrawing the consent revokes the tokens of this grant: those of the
  // authorization endpoint and those the token endpoint issues for the code.
  await resolvers.consentResolver.recordGrant(session.subject, transaction.clientId, grantId);

  // The response mode the request asked for (form_post), or else the fragment:
  // the tokens never travel in the query (OAuth 2.0 Multiple Response Type
  // Encoding Practices §5).
  const mode = responseMode ?? createFragmentResponseMode({ issuer: config.issuer });
  return respondToClient(await mode.respond(transaction.redirectUri, parameters));
}
