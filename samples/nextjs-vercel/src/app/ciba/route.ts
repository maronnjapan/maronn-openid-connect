/**
 * EXPERIMENTAL — CIBA authentication device UI, entry (CIBA Core 1.0 §7.1).
 *
 * CIBA leaves the authentication device — how the user is reached and how they
 * authenticate — outside the specification. This UI is an OP-hosted page the
 * user visits themselves: sign in at /ciba, review the pending requests
 * addressed to you (client, scopes, binding_message), approve or deny. The
 * consumption device learns the outcome only by polling the token endpoint.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { createCibaLoginTransaction } from '@maronn-openid-connect/experimental/ciba';
import { cibaLoginTransactionStore, stores } from '../_oidc-provider/provider';
import { buildCibaLoginBindingCookie, parseSessionId } from '../_oidc-provider/store';
import { loginScreen, pendingRequestsScreen, remainingSeconds } from './screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * With an OP session: the pending requests addressed to the signed-in user.
 * Without one: a fresh login transaction and its sign-in form, bound to this
 * browser by a cookie. A hidden csrf_token alone cannot stop login CSRF — the
 * attacker can fetch a valid pair from their own form — so the submission must
 * also present this browser's binding (see buildCibaLoginBindingCookie() in
 * store.ts).
 */
export async function GET(request: Request): Promise<Response> {
  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return pendingRequestsScreen(session.subject);
  }

  const { record, bindingSecret } = await createCibaLoginTransaction(cibaLoginTransactionStore);
  return loginScreen(
    { loginTransactionId: record.id, csrfToken: record.csrfToken },
    [buildCibaLoginBindingCookie(record.id, bindingSecret, remainingSeconds(record.expiresAt))],
  );
}
