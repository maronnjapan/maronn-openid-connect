/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'vitest';
import { contextOf, formPost, requestTo } from '../../../test-support/context.js';
import {
  CSRF_TOKEN,
  TRANSACTION_ID,
  providerApp,
  storeTransaction,
  transactionCookie,
} from '../../../test-support/screens.js';
import { createEmptyDatabase } from '../../db/memory/database.js';
import { createProviderStores } from '../../db/memory/stores.js';
import { createViews, type ConsentPageParams } from '../../views.js';
import { renderConsentPage } from './page.js';

/** The provider app with a transaction this browser is in, alice signed in for it unless loggedIn is false. */
async function setUp(loggedIn = true) {
  const db = createEmptyDatabase();
  await storeTransaction(db);
  if (loggedIn) {
    await createProviderStores(db).authSessionStore.set(TRANSACTION_ID, { subject: 'alice', authTime: 1700000000 });
  }
  return { db, app: await providerApp(db) };
}

function consentPost(action: string): Request {
  return formPost(
    '/consent',
    { csrf_token: CSRF_TOKEN, action },
    { Cookie: transactionCookie(), 'Sec-Fetch-Site': 'same-origin' },
  );
}

describe('renderConsentPage', () => {
  it('should render the default consent view', async () => {
    const response = renderConsentPage(contextOf(), { csrfToken: 'csrf-1', clientId: 'client-1', scopes: ['openid'] });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<ul><li>openid</li></ul>');
  });

  it('should render the consent view of the request context', async () => {
    const views = createViews({
      consentPage: (params: ConsentPageParams) => (
        <form>
          {params.clientId}:{params.scopes.join(',')}
        </form>
      ),
    });

    const response = renderConsentPage(contextOf(undefined, { views }), {
      csrfToken: 'csrf-1',
      clientId: 'client-1',
      scopes: ['openid', 'email'],
    });

    expect(await response.text()).toBe('<form>client-1:openid,email</form>');
  });
});

describe('consentPage', () => {
  describe('GET /consent', () => {
    it('should render the client, the scopes and the csrf_token of the transaction', async () => {
      const { app } = await setUp();

      const response = await app.request(requestTo('/consent', { headers: { Cookie: transactionCookie() } }));
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain('<strong>client-1</strong>');
      expect(html).toContain('<ul><li>openid</li><li>profile</li></ul>');
      expect(html).toContain(`<input type="hidden" name="csrf_token" value="${CSRF_TOKEN}"/>`);
    });

    it('should answer the error page with 400 when the browser is in no transaction', async () => {
      const { app } = await setUp();

      expect((await app.request(requestTo('/consent'))).status).toBe(400);
    });
  });

  describe('POST /consent', () => {
    // OIDC Core 1.0 §3.1.2.5 / RFC 9207 §2
    it('should redirect to the client with the code and iss and clear the transaction cookie', async () => {
      const { app, db } = await setUp();

      const response = await app.request(consentPost('approve'));
      const [code] = [...db.codes.keys()];

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe(
        `https://rp.example.com/callback?code=${code}&state=state-1&iss=https%3A%2F%2Fop.example.com`,
      );
      expect(response.headers.getSetCookie()).toEqual([
        '__Host-oidc_txn=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
      ]);
    });

    // OIDC Core 1.0 §3.1.2.6
    it('should redirect to the client with access_denied when the End-User denies', async () => {
      const { app } = await setUp();

      const response = await app.request(consentPost('deny'));

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe(
        'https://rp.example.com/callback?error=access_denied&state=state-1&iss=https%3A%2F%2Fop.example.com',
      );
    });

    // OIDC Core 1.0 §3.1.2.4: no decision keeps the browser on the OP.
    it('should answer 400 on the OP for an unknown decision', async () => {
      const { app } = await setUp();

      const response = await app.request(consentPost('later'));

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('<p>Invalid consent decision. Please use the Approve or Deny button.</p>');
    });

    it('should answer 400 on the OP when no End-User signed in for the transaction', async () => {
      const { app } = await setUp(false);

      const response = await app.request(consentPost('approve'));

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('<p>Authentication session not found. Please restart login.</p>');
    });
  });
});
