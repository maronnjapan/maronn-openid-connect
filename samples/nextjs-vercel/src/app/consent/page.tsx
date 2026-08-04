import { cookies } from 'next/headers';
import { getAuthTransaction, validateTransactionBinding } from '@maronn-openid-connect/core';
import { oidcProviderOptions } from '../_oidc-provider/runtime';
import {
  defaultProviderStores,
  TRANSACTION_BINDING_COOKIE_PREFIX,
} from '../_oidc-provider/store';
import { consentAction } from './actions';

const transactionStore =
  (oidcProviderOptions.storage ?? defaultProviderStores).transactionStore;

export const dynamic = 'force-dynamic';

interface ConsentPageProps {
  searchParams: Promise<{ transaction_id?: string }>;
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
 * Consent page (React Server Component).
 *
 * A real Next.js `page.tsx` so the consent UI can be customized with JSX and
 * React components. The form posts to a Server Action (./actions.ts).
 */
export default async function ConsentPage({ searchParams }: ConsentPageProps) {
  const { transaction_id: transactionId } = await searchParams;

  if (!transactionId) {
    return (
      <main>
        <h1>Authorize Application</h1>
        <p>Missing transaction_id</p>
      </main>
    );
  }

  const transaction = await getAuthTransaction(transactionId, transactionStore);

  // OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4: this form embeds csrf_token and its
  // submission mints the authorization code, so only the User-Agent that started
  // the transaction may render it. See _oidc-provider/store.ts.
  if (!(await isBoundToThisBrowser(transaction, transactionId))) {
    return (
      <main>
        <h1>Authorize Application</h1>
        <p role="alert">This authorization transaction was not started by this browser.</p>
      </main>
    );
  }

  const scopes = transaction.scope.split(' ').filter(Boolean);

  return (
    <main>
      <h1>Authorize Application</h1>
      <p>
        Client <strong>{transaction.clientId}</strong> is requesting access to the
        following scopes:
      </p>
      <ul>
        {scopes.map((scope) => (
          <li key={scope}>{scope}</li>
        ))}
      </ul>
      <form action={consentAction}>
        <input type="hidden" name="transaction_id" value={transactionId} />
        <input type="hidden" name="csrf_token" value={transaction.csrfToken} />
        <button type="submit" name="action" value="approve">
          Approve
        </button>
        <button type="submit" name="action" value="deny">
          Deny
        </button>
      </form>
    </main>
  );
}
