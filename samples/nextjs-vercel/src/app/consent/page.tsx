import { AuthTransactionError, getAuthTransaction } from '@maronn-openid-connect/core';
import { stores } from '../_oidc-provider/provider';
import { consentAction } from './actions';

export const dynamic = 'force-dynamic';

interface ConsentPageProps {
  searchParams: Promise<{ transaction_id?: string }>;
}

/**
 * Consent page (React Server Component).
 *
 * A real Next.js page, so the consent UI can be built with JSX and React
 * components. The form posts to the consentAction Server Action (actions.ts).
 */
export default async function ConsentPage({ searchParams }: ConsentPageProps) {
  const { transaction_id: transactionId } = await searchParams;

  if (!transactionId) {
    return <ConsentNotice message="Missing transaction_id" />;
  }

  let transaction;
  try {
    transaction = await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (transactionError) {
    if (!(transactionError instanceof AuthTransactionError)) throw transactionError;
    return <ConsentNotice message={transactionError.message} />;
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
      {/*
        The submit buttons carry the authorization decision (OIDC Core 1.0
        §3.1.2.4). consentAction accepts exactly 'approve' and 'deny' and rejects
        everything else, so keep both values when customizing this markup:
        renaming 'approve' makes every approval fail with an error page.
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

/** Shown instead of the form when this transaction cannot continue here. */
function ConsentNotice({ message }: { message: string }) {
  return (
    <main>
      <h1>Authorize Application</h1>
      <p role="alert">{message}</p>
    </main>
  );
}
