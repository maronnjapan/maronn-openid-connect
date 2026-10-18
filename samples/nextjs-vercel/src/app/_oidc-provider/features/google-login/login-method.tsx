/**
 * EXTENSION (google-login): the "Sign in with Google" button of the login page.
 */
import Script from 'next/script';
import { issueGoogleLoginNonce } from '@maronn-openid-connect/google-login';
import {
  buildGoogleSignInAttributes,
  GOOGLE_GSI_CLIENT_SCRIPT_URL,
  type GoogleSignInAttributes,
} from '@maronn-openid-connect/google-login/sign-in';
import type { AuthTransaction } from '@maronn-openid-connect/core';
import type { LoginMethod } from '../../../login/login-method';
import type { ProviderConfig } from '../../config';
import type { ProviderStores } from '../../store';
import { createGoogleLoginNonceStore } from './store';

/**
 * The GIS configuration (g_id_onload attributes), built only when
 * config.googleLogin is set. Each render issues a fresh nonce bound to this
 * transaction; Google echoes it in the ID token, which is how
 * (google-login)/login/google/route.ts finds its way back to this
 * authorization request.
 */
export async function buildGoogleSignIn(input: {
  transactionId: string;
  transaction: AuthTransaction;
  config: ProviderConfig;
  stores: ProviderStores;
}): Promise<GoogleSignInAttributes | undefined> {
  const { transactionId, transaction, config, stores } = input;
  const googleLogin = config.googleLogin;
  if (!googleLogin) return undefined;
  return buildGoogleSignInAttributes({
    clientId: googleLogin.clientId,
    // Must equal an authorized redirect URI of the Google OAuth client. Built
    // on config.issuer, like every URL the OP builds for itself.
    loginUri: new URL('/login/google', config.issuer).toString(),
    nonce: await issueGoogleLoginNonce({
      transactionId,
      expiresAt: transaction.expiresAt,
      store: createGoogleLoginNonceStore(stores.upstreamLoginStore),
    }),
    // OIDC Core 1.0 §3.1.2.1: pass login_hint on so Google can preselect the account.
    loginHint: transaction.loginHint,
    hostedDomain: typeof googleLogin.hostedDomain === 'string' ? googleLogin.hostedDomain : undefined,
  });
}

export const googleLoginMethod: LoginMethod = {
  id: 'google',
  async render(input) {
    const googleSignIn = await buildGoogleSignIn(input);
    if (!googleSignIn) return undefined;
    // The three elements GIS needs for redirect mode. googleSignIn holds the
    // g_id_onload attributes (data-ux_mode="redirect", data-login_uri,
    // data-nonce, ...) and spreads straight onto the element; GIS replaces
    // .g_id_signin with the button: style it through the GIS button attributes
    // (data-theme, data-size, data-text, ...).
    return (
      <section aria-label="Sign in with Google">
        <Script src={GOOGLE_GSI_CLIENT_SCRIPT_URL} strategy="afterInteractive" />
        <div {...googleSignIn} />
        <div className="g_id_signin" data-type="standard" />
      </section>
    );
  },
};
