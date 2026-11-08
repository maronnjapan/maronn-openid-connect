import { buildTransactionPath } from '@maronn-openid-connect/core';
import { stores } from '../_oidc-provider/provider';
import { resolveGrantableScopes } from '../_oidc-provider/scopes';
import { requireTransaction } from '../_oidc-provider/transaction';

// The page renders the transaction named by this browser's transaction cookie,
// so it must always render dynamically (never from a static cache). No cache
// may store it either: a page cannot set response headers, so the headers() of
// next.config.mjs send it with Cache-Control: no-store, as every other screen.
// Without them, Next.js sends a dynamic page with Cache-Control: private,
// no-cache, no-store, max-age=0, must-revalidate.
export const dynamic = 'force-dynamic';

/**
 * Render the consent form only when the URL transaction ID matches the cookie.
 * Preserve transaction_id in the action URL and hidden field, and csrf_token in
 * its hidden field: the submit handler requires all references to match.
 */
export default async function ConsentPage({ searchParams }: { searchParams: Promise<{ transaction_id?: string | string[] }> }) {
  const { transaction_id } = await searchParams;
  const { transactionId, transaction } = await requireTransaction(transaction_id);

  // Show only what THIS End-User can actually grant (resolveGrantableScopes in
  // scopes.ts). The subject comes from the login step's hand-off; without one
  // the request is shown as-is, and the decision handler stops on the same missing
  // session.
  const requestedScopes = transaction.scope.split(' ').filter(Boolean);
  const consentSession = await stores.authSessionStore.get(transactionId);
  const scopes = consentSession
    ? await resolveGrantableScopes(requestedScopes, consentSession.subject)
    : requestedScopes;

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
        §3.1.2.4). decision/route.ts accepts exactly 'approve' and 'deny' and rejects
        everything else, so keep both values when customizing this markup:
        renaming 'approve' makes every approval fail with an error page.
      */}
      <form method="post" action={buildTransactionPath('/consent/decision', transactionId)}>
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
