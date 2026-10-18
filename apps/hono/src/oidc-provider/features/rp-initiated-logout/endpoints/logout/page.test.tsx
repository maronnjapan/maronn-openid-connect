import { afterEach, describe, expect, it } from 'vitest';
import { cookieHeaderOf, mountPage, signIdToken, signInBrowser } from '../../../../../test-support/browser-flows.js';
import { formPost, requestTo } from '../../../../../test-support/context.js';
import { createEmptyDatabase } from '../../../../db/memory/database.js';
import { createProviderStores } from '../../../../db/memory/stores.js';
import { rpInitiatedLogoutConfig } from '../../config.js';
import { logoutPage } from './page.js';

/** The logout screens, and a browser with alice's OP session. */
async function logoutApp() {
  const db = createEmptyDatabase();
  const stores = createProviderStores(db);
  const session = await signInBrowser(stores, 'alice');
  return { app: mountPage('/logout', logoutPage, { db }), stores, session };
}

/** The hidden csrf_token of a rendered form. */
function csrfTokenOf(html: string): string {
  return /name="csrf_token" value="([^"]*)"/.exec(html)?.[1] ?? '';
}

describe('logoutPage', () => {
  afterEach(() => {
    delete rpInitiatedLogoutConfig.postLogoutRedirectUris['rp-client'];
  });

  // RP-Initiated Logout 1.0 §2: without a valid hint the End-User is asked first.
  it('should answer GET without a hint with the confirmation screen and its cookie, keeping the session', async () => {
    const { app, stores, session } = await logoutApp();

    const response = await app.request(requestTo('/logout', { headers: { Cookie: session.cookie } }));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<form method="post" action="/logout/approve">');
    expect(response.headers.getSetCookie()).toEqual([
      `oidc_logout_confirm=${csrfTokenOf(html)}.; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    ]);
    expect(await stores.browserSessionStore.get(session.sessionId)).toMatchObject({ subject: 'alice' });
  });

  // RP-Initiated Logout 1.0 §2: the OP MUST support POST with a form body as well.
  it('should log out at once on a POST with a valid hint of the session user', async () => {
    const { app, stores, session } = await logoutApp();
    const idTokenHint = await signIdToken({ subject: 'alice', clientId: 'rp-client' });

    const response = await app.request(formPost('/logout', { id_token_hint: idTokenHint }, { Cookie: session.cookie }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>Logged out</h1>');
    expect(response.headers.getSetCookie()).toEqual(['session_id=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0']);
    expect(await stores.browserSessionStore.get(session.sessionId)).toBeUndefined();
  });

  // RP-Initiated Logout 1.0 §3.
  it('should answer 302 to the registered post_logout_redirect_uri with state', async () => {
    rpInitiatedLogoutConfig.postLogoutRedirectUris['rp-client'] = ['https://rp.example.com/bye'];
    const { app, session } = await logoutApp();
    const idTokenHint = await signIdToken({ subject: 'alice', clientId: 'rp-client' });
    const query = new URLSearchParams({
      id_token_hint: idTokenHint,
      post_logout_redirect_uri: 'https://rp.example.com/bye',
      state: 's1',
    });

    const response = await app.request(requestTo(`/logout?${query}`, { headers: { Cookie: session.cookie } }));

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://rp.example.com/bye?state=s1');
  });

  it('should answer a forged approval with 400 and the error page, keeping the session', async () => {
    const { app, stores, session } = await logoutApp();

    const response = await app.request(formPost('/logout/approve', { csrf_token: 'forged' }, { Cookie: session.cookie }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('<p>Invalid logout confirmation</p>');
    expect(await stores.browserSessionStore.get(session.sessionId)).toMatchObject({ subject: 'alice' });
  });

  it('should log out once the browser approves the confirmation screen it was shown', async () => {
    const { app, stores, session } = await logoutApp();
    const confirmation = await app.request(requestTo('/logout', { headers: { Cookie: session.cookie } }));
    const confirmationCookie = cookieHeaderOf(confirmation.headers.getSetCookie());

    const response = await app.request(
      formPost('/logout/approve', { csrf_token: csrfTokenOf(await confirmation.text()) }, {
        Cookie: `${session.cookie}; ${confirmationCookie}`,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>Logged out</h1>');
    expect(response.headers.getSetCookie()).toEqual([
      'session_id=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
      'oidc_logout_confirm=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    ]);
    expect(await stores.browserSessionStore.get(session.sessionId)).toBeUndefined();
  });
});
