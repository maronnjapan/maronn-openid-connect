import { cookies } from 'next/headers';
import { getAuthTransaction, validateTransactionBinding } from '@maronn-openid-connect/core';
import { oidcProviderOptions } from '../_oidc-provider/runtime';
import {
  defaultProviderStores,
  TRANSACTION_BINDING_COOKIE_PREFIX,
} from '../_oidc-provider/store';
import { loginAction } from './actions';

const transactionStore =
  (oidcProviderOptions.storage ?? defaultProviderStores).transactionStore;

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
 * Is this request coming from the User-Agent that started the transaction?
 * The authorization endpoint handed that browser a secret in an HttpOnly cookie
 * named per transaction; only its hash is stored (OIDC Core 1.0 Section 3.1.2.3
 * / 3.1.2.4). See buildTransactionBindingCookie() in _oidc-provider/store.ts.
 */
async function isBoundToThisBrowser(
  transaction: Awaited<ReturnType<typeof getAuthTransaction>>,
  transactionId: string,
): Promise<boolean> {
  const cookieStore = await cookies();
  const bindingSecret = cookieStore.get(TRANSACTION_BINDING_COOKIE_PREFIX + transactionId)?.value;
  try {
    await validateTransactionBinding(transaction, bindingSecret);
    return true;
  } catch {
    return false;
  }
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

  // OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4: this form embeds csrf_token, so only
  // the User-Agent that started the transaction may render it. transaction_id
  // alone is not proof — it rides in the URL and can leak. See store.ts.
  if (!(await isBoundToThisBrowser(transaction, transactionId))) {
    return (
      <main>
        <h1>Login</h1>
        <p role="alert">This authorization transaction was not started by this browser.</p>
      </main>
    );
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
    </main>
  );
}
