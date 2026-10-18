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
import { requireSameOriginFormPost, requireTransaction } from '../_oidc-provider/transaction';
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
  // First the browser's own statement of where the form was submitted from:
  // independent of the cookie and the csrf_token below.
  await requireSameOriginFormPost();

  // The transaction cookie says which transaction this browser is in ...
  const { transactionId, transaction } = await requireTransaction();

  // ... and the CSRF token proves the submission came from the form this browser
  // was shown for exactly that transaction.
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
    redirect(`/login?error=invalid_credentials&remaining=${remaining}`);
  }

  await startSession(transactionId, transaction, user.sub);
  redirect('/consent');
}
