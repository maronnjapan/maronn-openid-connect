import { stores } from '../_oidc-provider/provider';
import { resolveGrantableScopes } from '../_oidc-provider/scopes';
import { requireTransaction } from '../_oidc-provider/transaction';

// The page renders the transaction named by this browser's transaction cookie,
// so it must always render dynamically (never from a static cache). A dynamic
// page is sent with Cache-Control: private, no-cache, no-store, max-age=0,
// must-revalidate by Next.js itself, so no browser or intermediary stores the
// csrf_token of this transaction either.
export const dynamic = 'force-dynamic';

/**
 * Consent page (React Server Component).
 *
 * A real Next.js page, so the consent UI can be built with JSX and React
 * components. The form posts to the consent decision Route Handler
 * (decision/route.ts), which answers with the authorization response: a
 * redirect, or the form a form_post response is posted from. Keep the hidden
 * csrf_token field when customizing it: neither the URL nor the form names the
 * transaction — the browser's transaction cookie does — and the handler
 * accepts the token only for that transaction.
 *
 * A browser with no live transaction renders not-found.tsx (see
 * requireTransaction() in _oidc-provider/transaction.ts).
 */
export default async function ConsentPage() {
  const { transactionId, transaction } = await requireTransaction();

  // Show only what THIS End-User can actually grant (resolveGrantableScopes in
  // scopes.ts). The subject comes from the login step's hand-off; without one
  // the request is shown as-is, and the Server Action stops on the same missing
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
      <form method="post" action="/consent/decision">
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
