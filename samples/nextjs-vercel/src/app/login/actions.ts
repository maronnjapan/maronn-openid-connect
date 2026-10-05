'use server';

import { redirect } from 'next/navigation';
import {
  AuthTransactionError,
  AuthTransactionErrorCode,
  handleLoginFailure,
  validateCsrfToken,
} from '@maronn-openid-connect/core';
import { errorPagePath } from '../_oidc-provider/http';
import { stores } from '../_oidc-provider/provider';
import { requireTransaction } from '../_oidc-provider/transaction';
import { startSession } from './session';

/**
 * Login Server Action.
 *
 * Checks the credentials, starts the OP session and continues to the consent
 * step. A wrong password goes back to the form with the error in the query, so
 * the page renders the message. A submission the OP refuses ends on the OP's
 * error page (oidc-error/page.tsx), never at the client.
 */
export async function loginAction(formData: FormData): Promise<void> {
  const transactionId = String(formData.get('transaction_id') ?? '');
  const transaction = await requireTransaction(transactionId);

  // The CSRF token proves the submission came from the form this browser was shown.
  try {
    validateCsrfToken(transaction, String(formData.get('csrf_token') ?? ''));
  } catch (error) {
    if (error instanceof AuthTransactionError) redirect(errorPagePath(error.code, error.message));
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
      // handleLoginFailure() deleted the transaction: this sign-in cannot continue.
      redirect(
        errorPagePath(
          AuthTransactionErrorCode.MaxAttemptsExceeded,
          'Too many login attempts. Start again from the application.',
        ),
      );
    }
    const remaining = failure.maxAttempts - failure.failedAttempts;
    redirect(
      `/login?transaction_id=${encodeURIComponent(transactionId)}&error=invalid_credentials&remaining=${remaining}`,
    );
  }

  await startSession(transactionId, transaction, user.sub);
  redirect(`/consent?transaction_id=${encodeURIComponent(transactionId)}`);
}
