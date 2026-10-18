import {
  createInMemoryCibaAuthenticationRequestStore,
  createInMemoryCibaLoginTransactionStore,
} from '@maronn-openid-connect/experimental/ciba';
import { describe, expect, it } from 'vitest';
import {
  cookieHeaderOf,
  mountPage,
  pendingCibaRecord,
  signInBrowser,
} from '../../../../../test-support/browser-flows.js';
import { formPost, requestTo } from '../../../../../test-support/context.js';
import { createEmptyDatabase } from '../../../../db/memory/database.js';
import { createProviderStores } from '../../../../db/memory/stores.js';
import { registerUser } from '../../../../db/memory/users.js';
import { cibaPage } from './page.js';

/** The CIBA screens on a database with alice, and fresh CIBA stores holding one pending request for her. */
async function cibaApp() {
  const db = createEmptyDatabase();
  await registerUser(db, { sub: 'alice', password: 'correct-password' });
  const requestStore = createInMemoryCibaAuthenticationRequestStore();
  const record = pendingCibaRecord({ bindingMessage: 'W4SCT' });
  await requestStore.save(record);
  const app = mountPage('/ciba', cibaPage, {
    db,
    values: {
      cibaAuthenticationRequestStore: requestStore,
      cibaLoginTransactionStore: createInMemoryCibaLoginTransactionStore(),
    },
  });
  return { app, db, record };
}

/** The value of the hidden field name in a rendered form. */
function hiddenValueOf(html: string, name: string): string {
  return new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '';
}

describe('cibaPage', () => {
  describe('GET /ciba', () => {
    it('should render the sign-in form with the login binding cookie without an OP session', async () => {
      const { app } = await cibaApp();

      const response = await app.request(requestTo('/ciba'));
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain('<form method="post" action="/ciba/login">');
      expect(response.headers.getSetCookie()).toEqual([
        expect.stringMatching(
          new RegExp(
            `^oidc_ciba_login_${hiddenValueOf(html, 'login_transaction_id')}=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600$`,
          ),
        ),
      ]);
    });

    // CIBA Core 1.0 §7.1: the binding_message is shown for the End-User to compare.
    it("should render the signed-in user's pending requests with their binding_message", async () => {
      const { app, db, record } = await cibaApp();
      const session = await signInBrowser(createProviderStores(db), 'alice');

      const response = await app.request(requestTo('/ciba', { headers: { Cookie: session.cookie } }));
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain('Confirm that your device is showing this message: <strong>W4SCT</strong>');
      expect(hiddenValueOf(html, 'auth_req_id')).toBe(record.authReqId);
      expect(hiddenValueOf(html, 'csrf_token')).toBe(record.csrfToken);
    });
  });

  describe('POST /ciba/login', () => {
    it('should answer 403 with the error page without the login binding cookie', async () => {
      const { app } = await cibaApp();
      const form = await (await app.request(requestTo('/ciba'))).text();

      const response = await app.request(
        formPost('/ciba/login', {
          login_transaction_id: hiddenValueOf(form, 'login_transaction_id'),
          csrf_token: hiddenValueOf(form, 'csrf_token'),
          username: 'alice',
          password: 'correct-password',
        }),
      );

      expect(response.status).toBe(403);
      expect(await response.text()).toContain('<p>The sign-in request could not be verified</p>');
    });
  });

  describe('POST /ciba/approve', () => {
    it('should answer 401 with the error page without an OP session', async () => {
      const { app, record } = await cibaApp();

      const response = await app.request(
        formPost('/ciba/approve', { auth_req_id: record.authReqId, csrf_token: 'x', decision: 'approve' }),
      );

      expect(response.status).toBe(401);
      expect(await response.text()).toContain('<p>Sign in again to review this request</p>');
    });

    it('should answer 400 with the error page for a decision other than approve or deny', async () => {
      const { app, db, record } = await cibaApp();
      const session = await signInBrowser(createProviderStores(db), 'alice');

      const response = await app.request(
        formPost('/ciba/approve', { auth_req_id: record.authReqId, csrf_token: 'x', decision: 'later' }, {
          Cookie: session.cookie,
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('<p>invalid_request</p><p>decision must be approve or deny</p>');
    });
  });

  it('should walk a browser through sign-in and approval to the completed screen', async () => {
    const { app, record } = await cibaApp();

    const entry = await app.request(requestTo('/ciba'));
    const entryHtml = await entry.text();
    const login = await app.request(
      formPost('/ciba/login', {
        login_transaction_id: hiddenValueOf(entryHtml, 'login_transaction_id'),
        csrf_token: hiddenValueOf(entryHtml, 'csrf_token'),
        username: 'alice',
        password: 'correct-password',
      }, { Cookie: cookieHeaderOf(entry.headers.getSetCookie()) }),
    );
    const listing = await login.text();
    const approval = await app.request(
      formPost('/ciba/approve', {
        auth_req_id: hiddenValueOf(listing, 'auth_req_id'),
        csrf_token: hiddenValueOf(listing, 'csrf_token'),
        decision: 'approve',
      }, { Cookie: cookieHeaderOf(login.headers.getSetCookie()) }),
    );

    expect(approval.status).toBe(200);
    expect(await approval.text()).toContain('<p>You approved <strong>ciba-client</strong>.</p>');
    expect(record).toMatchObject({ status: 'approved', approvedScope: ['openid', 'profile'] });
  });
});
