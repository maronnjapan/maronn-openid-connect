import { notFound } from 'next/navigation';
import Script from 'next/script';
import { issueGoogleLoginNonce } from '@maronn-openid-connect/google-login';
import {
  buildGoogleSignInAttributes,
  GOOGLE_GSI_CLIENT_SCRIPT_URL,
} from '@maronn-openid-connect/google-login/sign-in';
import { config, stores } from '../_oidc-provider/provider';
import { requireTransaction } from '../_oidc-provider/transaction';
import { loginAction } from './actions';

// /authorize redirects here with a per-request transaction_id, so the page must
// always render dynamically (never from a static cache).
export const dynamic = 'force-dynamic';

interface LoginPageProps {
  searchParams: Promise<{
    transaction_id?: string;
    error?: string;
    remaining?: string;
  }>;
}

/**
 * Login page (React Server Component).
 *
 * A real Next.js page, so the UI can be built with JSX, components, CSS modules
 * and the rest of the React ecosystem. The form posts to the loginAction Server
 * Action (actions.ts), which checks the credentials and starts the OP session.
 * Keep the hidden transaction_id / csrf_token fields when customizing it.
 *
 * A transaction_id that names no transaction renders not-found.tsx (see
 * requireTransaction() in _oidc-provider/transaction.ts).
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { transaction_id: transactionId, error, remaining } = await searchParams;
  if (!transactionId) notFound();
  const transaction = await requireTransaction(transactionId);

  // EXTENSION (google-login): the GIS configuration (g_id_onload attributes),
  // built only when config.googleLogin is set. Each render issues a fresh nonce
  // bound to this transaction; Google echoes it in the ID token, which is how
  // login/google/route.ts finds its way back to this authorization request.
  const googleLogin = config.googleLogin;
  const googleSignIn = googleLogin
    ? buildGoogleSignInAttributes({
        clientId: googleLogin.clientId,
        // Must equal an authorized redirect URI of the Google OAuth client. Built
        // on config.issuer, like every URL the OP builds for itself.
        loginUri: new URL('/login/google', config.issuer).toString(),
        nonce: await issueGoogleLoginNonce({
          transactionId,
          expiresAt: transaction.expiresAt,
          store: stores.googleLoginNonceStore,
        }),
        // OIDC Core 1.0 §3.1.2.1: pass login_hint on so Google can preselect the account.
        loginHint: transaction.loginHint,
        hostedDomain:
          typeof googleLogin.hostedDomain === 'string' ? googleLogin.hostedDomain : undefined,
      })
    : undefined;

  const errorMessage =
    error === 'invalid_credentials'
      ? `Invalid credentials${remaining ? `. Attempts remaining: ${remaining}` : ''}`
      : null;

  return (
    <main>
      <h1>Login</h1>
      {errorMessage ? (
        <p role="alert" style={{ color: 'red' }}>
          {errorMessage}
        </p>
      ) : null}
      <form action={loginAction}>
        <input type="hidden" name="transaction_id" value={transactionId} />
        <input type="hidden" name="csrf_token" value={transaction.csrfToken} />
        <div>
          <label htmlFor="username">Username:</label>
          {/* OIDC Core 1.0 §3.1.2.1: login_hint MAY pre-fill the username. It is
              an untrusted hint, used for the initial value only. */}
          <input
            type="text"
            id="username"
            name="username"
            defaultValue={transaction.loginHint}
            required
          />
        </div>
        <div>
          <label htmlFor="password">Password:</label>
          <input type="password" id="password" name="password" required />
        </div>
        <button type="submit">Login</button>
      </form>
      {/*
        EXTENSION (google-login): the three elements GIS needs for redirect mode.
        googleSignIn holds the g_id_onload attributes (data-ux_mode="redirect",
        data-login_uri, data-nonce, ...) and spreads straight onto the element;
        GIS replaces .g_id_signin with the button — style it through the GIS
        button attributes (data-theme, data-size, data-text, ...).
      */}
      {googleSignIn ? (
        <section aria-label="Sign in with Google">
          <Script src={GOOGLE_GSI_CLIENT_SCRIPT_URL} strategy="afterInteractive" />
          <div {...googleSignIn} />
          <div className="g_id_signin" data-type="standard" />
        </section>
      ) : null}
    </main>
  );
}
