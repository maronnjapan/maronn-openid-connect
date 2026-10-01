/**
 * Login screen (screen routing layer).
 *
 * GET /login renders the form. The logic behind the form — credential check,
 * lockout, session cookie, hand-off to /consent — is POST /login in
 * routes/login.ts, which comes back to renderLoginPage() whenever it has to
 * show the form again. To customize the login UI, edit this file or the
 * loginPage view in views.ts; routes/login.ts never has to change.
 */
import { WebRouter } from '../web-router';
import {
  getAuthTransaction,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import { issueGoogleLoginNonce } from '@maronn-openid-connect/google-login';
import {
  buildGoogleSignInAttributes,
  type GoogleSignInAttributes,
} from '@maronn-openid-connect/google-login/sign-in';
import {
  transactionStore as defaultTransactionStore,
  googleLoginNonceStore as defaultGoogleLoginNonceStore,
} from '../store';
import { defaultProviderConfig, type GoogleLoginConfig } from '../config';
import { defaultViews, renderView, type LoginPageParams } from '../views';

export const loginPage = new WebRouter();

/**
 * Render the login form.
 *
 * Shared by GET /login (below) and by the failed-attempt path of POST /login
 * (routes/login.ts), so both come out of one function: swap the view, return a
 * framework-rendered Response, or redirect to a UI of your own — here only.
 */
export function renderLoginPage(c: any, params: LoginPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.loginPage(params));
}

/**
 * EXTENSION (google-login): build the GIS configuration (the g_id_onload
 * attributes) for this transaction, or undefined when config.googleLogin is not
 * set. Rendering is the view's job (views.ts): the package generates no UI.
 * Every render issues a fresh nonce bound to the transaction: Google echoes it
 * in the ID token, which is how the callback (routes/login.ts) finds its way
 * back to this authorization request (the redirect-mode POST carries nothing
 * else). Shared by GET /login and the failed-attempt re-render of POST /login.
 */
export async function buildGoogleSignIn(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<GoogleSignInAttributes | undefined> {
  const config = c.get('config') ?? defaultProviderConfig;
  const googleLogin: GoogleLoginConfig | undefined = config.googleLogin;
  if (!googleLogin) return undefined;
  const nonceStore = c.get('googleLoginNonceStore') ?? defaultGoogleLoginNonceStore;
  const nonce = await issueGoogleLoginNonce({
    transactionId,
    expiresAt: transaction.expiresAt,
    store: nonceStore,
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

/**
 * Login Page - GET
 * Displays the login form for user authentication.
 */
loginPage.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  if (!transactionId) {
    return c.text('Missing transaction_id', 400);
  }

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const transaction = await getAuthTransaction(transactionId, transactionStore);

  return renderLoginPage(c, {
    transactionId,
    csrfToken: transaction.csrfToken,
    // OIDC Core 1.0 §3.1.2.1: pre-fill the login form with login_hint (RECOMMENDED).
    loginHint: transaction.loginHint,
    // EXTENSION (google-login): undefined until config.googleLogin is set.
    googleSignIn: await buildGoogleSignIn(c, transactionId, transaction),
  });
});
