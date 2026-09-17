import { getAuthTransaction } from '@maronn-openid-connect/core';
import { oidcProviderOptions } from '../_oidc-provider/runtime';
import { defaultProviderStores } from '../_oidc-provider/store';
import { buildGoogleSignInMarkup, issueGoogleLoginNonce } from '@maronn-openid-connect/google-login';
import { loginAction } from './actions';

const { transactionStore, googleLoginNonceStore } =
  oidcProviderOptions.storage ?? defaultProviderStores;

// Authorization redirects here with a per-request transaction_id, so the page
// must always render dynamically (never statically cached).
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
 * This is intentionally a real Next.js `page.tsx` so you can customize the UI
 * with JSX, components, CSS modules, and the rest of the React/Next.js
 * ecosystem. The form posts to a Server Action (./actions.ts) that runs the
 * OpenID Connect login logic on the server.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { transaction_id: transactionId, error, remaining } = await searchParams;

  if (!transactionId) {
    return (
      <main>
        <h1>Login</h1>
        <p>Missing transaction_id</p>
      </main>
    );
  }

  // Rate limit reached: handleLoginFailure() locked further attempts.
  if (error === 'too_many_attempts') {
    return (
      <main>
        <h1>Login</h1>
        <p role="alert">Too many login attempts</p>
      </main>
    );
  }

  const transaction = await getAuthTransaction(transactionId, transactionStore);

  // EXTENSION (google-login): rendered only when config.googleLogin is set. Each
  // render issues a fresh nonce bound to this transaction; Google echoes it in
  // the ID token, which is how login/google/route.ts finds the transaction.
  const googleLogin = oidcProviderOptions.config?.googleLogin;
  const googleSignInHtml = googleLogin
    ? buildGoogleSignInMarkup({
        clientId: googleLogin.clientId,
        // Must equal an authorized redirect URI of the Google OAuth client.
        loginUri: new URL(
          '/login/google',
          oidcProviderOptions.config?.issuer ?? 'http://localhost:3000',
        ).toString(),
        nonce: await issueGoogleLoginNonce({
          transactionId,
          expiresAt: transaction.expiresAt,
          store: googleLoginNonceStore,
        }),
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
          <input type="text" id="username" name="username" required />
        </div>
        <div>
          <label htmlFor="password">Password:</label>
          <input type="password" id="password" name="password" required />
        </div>
        <button type="submit">Login</button>
      </form>
      {/*
        EXTENSION (google-login): the GIS button markup (attribute-escaped by
        buildGoogleSignInMarkup) is server-rendered into the page, so the
        accounts.google.com/gsi/client script it carries runs on load.
      */}
      {googleSignInHtml ? (
        <section aria-label="Sign in with Google" dangerouslySetInnerHTML={{ __html: googleSignInHtml }} />
      ) : null}
    </main>
  );
}
