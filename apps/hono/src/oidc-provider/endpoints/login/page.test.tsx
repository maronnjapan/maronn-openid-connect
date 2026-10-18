/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'vitest';
import { contextOf, formPost, requestTo } from '../../../test-support/context.js';
import {
  CSRF_TOKEN,
  providerApp,
  sampleTransaction,
  storeTransaction,
  transactionCookie,
} from '../../../test-support/screens.js';
import { createProviderConfig } from '../../config.js';
import { createEmptyDatabase } from '../../db/memory/database.js';
import { registerUser } from '../../db/memory/users.js';
import { createViews, type LoginPageParams } from '../../views.js';
import { consentScreenUrl, renderLoginPage } from './page.js';

/** The provider app with alice and a transaction this browser is in. */
async function setUp(transaction = sampleTransaction()) {
  const db = createEmptyDatabase();
  await registerUser(db, { sub: 'alice', password: 'correct-password' });
  await storeTransaction(db, transaction);
  return { db, app: await providerApp(db) };
}

function loginPost(password: string): Request {
  return formPost(
    '/login',
    { csrf_token: CSRF_TOKEN, username: 'alice', password },
    { Cookie: transactionCookie(), 'Sec-Fetch-Site': 'same-origin' },
  );
}

describe('renderLoginPage', () => {
  it('should render the default login view with the csrf_token', async () => {
    const response = renderLoginPage(contextOf(), { csrfToken: 'csrf-1' });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<input type="hidden" name="csrf_token" value="csrf-1"/>');
  });

  it('should render the login view of the request context', async () => {
    const views = createViews({ loginPage: (params: LoginPageParams) => <form>{params.csrfToken}</form> });

    const response = renderLoginPage(contextOf(undefined, { views }), { csrfToken: 'csrf-1' });

    expect(await response.text()).toBe('<form>csrf-1</form>');
  });
});

describe('consentScreenUrl', () => {
  // RFC 9700 §2.1: the redirect origin never comes from the Host header of the request.
  it('should build the consent URL on config.issuer, not on the request URL', () => {
    const c = contextOf(new Request('https://attacker.example.com/login'), {
      config: createProviderConfig({ issuer: 'https://op.example.com' }),
    });

    expect(consentScreenUrl(c)).toBe('https://op.example.com/consent');
  });
});

describe('loginPage', () => {
  describe('GET /login', () => {
    // OIDC Core 1.0 §3.1.2.1: login_hint pre-fills the username.
    it('should render the form for the transaction of the cookie', async () => {
      const { app } = await setUp(sampleTransaction({ loginHint: 'alice' }));

      const response = await app.request(requestTo('/login', { headers: { Cookie: transactionCookie() } }));
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain(`<input type="hidden" name="csrf_token" value="${CSRF_TOKEN}"/>`);
      expect(html).toContain('<input type="text" id="username" name="username" value="alice" required=""/>');
    });

    it('should answer the error page with 400 when the browser is in no transaction', async () => {
      const { app } = await setUp();

      const response = await app.request(requestTo('/login'));

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        '<p>No authorization request is in progress in this browser. Start again from the application.</p>',
      );
    });
  });

  describe('POST /login', () => {
    // OIDC Core 1.0 §3.1.2.3: the signed-in End-User continues to consent with the session cookie.
    it('should redirect to the consent screen with the session cookie', async () => {
      const { app, db } = await setUp();

      const response = await app.request(loginPost('correct-password'));
      const [sessionId] = [...db.browserSessions.keys()];

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('https://op.example.com/consent');
      expect(response.headers.getSetCookie()).toEqual([
        `session_id=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/`,
      ]);
    });

    it('should show the form again with the failure and the attempts left', async () => {
      const { app } = await setUp();

      const response = await app.request(loginPost('wrong-password'));

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<p style="color: red;">Invalid credentials. Attempts remaining: 4</p>');
    });

    it('should answer 429 once the attempts are used up', async () => {
      const { app } = await setUp(sampleTransaction({ failedAttempts: 4 }));

      const response = await app.request(loginPost('wrong-password'));

      expect(response.status).toBe(429);
      expect(await response.text()).toContain('<p>Too many login attempts</p>');
    });

    it('should answer 403 for a form posted from another site', async () => {
      const { app } = await setUp();

      const response = await app.request(
        formPost(
          '/login',
          { csrf_token: CSRF_TOKEN, username: 'alice', password: 'correct-password' },
          { Cookie: transactionCookie(), 'Sec-Fetch-Site': 'cross-site' },
        ),
      );

      expect(response.status).toBe(403);
      expect(await response.text()).toContain(
        '<p>This form can only be submitted from the authorization server itself.</p>',
      );
    });
  });
});
