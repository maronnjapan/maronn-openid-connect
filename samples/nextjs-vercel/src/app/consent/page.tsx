import { getAuthTransaction } from '@maronn-openid-connect/core';
import { oidcProviderOptions } from '../_oidc-provider/runtime';
import { defaultProviderStores } from '../_oidc-provider/store';
import { consentAction } from './actions';

const transactionStore =
  (oidcProviderOptions.storage ?? defaultProviderStores).transactionStore;

export const dynamic = 'force-dynamic';

interface ConsentPageProps {
  searchParams: Promise<{ transaction_id?: string }>;
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
      {/*
        The submit buttons carry the authorization decision (OIDC Core 1.0
        Section 3.1.2.4). consentAction accepts exactly two values — 'approve'
        and 'deny' — and rejects everything else, so customizing this markup must
        keep both button values as they are: renaming 'approve' makes every
        approval fail with an error page. See ./actions.ts.
      */}
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
