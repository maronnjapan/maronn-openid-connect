/**
 * Consent decision: the Route Handler the consent form of consent/page.tsx
 * posts to. It records the End-User's decision and answers with the
 * authorization response for the client (OIDC Core 1.0 §3.1.2.5 / §3.1.2.6).
 * A request of a response type a feature answers in place of the code (the
 * Implicit Flow) ends in that feature's block instead of the code.
 *
 * A Route Handler, not a Server Action: the authorization response is a
 * redirect in the query and fragment response modes, but an HTML page in the
 * Form Post Response Mode (OAuth 2.0 Form Post Response Mode §2), and a
 * Server Action can only redirect.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  AuthTransactionError,
  completeAuthTransaction,
  createAuthorizationCode,
  getAuthTransaction,
  validateCsrfToken,
} from '@maronn-openid-connect/core';
import {
  authorizationResponseOf,
  respondToClient,
  restoreResponseMode,
  type AuthorizationResponseMode,
  type ResponseModeTransaction,
} from '../../authorize/response-mode';
import { issueImplicitConsentResponse } from '../../_oidc-provider/features/implicit-flow/consent';
import { readFormFields, redirectToErrorPage } from '../../_oidc-provider/http';
import { config, loadSigningKeys, resolvers, stores } from '../../_oidc-provider/provider';
import {
  buildClearedTransactionCookie,
  CROSS_ORIGIN_FORM_POST_MESSAGE,
  isSameOriginFormPost,
  parseTransactionId,
} from '../../_oidc-provider/cookies';
import { resolveGrantableScopes } from '../../_oidc-provider/scopes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<Response> {
  // [reject-cross-origin-post] Reject a form POST from another origin — OIDC Core 1.0 §3.1.2.4
  // First the browser's own statement of where the form was submitted from
  // (isSameOriginFormPost() in _oidc-provider/cookies.ts): independent of the
  // cookie and the csrf_token below. This handler mints the authorization
  // code, so no decision may come from anywhere else.
  const sameOrigin = isSameOriginFormPost(
    { origin: request.headers.get('Origin'), secFetchSite: request.headers.get('Sec-Fetch-Site') },
    config.issuer,
  );
  if (!sameOrigin) return redirectToErrorPage('cross_origin_request', CROSS_ORIGIN_FORM_POST_MESSAGE);

  // [load-transaction] Load the transaction named by the cookie
  const form = await readFormFields(request);
  const action = String(form.get('action') ?? '');

  // The transaction cookie says which transaction this browser is in. Without
  // one — no cookie, or a transaction that is unknown, already finished, or
  // expired — the End-User has to start over from the client application.
  const transactionId = parseTransactionId(request.headers.get('Cookie'));
  const transaction = transactionId === undefined ? undefined : await findTransaction(transactionId);
  if (transactionId === undefined || transaction === undefined) {
    return redirectToErrorPage(
      'transaction_not_found',
      'This sign-in request was not found or has expired. Start again from the application.',
    );
  }

  // [validate-csrf-token] Check csrf_token against the transaction
  // ... and the CSRF token proves the decision came from the form this browser
  // was shown for exactly that transaction. Checked before any decision is acted
  // on: this handler mints the authorization code.
  try {
    validateCsrfToken(transaction, String(form.get('csrf_token') ?? ''));
  } catch (error) {
    if (error instanceof AuthTransactionError) return redirectToErrorPage(error.code, error.message);
    throw error;
  }

  // [restore-response-mode] Restore the response mode of the authorization request — OAuth 2.0 Multiple Response Type Encoding Practices §2.1
  // The response mode the authorization request asked for (JARM's query.jwt,
  // form_post, the fragment of the Implicit Flow), restored before anything is
  // recorded, so a key outage stops here instead of after the code and the
  // consent were stored.
  let responseMode: AuthorizationResponseMode | undefined;
  try {
    responseMode = await restoreResponseMode(transaction, { issuer: config.issuer, loadSigningKeys });
  } catch {
    return redirectToErrorPage('server_error', 'Failed to load the response signing key');
  }

  // [deny-authorization] Deny: answer access_denied — OIDC Core 1.0 §3.1.2.6
  if (action === 'deny') {
    await stores.transactionStore.delete('auth_txn:' + transactionId);
    await stores.authSessionStore.delete(transactionId);
    // The transaction is over; drop the cookie that named it.
    return respondToClient(
      await authorizationResponseOf(responseMode, transaction.redirectUri, {
        error: 'access_denied',
        state: transaction.state,
      }, config.issuer),
      [buildClearedTransactionCookie()],
    );
  }

  // [validate-decision] Require an explicit approve decision — OIDC Core 1.0 §3.1.2.4
  // OIDC Core 1.0 §3.1.2.4: "the Authorization Server MUST obtain an
  // authorization decision before releasing information to the Relying Party."
  // This handler mints the authorization code, so the affirmative decision is
  // detected on an allowlist: a missing, empty or unknown 'action' means no
  // decision was obtained and must not approve. 'approve' MUST stay in sync with
  // the Approve button in page.tsx.
  //
  // §3.1.2.6: access_denied means the End-User denied the request, which is not
  // the same as no decision at all — an unrecognized value therefore goes to the
  // OP's own error page instead of back to the client.
  if (action !== 'approve') {
    return redirectToErrorPage(
      'invalid_request',
      'Invalid consent decision. Please use the Approve or Deny button.',
    );
  }

  // [require-authenticated-subject] Require the subject the login step stored
  // The login step's hand-off: no authenticated subject means the login step
  // was skipped or has expired.
  const session = await stores.authSessionStore.get(transactionId);
  if (!session) {
    return NextResponse.redirect(new URL('/login', config.issuer), 303);
  }

  // [issue-implicit-response] (feature: implicit-flow) Issue the ID Token (and access token) in place of the code — OIDC Core 1.0 §3.2.2.5
  const implicitResponse = await issueImplicitConsentResponse({ transactionId, transaction, session, responseMode });
  if (implicitResponse) return implicitResponse;

  // [issue-authorization-code] Issue the authorization code — OIDC Core 1.0 §3.1.2.5 / §3.1.3.1
  const responseParams = await completeAuthTransaction(
    transactionId,
    transaction,
    stores.transactionStore,
  );

  // Apply the scope policy (resolveGrantableScopes in scopes.ts — the place for
  // per-user filtering). A dropped scope narrows the grant rather than failing
  // the request: RFC 6749 §3.3 lets the authorization server issue a narrower
  // scope, and the token response reports what was granted.
  const grantedScope = await resolveGrantableScopes(
    transaction.scope.split(' ').filter(Boolean),
    session.subject,
  );

  // OIDC Core 1.0 §3.1.3.1: TTL is configurable via ProviderConfig (300 seconds by default).
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // online refresh token をこのログインセッションへ束縛する（login step が
    // authSessionStore へ載せた値）。ログアウトすれば RT も使えなくなる。
    sessionId: session.sessionId,
    ttlSeconds: config.authorizationCodeTtl,
  });
  await stores.authCodeStore.set(authCodeData.code, authCodeData);

  // [record-consent] Record the consent and the grant — OIDC Core 1.0 §3.1.2.4
  // Record the consent so a later prompt=none (or SSO) request can confirm it
  // without UI (OIDC Core 1.0 §3.1.2.1 / §3.1.2.4), and the grant, so
  // withdrawing that consent revokes the tokens issued from it. Only the
  // per-transaction hand-off is cleared; the OP session persists for SSO.
  await resolvers.consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);
  await resolvers.consentResolver.recordGrant(session.subject, transaction.clientId, authCodeData.grantId);
  await stores.authSessionStore.delete(transactionId);

  // [build-authorization-response] Build the authorization response — RFC 9207 §2
  // The transaction is over; drop the cookie that named it.
  return respondToClient(
    await authorizationResponseOf(responseMode, transaction.redirectUri, {
      code: authCodeData.code,
      state: responseParams.state,
    }, config.issuer),
    [buildClearedTransactionCookie()],
  );
}

/** The transaction stored under the id, or undefined when it is unknown, already finished or expired. */
async function findTransaction(transactionId: string): Promise<ResponseModeTransaction | undefined> {
  try {
    return await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (error) {
    if (error instanceof AuthTransactionError) return undefined;
    throw error;
  }
}
