import { recordCibaLoginFailure, validateCibaLoginSubmission } from '@maronn-openid-connect/experimental/ciba';
import { generateRandomString } from '@maronn-openid-connect/core';
import {
  buildClearedCibaLoginBindingCookie,
  parseCibaLoginBindingSecret,
} from '../../../cookies.js';
import { buildSessionCookie } from '../../../../../cookies.js';
import { cibaConfig } from '../../../config.js';
import { type CibaOutcome, type CibaLoginSubmission, verificationFailure, listPendingRequests } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'submit-login',
  endpoint: 'ciba',
  feature: 'ciba',
  kind: 'validate',
  label: 'Sign the End-User in on this browser',
  function: 'submitCibaLogin',
  calls: ['validateCibaLoginSubmission', 'recordCibaLoginFailure', 'buildSessionCookie'],
  consumes: ['loginTransaction'],
  produces: ['session'],
  removable: false,
});

/**
 * Sign in (POST /ciba/login)
 *
 * Binding first, then CSRF, then credentials: the binding is what proves this
 * is the browser the login form was issued to, and it must gate the step that
 * would otherwise let a forged POST establish an OP session in the victim's
 * browser.
 */
export async function submitCibaLogin(c: any, input: CibaLoginSubmission): Promise<CibaOutcome> {
  const { loginTransactionId: transactionId, csrfToken, username, password } = input;

  const browserSessionStore = c.get('browserSessionStore');
  const loginTransactionStore = c.get('cibaLoginTransactionStore');
  const authenticateUser = c.get('authenticateUser');

  let transaction;
  try {
    transaction = await validateCibaLoginSubmission({
      transactionId,
      csrfToken,
      bindingSecret: parseCibaLoginBindingSecret(c.req.header('Cookie') ?? null, transactionId),
      store: loginTransactionStore,
    });
  } catch (error) {
    return verificationFailure(error);
  }

  // Swap point: replace this with your own credential check (LDAP, WebAuthn, an
  // upstream IdP) without touching anything above or below it.
  const user = await authenticateUser(username, password);
  if (!user) {
    // Per-transaction throttling only. Anyone can mint fresh login
    // transactions by reloading /ciba, so the aggregate password-guess budget
    // is the same as the one on /login. Subject-scoped throttling is a
    // separate concern.
    const failure = await recordCibaLoginFailure(
      transaction,
      loginTransactionStore,
      cibaConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // The transaction is gone: this form cannot be retried at all.
      return { kind: 'locked_out' };
    }
    return {
      kind: 'invalid_credentials',
      loginTransactionId: transaction.id,
      csrfToken: transaction.csrfToken,
      remainingAttempts: failure.remainingAttempts,
    };
  }

  // The transaction is single-use: a successful login consumes it, and the
  // session is established under a NEWLY minted id (never one the request
  // brought along — session fixation).
  await loginTransactionStore.delete(transaction.id);
  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });

  // Two cookies travel with the listing: the new OP session, and the cleared
  // login binding (it is single-use and would otherwise linger until Max-Age).
  return {
    kind: 'pending_requests',
    requests: await listPendingRequests(c, user.sub),
    cookies: [buildSessionCookie(sessionId), buildClearedCibaLoginBindingCookie(transaction.id)],
  };
}
