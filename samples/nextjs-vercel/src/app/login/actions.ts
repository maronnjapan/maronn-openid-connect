'use server';

import { redirect } from 'next/navigation';
import {
  AuthTransactionError,
  getAuthTransaction,
  handleLoginFailure,
  validateCsrfToken,
} from '@maronn-openid-connect/core';
import { stores } from '../_oidc-provider/provider';
import { startSession } from './session';

/**
 * Login Server Action.
 *
 * Checks the credentials, starts the OP session and continues to the consent
 * step. A failed attempt goes back to the login page with the error in the
 * query, so the page renders the message.
 */
export async function loginAction(formData: FormData): Promise<void> {
  const transactionId = String(formData.get('transaction_id') ?? '');
  const loginPage = `/login?transaction_id=${encodeURIComponent(transactionId)}`;

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

  // Swap point: replace this with your own credential check (LDAP, WebAuthn, an
  // upstream IdP) without touching anything above or below it.
  const user = await stores.userStore.authenticate(
    String(formData.get('username') ?? ''),
    String(formData.get('password') ?? ''),
  );
  if (!user) {
    const failure = await handleLoginFailure(transactionId, transaction, stores.transactionStore);
    if (!failure.canRetry) {
      redirect(`${loginPage}&error=too_many_attempts`);
    }
    const remaining = failure.maxAttempts - failure.failedAttempts;
    redirect(`${loginPage}&error=invalid_credentials&remaining=${remaining}`);
  }

  await startSession(transactionId, transaction, user.sub);
  redirect(`/consent?transaction_id=${encodeURIComponent(transactionId)}`);
}
