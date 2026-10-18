/** @jsxImportSource hono/jsx */
import type { AuthTransaction } from '@maronn-openid-connect/core';
import { issueGoogleLoginNonce } from '@maronn-openid-connect/google-login';
import {
  buildGoogleSignInAttributes,
  type GoogleSignInAttributes,
} from '@maronn-openid-connect/google-login/sign-in';
import type { LoginMethod } from '../../endpoints/login/login-method.js';
import { contribute } from '../../endpoints/step.js';
import type { GoogleLoginConfig } from './config.js';
import { googleViews } from './views.js';

/**
 * What this method adds to the describe-login-screen box of the login
 * endpoint: buildGoogleSignIn() runs inside it, and reads the transactionId.
 */
export const contribution = contribute({
  endpoint: 'login',
  step: 'describe-login-screen',
  feature: 'google-login',
  calls: ['buildGoogleSignIn'],
  consumes: ['transactionId'],
});

/**
 * EXTENSION (google-login): build the GIS configuration (the g_id_onload
 * attributes) for this transaction, or undefined when config.googleLogin is not
 * set. Every description of the form issues a fresh nonce bound to the
 * transaction: Google echoes it in the ID token, which is how the callback
 * (endpoints/login-google/) finds its way back to this authorization request
 * (the redirect-mode POST carries nothing else).
 */
export async function buildGoogleSignIn(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<GoogleSignInAttributes | undefined> {
  const config = c.get('config');
  const googleLogin: GoogleLoginConfig | undefined = config.googleLogin;
  if (!googleLogin) return undefined;
  const nonce = await issueGoogleLoginNonce({
    transactionId,
    expiresAt: transaction.expiresAt,
    store: c.get('googleLoginNonceStore'),
  });
  return buildGoogleSignInAttributes({
    clientId: googleLogin.clientId,
    // Must equal an authorized redirect URI of the Google OAuth client. Built on
    // config.issuer for the same reason as the /consent redirect (RFC 9700 §2.1).
    loginUri: new URL('/login/google', config.issuer).toString(),
    nonce,
    // OIDC Core 1.0 §3.1.2.1: pass login_hint on so Google can preselect the account.
    loginHint: transaction.loginHint,
    hostedDomain: typeof googleLogin.hostedDomain === 'string' ? googleLogin.hostedDomain : undefined,
  });
}

/** The "Sign in with Google" button of the login page; nothing until config.googleLogin is set. */
export const googleLoginMethod: LoginMethod = {
  id: 'google',
  async render(c, { transactionId, transaction }) {
    const googleSignIn = await buildGoogleSignIn(c, transactionId, transaction);
    if (!googleSignIn) return undefined;
    const views = googleViews(c);
    return <views.googleSignInButton googleSignIn={googleSignIn} />;
  },
};
