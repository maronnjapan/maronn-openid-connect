import type { LoginError } from '../../../../endpoints/login/screen.js';
import { discardSessionForFreshLogin } from './steps/discard-session-for-fresh-login.js';
import { establishBrowserSession } from './steps/establish-session.js';
import { handOffToConsent } from './steps/hand-off-to-consent.js';
import { loadTransactionById } from './steps/load-transaction.js';
import { verifyGoogleLoginCallback } from './steps/verify-google-callback.js';

/**
 * EXTENSION (google-login) — the Google login callback (login_uri), API layer.
 *
 * Sign in with Google (redirect mode) posts the ID token to POST
 * /login/google once the user picks an account. completeGoogleLogin() checks
 * it and establishes the OP session exactly like a password login — the last
 * steps are the login endpoint's own — and reports the outcome; page.ts
 * turns it into HTTP. Each block calls one step (one box of
 * `maronn-oidc graph --detail steps --endpoint login-google`).
 */

/** What the Google login callback decided; page.ts turns it into HTTP. */
export type GoogleLoginOutcome =
  | LoginError
  /** config.googleLogin is not set: the callback does not exist (404). */
  | { kind: 'not_configured' }
  /** Signed in: the OP session cookie(s) to set, then continue to the consent step. */
  | { kind: 'authenticated'; cookies: string[] };

export async function completeGoogleLogin(c: any): Promise<GoogleLoginOutcome> {
  const config = c.get('config');
  if (!config.googleLogin) {
    return { kind: 'not_configured' };
  }

  // [verify-google-callback] Verify the posted Google ID token and nonce
  const verified = await verifyGoogleLoginCallback(c, config.googleLogin);
  if ('kind' in verified) return verified;
  const { transactionId, subject } = verified;

  // [load-transaction] The nonce named the transaction; load it from the store.
  const loaded = await loadTransactionById(c, transactionId);
  if ('kind' in loaded) return loaded;
  const { transaction } = loaded;

  // [discard-session-for-fresh-login] prompt=login: discard the existing session — OIDC Core 1.0 §3.1.2.1
  await discardSessionForFreshLogin(c, transactionId, transaction);

  // [establish-session] Establish the OP browser session — OIDC Core 1.0 §3.1.2.3
  const { sessionId, authTime } = await establishBrowserSession(c, subject);

  // [hand-off-to-consent] Store the authenticated subject for the consent step
  return handOffToConsent(c, transactionId, subject, sessionId, authTime);
}
