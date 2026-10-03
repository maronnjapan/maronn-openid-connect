'use server';

import { redirect } from 'next/navigation';
import {
  AuthTransactionError,
  completeAuthTransaction,
  createAuthorizationCode,
  getAuthTransaction,
  validateCsrfToken,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import { config, resolvers, stores } from '../_oidc-provider/provider';

/**
 * Consent Server Action: records the End-User's decision and sends the browser
 * back to the client with the authorization response (OIDC Core 1.0 §3.1.2.5 /
 * §3.1.2.6).
 */
export async function consentAction(formData: FormData): Promise<void> {
  const transactionId = String(formData.get('transaction_id') ?? '');
  const action = String(formData.get('action') ?? '');

  let transaction;
  try {
    transaction = await getAuthTransaction(transactionId, stores.transactionStore);
    validateCsrfToken(transaction, String(formData.get('csrf_token') ?? ''));
  } catch (error) {
    if (error instanceof AuthTransactionError) {
      // The OP's own error page: a transaction this browser may not continue is
      // never answered toward the client.
      redirect(`/oidc-error?${new URLSearchParams({ error: error.code, error_description: error.message })}`);
    }
    throw error;
  }

  if (action === 'deny') {
    await stores.transactionStore.delete('auth_txn:' + transactionId);
    await stores.authSessionStore.delete(transactionId);
    redirect(authorizationResponseUrl(transaction, {
      error: 'access_denied',
      state: transaction.state,
    }));
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
      '/oidc-error?error=invalid_request&error_description=' +
        encodeURIComponent('Invalid consent decision. Please use the Approve or Deny button.'),
    );
  }

  // The login step's hand-off: no authenticated subject means the login step
  // was skipped or has expired.
  const session = await stores.authSessionStore.get(transactionId);
  if (!session) {
    redirect(`/login?transaction_id=${encodeURIComponent(transactionId)}`);
  }

  const responseParams = await completeAuthTransaction(
    transactionId,
    transaction,
    stores.transactionStore,
  );

  // transaction.scope は認可リクエスト検証時に applyOfflineAccessPolicy を通した後の値。
  // offline_access の可否（OIDC Core 1.0 §11 の prompt=consent と、クライアント登録
  // grant_types に refresh_token があるか）はそこで確定しているので再フィルタしない。
  const grantedScope = transaction.scope.split(' ').filter(Boolean);

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

  redirect(authorizationResponseUrl(transaction, {
    code: authCodeData.code,
    state: responseParams.state,
  }));
}

/**
 * The authorization response URL: the parameters in the query, with iss on
 * every response, success and error alike (RFC 9207 §2).
 */
function authorizationResponseUrl(
  transaction: AuthTransaction,
  parameters: Record<string, string | undefined>,
): string {
  const url = new URL(transaction.redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  url.searchParams.set('iss', config.issuer);
  return url.toString();
}
