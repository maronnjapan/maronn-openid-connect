import { loginMethodsOf } from '../_oidc-provider/feature';
import { features } from '../_oidc-provider/features';
import { config, stores } from '../_oidc-provider/provider';
import { requireTransaction } from '../_oidc-provider/transaction';
import { buildTransactionPath } from '@maronn-openid-connect/core';

// The page renders the transaction named by this browser's transaction cookie,
// so it must always render dynamically (never from a static cache). No cache
// may store it either: a page cannot set response headers, so the headers() of
// next.config.mjs send it with Cache-Control: no-store, as every other screen.
// Without them, Next.js sends a dynamic page with Cache-Control: private,
// no-cache, no-store, max-age=0, must-revalidate.
export const dynamic = 'force-dynamic';

interface LoginPageProps {
  searchParams: Promise<{
    transaction_id?: string | string[];
    error?: string;
    remaining?: string;
  }>;
}

/**
 * Render the login form only when the URL transaction ID matches the cookie.
 * Preserve transaction_id in the action URL and hidden field, and csrf_token in
 * its hidden field: the submit handler requires all references to match.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error, remaining, transaction_id } = await searchParams;
  const { transactionId, transaction } = await requireTransaction(transaction_id);

  // The other ways to sign in (the loginMethods of the features, such as
  // Sign in with Google): each shows what it renders for this transaction.
  const loginMethods = [];
  for (const method of loginMethodsOf(features)) {
    const rendered = await method.render({ transactionId, transaction, config, stores });
    if (rendered !== undefined) loginMethods.push({ id: method.id, rendered });
  }

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
      <form method="post" action={buildTransactionPath('/login/submit', transactionId)}>
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
      {loginMethods.map(({ id, rendered }) => (
        <div key={id}>{rendered}</div>
      ))}
    </main>
  );
}
