import { afterEach, describe, expect, it } from 'vitest';
import type { OidcProviderOptions } from '../../../../../app.js';
import { signIdToken, signInBrowser } from '../../../../../../test-support/browser-flows.js';
import { providerContext, requestTo } from '../../../../../../test-support/context.js';
import { buildClearedSessionCookie } from '../../../../../cookies.js';
import { createEmptyDatabase } from '../../../../../db/memory/database.js';
import { createProviderStores } from '../../../../../db/memory/stores.js';
import { rpInitiatedLogoutConfig } from '../../../config.js';
import { parseLogoutConfirmation } from '../../../cookies.js';
import type { LogoutOutcome } from '../outcome.js';
import { processEndSessionRequest } from './process-end-session-request.js';

/** A context for GET /logout from a browser with alice's OP session (unless signedIn is false). */
async function logoutContext(input: { signedIn?: boolean; options?: Partial<OidcProviderOptions> } = {}) {
  const db = createEmptyDatabase();
  const session = await signInBrowser(createProviderStores(db), 'alice');
  const headers: Record<string, string> = input.signedIn === false ? {} : { Cookie: session.cookie };
  const { c, stores } = await providerContext({ db, request: requestTo('/logout', { headers }), options: input.options });
  return { c, stores, sessionId: session.sessionId };
}

/** The confirmation the cookie of a confirmation outcome carries. */
function confirmationOf(outcome: LogoutOutcome) {
  const [cookie = ''] = (outcome as Extract<LogoutOutcome, { kind: 'confirmation' }>).cookies;
  return parseLogoutConfirmation(cookie.split(';')[0] ?? null);
}

describe('processEndSessionRequest', () => {
  afterEach(() => {
    delete rpInitiatedLogoutConfig.postLogoutRedirectUris['rp-client'];
    delete rpInitiatedLogoutConfig.postLogoutRedirectUris['other-client'];
  });

  // RP-Initiated Logout 1.0 §2: a hint for the current session's End-User logs out at once.
  describe('Immediate logout', () => {
    it('should delete the session and clear its cookie for a valid hint of the session user', async () => {
      const { c, stores, sessionId } = await logoutContext();
      const idTokenHint = await signIdToken({ subject: 'alice', clientId: 'rp-client' });

      expect(await processEndSessionRequest(c, new URLSearchParams({ id_token_hint: idTokenHint }))).toEqual({
        kind: 'completed',
        cookies: [buildClearedSessionCookie()],
      });
      expect(await stores.browserSessionStore.get(sessionId)).toBeUndefined();
    });

    // RP-Initiated Logout 1.0 §3: only an exactly registered URI, with state appended.
    it('should redirect to the registered post_logout_redirect_uri with state appended', async () => {
      rpInitiatedLogoutConfig.postLogoutRedirectUris['rp-client'] = ['https://rp.example.com/bye'];
      const { c } = await logoutContext();
      const idTokenHint = await signIdToken({ subject: 'alice', clientId: 'rp-client' });

      expect(
        await processEndSessionRequest(c, new URLSearchParams({
          id_token_hint: idTokenHint,
          post_logout_redirect_uri: 'https://rp.example.com/bye',
          state: 'xyz 1',
        })),
      ).toEqual({
        kind: 'redirect',
        location: 'https://rp.example.com/bye?state=xyz+1',
        cookies: [buildClearedSessionCookie()],
      });
    });

    it('should show the completed screen instead of redirecting to an unregistered URI', async () => {
      rpInitiatedLogoutConfig.postLogoutRedirectUris['rp-client'] = ['https://rp.example.com/bye'];
      const { c } = await logoutContext();
      const idTokenHint = await signIdToken({ subject: 'alice', clientId: 'rp-client' });

      expect(
        await processEndSessionRequest(c, new URLSearchParams({
          id_token_hint: idTokenHint,
          post_logout_redirect_uri: 'https://rp.example.com/bye/other',
        })),
      ).toEqual({ kind: 'completed', cookies: [buildClearedSessionCookie()] });
    });
  });

  // RP-Initiated Logout 1.0 §2 MUST: ask the End-User first; nothing is deleted yet.
  describe('Confirmation', () => {
    it('should ask for confirmation and keep the session without an id_token_hint', async () => {
      const { c, stores, sessionId } = await logoutContext();

      const outcome = await processEndSessionRequest(c, new URLSearchParams());

      expect(outcome).toMatchObject({ kind: 'confirmation' });
      expect(confirmationOf(outcome)).toEqual({
        csrfSecret: (outcome as Extract<LogoutOutcome, { kind: 'confirmation' }>).csrfToken,
        redirectTo: null,
      });
      expect(await stores.browserSessionStore.get(sessionId)).toMatchObject({ subject: 'alice' });
    });

    it("should ask for confirmation for a valid hint of another user and keep the hint's redirect", async () => {
      rpInitiatedLogoutConfig.postLogoutRedirectUris['rp-client'] = ['https://rp.example.com/bye'];
      const { c, stores, sessionId } = await logoutContext();
      const idTokenHint = await signIdToken({ subject: 'bob', clientId: 'rp-client' });

      const outcome = await processEndSessionRequest(c, new URLSearchParams({
        id_token_hint: idTokenHint,
        post_logout_redirect_uri: 'https://rp.example.com/bye',
      }));

      expect(outcome).toMatchObject({ kind: 'confirmation' });
      expect(confirmationOf(outcome)?.redirectTo).toBe('https://rp.example.com/bye');
      expect(await stores.browserSessionStore.get(sessionId)).toMatchObject({ subject: 'alice' });
    });

    it('should ask for confirmation without a redirect for a hint signed by another issuer', async () => {
      rpInitiatedLogoutConfig.postLogoutRedirectUris['rp-client'] = ['https://rp.example.com/bye'];
      const { c } = await logoutContext();
      const idTokenHint = await signIdToken({ subject: 'alice', clientId: 'rp-client', issuer: 'https://evil.example.com' });

      const outcome = await processEndSessionRequest(c, new URLSearchParams({
        id_token_hint: idTokenHint,
        post_logout_redirect_uri: 'https://rp.example.com/bye',
      }));

      expect(outcome).toMatchObject({ kind: 'confirmation' });
      expect(confirmationOf(outcome)?.redirectTo).toBeNull();
    });

    // RP-Initiated Logout 1.0 §2: client_id must match the client the hint was issued to.
    it('should ask for confirmation without a redirect when client_id is not the audience of the hint', async () => {
      rpInitiatedLogoutConfig.postLogoutRedirectUris['other-client'] = ['https://rp.example.com/bye'];
      const { c } = await logoutContext();
      const idTokenHint = await signIdToken({ subject: 'alice', clientId: 'rp-client' });

      const outcome = await processEndSessionRequest(c, new URLSearchParams({
        id_token_hint: idTokenHint,
        client_id: 'other-client',
        post_logout_redirect_uri: 'https://rp.example.com/bye',
      }));

      expect(outcome).toMatchObject({ kind: 'confirmation' });
      expect(confirmationOf(outcome)?.redirectTo).toBeNull();
    });
  });

  // An outage of the key set must not degrade silently into "invalid hint".
  it('should rethrow a failure of the JWKS provider', async () => {
    const outage = new Error('JWKS unavailable');
    const { c } = await logoutContext({ options: { jwksProvider: () => Promise.reject(outage) } });
    const idTokenHint = await signIdToken({ subject: 'alice', clientId: 'rp-client' });

    await expect(processEndSessionRequest(c, new URLSearchParams({ id_token_hint: idTokenHint }))).rejects.toBe(outage);
  });
});
