'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  AuthTransactionError,
  completeAuthTransaction,
  createAuthorizationCode,
  validateCsrfToken,
} from '@maronn-openid-connect/core';
import {
  authorizationResponseUrl,
  restoreResponseMode,
  type AuthorizationResponseMode,
  type ResponseModeTransaction,
} from '../authorize/response-mode';
import { errorPagePath } from '../_oidc-provider/http';
import { config, loadSigningKeys, resolvers, stores } from '../_oidc-provider/provider';
import { TRANSACTION_COOKIE_NAME } from '../_oidc-provider/cookies';
import { resolveGrantableScopes } from '../_oidc-provider/scopes';
import { requireSameOriginFormPost, requireTransaction } from '../_oidc-provider/transaction';

/**
 * Consent Server Action: records the End-User's decision and sends the browser
 * back to the client with the authorization response (OIDC Core 1.0 §3.1.2.5 /
 * §3.1.2.6).
 */
export async function consentAction(formData: FormData): Promise<void> {
  const action = String(formData.get('action') ?? '');
  // First the browser's own statement of where the form was submitted from:
  // independent of the cookie and the csrf_token below. This action mints the
  // authorization code, so no decision may come from anywhere else.
  await requireSameOriginFormPost();

  // The transaction cookie says which transaction this browser is in ...
  const current = await requireTransaction();
  const transactionId = current.transactionId;
  const transaction: ResponseModeTransaction = current.transaction;

  // ... and the CSRF token proves the decision came from the form this browser
  // was shown for exactly that transaction. Checked before any decision is acted
  // on: this step mints the authorization code.
  try {
    validateCsrfToken(transaction, String(formData.get('csrf_token') ?? ''));
  } catch (error) {
    if (error instanceof AuthTransactionError) redirect(errorPagePath(error.code, error.message));
    throw error;
  }

  // The response mode the authorization request asked for (JARM's query.jwt),
  // restored before anything is recorded, so a key outage stops here instead
  // of after the code and the consent were stored.
  let responseMode: AuthorizationResponseMode | undefined;
  try {
    responseMode = await restoreResponseMode(transaction, { issuer: config.issuer, loadSigningKeys });
  } catch {
    redirect(errorPagePath('server_error', 'Failed to load the response signing key'));
  }

  if (action === 'deny') {
    await stores.transactionStore.delete('auth_txn:' + transactionId);
    await stores.authSessionStore.delete(transactionId);
    // The transaction is over; drop the cookie that named it.
    (await cookies()).delete({
      name: TRANSACTION_COOKIE_NAME,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    });
    redirect(await authorizationResponseUrl(responseMode, transaction.redirectUri, {
      error: 'access_denied',
      state: transaction.state,
    }, config.issuer));
  }

  // OIDC Core 1.0 §3.1.2.4: "the Authorization Server MUST obtain an
  // authorization decision before releasing information to the Relying Party."
  // This action mints the authorization code, so the affirmative decision is
  // detected on an allowlist: a missing, empty or unknown 'action' means no
  // decision was obtained and must not approve. 'approve' MUST stay in sync with
  // the Approve button in page.tsx.
  //
  // §3.1.2.6: access_denied means the End-User denied the request, which is not
  // the same as no decision at all — an unrecognized value therefore goes to the
  // OP's own error page instead of back to the client.
  if (action !== 'approve') {
    redirect(
      errorPagePath('invalid_request', 'Invalid consent decision. Please use the Approve or Deny button.'),
    );
  }

  // The login step's hand-off: no authenticated subject means the login step
  // was skipped or has expired.
  const session = await stores.authSessionStore.get(transactionId);
  if (!session) {
    redirect('/login');
  }

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

  // Record the consent so a later prompt=none (or SSO) request can confirm it
  // without UI (OIDC Core 1.0 §3.1.2.1 / §3.1.2.4), and the grant, so
  // withdrawing that consent revokes the tokens issued from it. Only the
  // per-transaction hand-off is cleared; the OP session persists for SSO.
  await resolvers.consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);
  await resolvers.consentResolver.recordGrant(session.subject, transaction.clientId, authCodeData.grantId);
  await stores.authSessionStore.delete(transactionId);

  // The transaction is over; drop the cookie that named it.
  (await cookies()).delete({
    name: TRANSACTION_COOKIE_NAME,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  });
  redirect(await authorizationResponseUrl(responseMode, transaction.redirectUri, {
    code: authCodeData.code,
    state: responseParams.state,
  }, config.issuer));
}
