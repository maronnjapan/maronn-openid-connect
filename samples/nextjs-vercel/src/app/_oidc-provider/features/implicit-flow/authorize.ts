/**
 * The (feature: implicit-flow) blocks of authorize/route.ts: the response
 * mode of a request of the Implicit Flow (response_type=id_token or id_token
 * token, OIDC Core 1.0 §3.2.2.1), what such a request needs on top of the
 * validation of the code flow, and its tokens in place of the code for a
 * request that needs no screen (prompt=none, or SSO with prior consent).
 */
import {
  completeAuthTransaction,
  defaultResponseModeOf,
  isImplicitResponseType,
  requireNonce,
  validateImplicitRedirectUri,
  validateImplicitResponseMode,
  type AuthorizationRequestParams,
  type AuthTransaction,
  type ClientInfo,
  type SessionInfo,
} from '@maronn-openid-connect/core';
import { respondToClient, type AuthorizationResponseMode } from '../../../authorize/response-mode';
import { config, loadSigningKeys, resolvers, stores } from '../../provider';
import { createFragmentResponseMode, FRAGMENT_RESPONSE_MODE_NAME, implicitResponseModeOf } from './response-mode';
import { issueImplicitTokens } from './tokens';

/**
 * Answer in the fragment response mode when that is the default of the
 * request's response_type — any response type that returns an ID Token or an
 * access token, the Implicit Flow's id_token and id_token token among them
 * (Multiple Response Type Encoding Practices §3 / §5) — or when the request
 * asked for response_mode=fragment (§2.1).
 *
 * Its block runs after those of the response modes a request asks for by
 * name (JARM, form_post), each of which assigns the response mode only while
 * it is unset, so a request of the Implicit Flow with response_mode=form_post
 * is posted. Its errors go back in the fragment from here on (OIDC Core 1.0
 * §3.2.2.6), the rejection of response_mode=query included
 * (validateImplicitRequest()). Any other request is left to the plain query
 * response: undefined.
 */
export function resolveFragmentResponseContext(
  params: AuthorizationRequestParams,
  issuer: string,
): AuthorizationResponseMode | undefined {
  const requested = (params as { response_mode?: unknown }).response_mode;
  if (requested === FRAGMENT_RESPONSE_MODE_NAME) return createFragmentResponseMode({ issuer });
  if (params.response_type !== undefined && defaultResponseModeOf(params.response_type) === 'fragment') {
    return createFragmentResponseMode({ issuer });
  }
  return undefined;
}

/**
 * What a request of the Implicit Flow needs on top of the validation of the
 * code flow, checked before the transaction is created. Each check is a core
 * function; every failure is a redirectable invalid_request, sent back in the
 * response mode of the request (the fragment by default, OIDC Core 1.0
 * §3.2.2.6). A request of the code flow passes untouched.
 *
 * - response_mode: query must not carry the tokens (OAuth 2.0 Multiple
 *   Response Type Encoding Practices §3 / §5 / §7), and a response mode the
 *   OP does not answer this request in (JARM's query.jwt, a value it does not
 *   know) is refused instead of being swapped for the fragment
 * - nonce is REQUIRED (OIDC Core 1.0 §3.2.2.1)
 * - redirect_uri: https, or http on a loopback host for a public (native)
 *   client (OIDC Core 1.0 §3.2.2.1)
 */
export function validateImplicitRequest(
  request: { responseType: string; nonce: string | undefined; redirectUri: string; state: string | undefined },
  params: AuthorizationRequestParams,
  client: ClientInfo,
  responseMode: AuthorizationResponseMode | undefined,
): void {
  if (!isImplicitResponseType(request.responseType)) return;
  const { redirectUri, state } = request;

  const requested = (params as { response_mode?: unknown }).response_mode;
  validateImplicitResponseMode(
    typeof requested === 'string' ? requested : undefined,
    responseMode === undefined ? [] : [responseMode.name],
    redirectUri,
    state,
  );
  requireNonce(request.nonce, redirectUri, state);
  validateImplicitRedirectUri(redirectUri, client.clientType, state);
}

/**
 * The authorization response of a request of the Implicit Flow that needs no
 * screen: finish the transaction, issue the ID Token (and the access token)
 * for its scope, record the grant, and answer the client in the response mode
 * of the request — the fragment by default (OIDC Core 1.0 §3.2.2.5), never the
 * query. Returns undefined for a request of the code flow, which the
 * issue-authorization-code block answers with a code.
 *
 * transaction.scope is what the scope policy (resolveGrantableScopes in
 * scopes.ts) left, and offline_access is never in it: applyOfflineAccessPolicy
 * drops it for a response type without a code (OIDC Core 1.0 §11).
 */
export async function issueImplicitResponse(input: {
  transactionId: string;
  transaction: AuthTransaction;
  session: SessionInfo;
  responseMode: AuthorizationResponseMode | undefined;
}): Promise<Response | undefined> {
  const { transactionId, transaction, session, responseMode } = input;
  if (!isImplicitResponseType(transaction.responseType)) return undefined;

  // Loaded before the transaction is finished, so a key outage leaves it as it was.
  const keys = await loadSigningKeys();
  const grantedScope = transaction.scope.split(' ').filter(Boolean);

  // One-time use: the transaction is finished before anything is issued.
  const responseParams = await completeAuthTransaction(transactionId, transaction, stores.transactionStore);
  const { parameters, grantId } = await issueImplicitTokens({
    responseType: transaction.responseType,
    responseParams,
    session,
    grantedScope,
    keys,
  });
  // Withdrawing the consent revokes the access token of this grant.
  await resolvers.consentResolver.recordGrant(session.subject, transaction.clientId, grantId);

  const mode = implicitResponseModeOf(responseMode, config.issuer);
  return respondToClient(await mode.respond(transaction.redirectUri, parameters));
}
