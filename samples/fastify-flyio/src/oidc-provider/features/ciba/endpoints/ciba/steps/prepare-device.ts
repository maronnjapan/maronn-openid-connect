import { createCibaLoginTransaction } from '@maronn-openid-connect/experimental/ciba';
import { buildCibaLoginBindingCookie } from '../../../cookies.js';
import { parseSessionId } from '../../../../../cookies.js';
import { type CibaOutcome, remainingSeconds, listPendingRequests } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'prepare-device',
  endpoint: 'ciba',
  feature: 'ciba',
  kind: 'resolve',
  label: 'List pending requests, or start a login transaction',
  function: 'prepareCibaDevice',
  calls: ['listPendingCibaRequests', 'createCibaLoginTransaction', 'buildCibaLoginBindingCookie'],
  consumes: [],
  produces: ['loginTransaction'],
  removable: false,
});

/**
 * Listing / login form (GET /ciba)
 *
 * With an OP session: the pending requests addressed to the signed-in user.
 * Without one: mint a login transaction and describe the sign-in form, with the
 * binding cookie its submission needs.
 */
export async function prepareCibaDevice(c: any): Promise<CibaOutcome> {
  const browserSessionStore = c.get('browserSessionStore');
  const loginTransactionStore = c.get('cibaLoginTransactionStore');

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return { kind: 'pending_requests', requests: await listPendingRequests(c, session.subject), cookies: [] };
  }

  const { record, bindingSecret } = await createCibaLoginTransaction(loginTransactionStore);
  const cookie = buildCibaLoginBindingCookie(
    record.id,
    bindingSecret,
    remainingSeconds(record.expiresAt),
  );
  return {
    kind: 'login',
    loginTransactionId: record.id,
    csrfToken: record.csrfToken,
    cookies: [cookie],
  };
}
