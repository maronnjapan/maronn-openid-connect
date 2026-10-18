import { describe, expect, it } from 'vitest';
import { cookieHeaderOf, signInBrowser } from '../../../../../../test-support/browser-flows.js';
import { providerContext, requestTo } from '../../../../../../test-support/context.js';
import { buildClearedSessionCookie } from '../../../../../cookies.js';
import { createEmptyDatabase } from '../../../../../db/memory/database.js';
import { createProviderStores } from '../../../../../db/memory/stores.js';
import { buildClearedLogoutConfirmationCookie, buildLogoutConfirmationCookie } from '../../../cookies.js';
import { approveLogout } from './approve-logout.js';

/**
 * A context for POST /logout/approve from a browser with alice's OP session
 * (unless signedIn is false) and the confirmation cookie of the given
 * confirmation (none when it is null).
 */
async function approveContext(input: {
  confirmation: { csrfSecret: string; redirectTo: string | null } | null;
  signedIn?: boolean;
}) {
  const db = createEmptyDatabase();
  const session = await signInBrowser(createProviderStores(db), 'alice');
  const cookies = [
    ...(input.signedIn === false ? [] : [session.cookie]),
    ...(input.confirmation === null ? [] : [cookieHeaderOf([buildLogoutConfirmationCookie(input.confirmation)])]),
  ];
  const { c, stores } = await providerContext({
    db,
    request: requestTo('/logout/approve', { method: 'POST', headers: { Cookie: cookies.join('; ') } }),
  });
  return { c, stores, sessionId: session.sessionId };
}

describe('approveLogout', () => {
  // RP-Initiated Logout 1.0 §2: a forged approval (no cookie, or another secret) deletes nothing.
  describe('Invalid confirmation', () => {
    it('should answer invalid_confirmation and keep the session without the confirmation cookie', async () => {
      const { c, stores, sessionId } = await approveContext({ confirmation: null });

      expect(await approveLogout(c, 'secret-1')).toEqual({ kind: 'invalid_confirmation' });
      expect(await stores.browserSessionStore.get(sessionId)).toMatchObject({ subject: 'alice' });
    });

    it('should answer invalid_confirmation when the csrf_token is not the secret of the cookie', async () => {
      const { c, stores, sessionId } = await approveContext({ confirmation: { csrfSecret: 'secret-1', redirectTo: null } });

      expect(await approveLogout(c, 'secret-2')).toEqual({ kind: 'invalid_confirmation' });
      expect(await stores.browserSessionStore.get(sessionId)).toMatchObject({ subject: 'alice' });
    });

    it('should answer invalid_confirmation for an empty csrf_token', async () => {
      const { c } = await approveContext({ confirmation: { csrfSecret: 'secret-1', redirectTo: null } });

      expect(await approveLogout(c, '')).toEqual({ kind: 'invalid_confirmation' });
    });
  });

  describe('Confirmed', () => {
    it('should delete the session and clear both cookies', async () => {
      const { c, stores, sessionId } = await approveContext({ confirmation: { csrfSecret: 'secret-1', redirectTo: null } });

      expect(await approveLogout(c, 'secret-1')).toEqual({
        kind: 'completed',
        cookies: [buildClearedSessionCookie(), buildClearedLogoutConfirmationCookie()],
      });
      expect(await stores.browserSessionStore.get(sessionId)).toBeUndefined();
    });

    // RP-Initiated Logout 1.0 §3: the redirect decided when the screen was shown is honored.
    it('should redirect to the target the confirmation cookie carries', async () => {
      const { c } = await approveContext({
        confirmation: { csrfSecret: 'secret-1', redirectTo: 'https://rp.example.com/bye?state=xyz' },
      });

      expect(await approveLogout(c, 'secret-1')).toEqual({
        kind: 'redirect',
        location: 'https://rp.example.com/bye?state=xyz',
        cookies: [buildClearedSessionCookie(), buildClearedLogoutConfirmationCookie()],
      });
    });

    // The answer is the same whether a session existed (no session-state oracle).
    it('should answer completed the same way when the browser has no session', async () => {
      const { c } = await approveContext({ confirmation: { csrfSecret: 'secret-1', redirectTo: null }, signedIn: false });

      expect(await approveLogout(c, 'secret-1')).toEqual({
        kind: 'completed',
        cookies: [buildClearedSessionCookie(), buildClearedLogoutConfirmationCookie()],
      });
    });
  });
});
