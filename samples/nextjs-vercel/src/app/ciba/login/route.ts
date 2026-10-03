/**
 * EXPERIMENTAL — CIBA authentication device UI, sign in.
 *
 * Binding first, then CSRF, then credentials: the binding proves this is the
 * browser the login form was issued to, and it must gate the step that would
 * otherwise let a forged POST plant an OP session in the victim's browser.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { recordCibaLoginFailure, validateCibaLoginSubmission } from '@maronn-openid-connect/experimental/ciba';
import { generateRandomString } from '@maronn-openid-connect/core';
import { errorPage, readFormFields } from '../../_oidc-provider/html';
import { cibaLoginTransactionStore, stores } from '../../_oidc-provider/provider';
import {
  buildClearedCibaLoginBindingCookie,
  buildSessionCookie,
  parseCibaLoginBindingSecret,
} from '../../_oidc-provider/store';
import { cibaConfig } from '../../backchannel_authentication/config';
import { loginScreen, pendingRequestsScreen, verificationFailureScreen } from '../screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const transactionId = String(form.get('login_transaction_id') ?? '');

  let transaction;
  try {
    transaction = await validateCibaLoginSubmission({
      transactionId,
      csrfToken: String(form.get('csrf_token') ?? ''),
      bindingSecret: parseCibaLoginBindingSecret(request.headers.get('Cookie'), transactionId),
      store: cibaLoginTransactionStore,
    });
  } catch (error) {
    return verificationFailureScreen(error);
  }

  // Swap point: replace this with your own credential check (LDAP, WebAuthn, an
  // upstream IdP) without touching anything above or below it.
  const user = await stores.userStore.authenticate(
    String(form.get('username') ?? ''),
    String(form.get('password') ?? ''),
  );
  if (!user) {
    // Per-transaction throttling only. Anyone can mint fresh login transactions
    // by reloading /ciba, so the aggregate password-guess budget is the same as
    // the one on /login. Subject-scoped throttling is a separate concern.
    const failure = await recordCibaLoginFailure(
      transaction,
      cibaLoginTransactionStore,
      cibaConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // The transaction is gone: this form cannot be retried at all.
      return errorPage('Too many login attempts', 429);
    }
    return loginScreen({
      loginTransactionId: transaction.id,
      csrfToken: transaction.csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: failure.remainingAttempts,
    });
  }

  // The transaction is single-use: a successful login consumes it, and the
  // session is established under a NEWLY minted id (never one the request
  // brought along — session fixation).
  await cibaLoginTransactionStore.delete(transaction.id);
  const sessionId = generateRandomString(32);
  await stores.browserSessionStore.set(sessionId, {
    subject: user.sub,
    authTime: Math.floor(Date.now() / 1000),
  });

  // Two cookies travel with the listing: the new OP session, and the cleared
  // login binding (it is single-use and would otherwise linger until Max-Age).
  return pendingRequestsScreen(user.sub, [
    buildSessionCookie(sessionId),
    buildClearedCibaLoginBindingCookie(transaction.id),
  ]);
}
