/**
 * EXTENSION (google-login) — the Google login callback (login_uri).
 *
 * Sign in with Google (redirect mode) posts the ID token here once the user
 * picks an account. A Route Handler rather than a Server Action: the POST comes
 * from Google's page and carries no Server Action id. After the callback checks
 * it continues exactly like a password login: same session, same consent step.
 *
 * The transaction cookie does not come along: Google's POST is a cross-site
 * navigation, so the browser withholds SameSite=Lax cookies. The single-use
 * nonce stands in for it — it was issued on the login page, which only the
 * browser holding the cookie could load. The consent step that follows is a
 * plain navigation again and reads the cookie as usual.
 *
 * A failed callback ends on the OP's error page (oidc-error/page.tsx), like
 * every error that must not reach a client.
 */
import { notFound } from 'next/navigation';
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
import { readFormFields, redirectToErrorPage } from '../../_oidc-provider/http';
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
  // Without config.googleLogin there is no Google login to call back into.
  if (!googleLogin) notFound();

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
    // so a failed callback can only end on the OP.
    if (!(error instanceof GoogleLoginError)) throw error;
    return redirectToErrorPage(error.code, error.message);
  }

  let transaction;
  try {
    transaction = await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return redirectToErrorPage(error.code, error.message);
  }

  await startSession(transactionId, transaction, subject);
  return NextResponse.redirect(new URL('/consent', config.issuer), 302);
}
