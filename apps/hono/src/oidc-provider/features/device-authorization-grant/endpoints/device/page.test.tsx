import { INVALID_USER_CODE_MESSAGE } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { describe, expect, it } from 'vitest';
import {
  cookieHeaderOf,
  mountPage,
  pendingDeviceRecord,
  signInBrowser,
} from '../../../../../test-support/browser-flows.js';
import { formPost, requestTo } from '../../../../../test-support/context.js';
import { createEmptyDatabase } from '../../../../db/memory/database.js';
import { createProviderStores } from '../../../../db/memory/stores.js';
import { registerUser } from '../../../../db/memory/users.js';
import { InMemoryDeviceAuthorizationStore } from '../../store.js';
import { devicePage } from './page.js';

/** The device screens on a database with alice, and a fresh device store holding one pending record. */
async function deviceApp() {
  const db = createEmptyDatabase();
  await registerUser(db, { sub: 'alice', password: 'correct-password' });
  const store = new InMemoryDeviceAuthorizationStore();
  const record = pendingDeviceRecord();
  await store.save(record);
  const app = mountPage('/device', devicePage, { db, values: { deviceAuthorizationStore: store } });
  return { app, db, record };
}

/** The hidden csrf_token of a rendered form. */
function csrfTokenOf(html: string): string {
  return /name="csrf_token" value="([^"]*)"/.exec(html)?.[1] ?? '';
}

describe('devicePage', () => {
  describe('GET /device', () => {
    // RFC 8628 §3.3.1: verification_uri_complete only pre-fills the field.
    it('should render the code entry form pre-filled with the user_code of the query', async () => {
      const { app, record } = await deviceApp();

      const response = await app.request(requestTo('/device?user_code=BCDF-GHJK'));

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      expect(await response.text()).toContain('<input type="text" id="user_code" name="user_code" value="BCDF-GHJK" required=""/>');
      expect(record.csrfToken).toBeNull();
    });
  });

  describe('POST /device', () => {
    // RFC 8628 §5.1: one reason-free message for every code that did not match.
    it('should answer an unknown code with 400 and the reason-free message', async () => {
      const { app } = await deviceApp();

      const response = await app.request(formPost('/device', { user_code: 'ZZZZ-ZZZZ' }));

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(INVALID_USER_CODE_MESSAGE);
    });

    it('should answer a matching code with the sign-in form and the binding cookie', async () => {
      const { app } = await deviceApp();

      const response = await app.request(formPost('/device', { user_code: 'BCDF-GHJK' }));

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<form method="post" action="/device/login">');
      expect(response.headers.getSetCookie()).toEqual([
        expect.stringMatching(/^oidc_device_BCDFGHJK=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/),
      ]);
    });
  });

  describe('POST /device/approve', () => {
    it('should answer 401 with the error page without an OP session', async () => {
      const { app } = await deviceApp();

      const response = await app.request(formPost('/device/approve', { user_code: 'BCDF-GHJK', decision: 'approve' }));

      expect(response.status).toBe(401);
      expect(await response.text()).toContain('<p>Sign in again to approve this device</p>');
    });

    it('should answer 403 with the error page when the OP session holds no binding cookie', async () => {
      const { app, db } = await deviceApp();
      const session = await signInBrowser(createProviderStores(db), 'alice');

      const response = await app.request(
        formPost('/device/approve', { user_code: 'BCDF-GHJK', csrf_token: 'x', decision: 'approve' }, {
          Cookie: session.cookie,
        }),
      );

      expect(response.status).toBe(403);
      expect(await response.text()).toContain('<p>Device verification binding is missing</p>');
    });
  });

  describe('POST /device/login', () => {
    // maxLoginAttempts is 5 (config.ts).
    it('should answer 429 once the last allowed attempt failed', async () => {
      const { app, record } = await deviceApp();
      const entry = await app.request(formPost('/device', { user_code: 'BCDF-GHJK' }));
      const cookie = cookieHeaderOf(entry.headers.getSetCookie());
      const csrfToken = csrfTokenOf(await entry.text());
      record.loginAttempts = 4;

      const response = await app.request(
        formPost('/device/login', { user_code: 'BCDF-GHJK', csrf_token: csrfToken, username: 'alice', password: 'x' }, {
          Cookie: cookie,
        }),
      );

      expect(response.status).toBe(429);
      expect(await response.text()).toContain('<p>Too many login attempts</p>');
      expect(record.status).toBe('denied');
    });
  });

  // RFC 8628 §3.3: code entry, sign-in and approval in one browser.
  it('should walk a browser through code entry, sign-in and approval to the completed screen', async () => {
    const { app, record } = await deviceApp();

    const entry = await app.request(formPost('/device', { user_code: 'bcdf-ghjk' }));
    const bindingCookie = cookieHeaderOf(entry.headers.getSetCookie());
    const login = await app.request(
      formPost('/device/login', {
        user_code: 'BCDF-GHJK',
        csrf_token: csrfTokenOf(await entry.text()),
        username: 'alice',
        password: 'correct-password',
      }, { Cookie: bindingCookie }),
    );
    const sessionCookie = cookieHeaderOf(login.headers.getSetCookie());
    const approval = await app.request(
      formPost('/device/approve', {
        user_code: 'BCDF-GHJK',
        csrf_token: csrfTokenOf(await login.text()),
        decision: 'approve',
      }, { Cookie: `${bindingCookie}; ${sessionCookie}` }),
    );

    expect(approval.status).toBe(200);
    expect(await approval.text()).toContain('<p>You approved <strong>device-client</strong>.</p>');
    expect(approval.headers.getSetCookie()).toEqual([
      'oidc_device_BCDFGHJK=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    ]);
    expect(record).toMatchObject({ status: 'approved', subject: 'alice' });
  });
});
