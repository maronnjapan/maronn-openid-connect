/**
 * EXTENSION (google-login) — the Google login callback (login_uri).
 *
 * Sign in with Google (redirect mode) posts the ID token here once the user
 * picks an account. A Route Handler rather than a Server Action: the POST comes
 * from Google's page and carries no Server Action id. After the callback checks
 * it continues exactly like a password login: same session, same consent step.
 *
 * Transaction binding is deliberately NOT checked here: Google's POST is a
 * cross-site navigation, so the browser withholds SameSite=Lax cookies. The
 * single-use nonce stands in for it — it was issued to the login page, which
 * only the bound browser could load.
 */
import { NextResponse } from 'next/server';
import { AuthTransactionError, getAuthTransaction } from '@maronn-openid-connect/core';
import {
  getDefaultGoogleIdTokenVerifier,
  GoogleLoginError,
  handleGoogleLoginRedirect,
  resolveGoogleLoginSubject,
  type GoogleAccountResolver,
  type GoogleIdTokenPayload,
  type GoogleIdTokenVerifier,
} from '@maronn-openid-connect/google-login';
import { errorPage, readFormFields } from '../../_oidc-provider/html';
import { config, stores } from '../../_oidc-provider/provider';
import { startSession } from '../session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Verifies the ID token Google posts: google-auth-library
 * (OAuth2Client.verifyIdToken) with a process-wide certificate cache. Replace
 * it for tests or a proxied environment.
 */
const googleIdTokenVerifier: GoogleIdTokenVerifier = getDefaultGoogleIdTokenVerifier();

/**
 * Maps a verified Google account to the OP subject: just-in-time provisioning
 * through the user store (userStore.linkGoogleAccount), keyed by the Google sub.
 */
const googleAccountResolver: GoogleAccountResolver = {
  resolveSubject: async (account: GoogleIdTokenPayload) =>
    (await stores.userStore.linkGoogleAccount(account)).sub,
};

export async function POST(request: Request): Promise<Response> {
  const googleLogin = config.googleLogin;
  if (!googleLogin) {
    return errorPage('not_found', 404, 'Google login is not configured');
  }

  let transactionId: string;
  let subject: string;
  try {
    // Double Submit Cookie -> google-auth-library verification -> nonce lookup,
    // in the order Google's server-side verification guide prescribes.
    const login = await handleGoogleLoginRedirect({
      params: await readFormFields(request),
      cookieHeader: request.headers.get('Cookie'),
      clientId: googleLogin.clientId,
      verifier: googleIdTokenVerifier,
      nonceStore: stores.googleLoginNonceStore,
      hostedDomain: googleLogin.hostedDomain,
      requireVerifiedEmail: googleLogin.requireVerifiedEmail,
    });
    transactionId = login.transactionId;
    subject = await resolveGoogleLoginSubject(login.account, googleAccountResolver);
  } catch (error) {
    // Until the nonce is verified the OP cannot tell whose transaction this is,
    // so a failed callback is shown here and never redirected to a client.
    if (!(error instanceof GoogleLoginError)) throw error;
    return errorPage(error.code, error.httpStatusCode, error.message);
  }

  let transaction;
  try {
    transaction = await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return errorPage(error.message, error.httpStatusCode);
  }

  await startSession(transactionId, transaction, subject);
  const consentUrl = new URL('/consent', config.issuer);
  consentUrl.searchParams.set('transaction_id', transactionId);
  return NextResponse.redirect(consentUrl, 302);
}
