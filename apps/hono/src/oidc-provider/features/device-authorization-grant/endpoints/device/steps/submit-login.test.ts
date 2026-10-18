import { issueVerificationBinding } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { describe, expect, it } from 'vitest';
import { cookieHeaderOf, cookieValueOf, pendingDeviceRecord } from '../../../../../../test-support/browser-flows.js';
import { providerContext, requestTo } from '../../../../../../test-support/context.js';
import { buildSessionCookie, SESSION_COOKIE_NAME } from '../../../../../cookies.js';
import { createEmptyDatabase } from '../../../../../db/memory/database.js';
import { registerUser } from '../../../../../db/memory/users.js';
import { buildDeviceBindingCookie } from '../../../cookies.js';
import { InMemoryDeviceAuthorizationStore } from '../../../store.js';
import type { DeviceOutcome } from '../outcome.js';
import { submitDeviceLogin } from './submit-login.js';

/**
 * A pending record whose binding was issued (POST /device), and a context for
 * POST /device/login from a browser holding cookie (the binding cookie by
 * default).
 */
async function loginContext(input: { cookie?: (bindingSecret: string) => string; loginAttempts?: number } = {}) {
  const db = createEmptyDatabase();
  await registerUser(db, { sub: 'alice', password: 'correct-password' });
  const store = new InMemoryDeviceAuthorizationStore();
  const record = pendingDeviceRecord({ loginAttempts: input.loginAttempts ?? 0 });
  await store.save(record);
  const { bindingSecret, csrfToken } = await issueVerificationBinding(record, store);
  const cookie = (input.cookie ?? ((secret) => cookieHeaderOf([buildDeviceBindingCookie('BCDFGHJK', secret, 600)])))(
    bindingSecret,
  );
  const { c, stores } = await providerContext({
    db,
    request: requestTo('/device/login', { method: 'POST', headers: { Cookie: cookie } }),
  });
  c.set('deviceAuthorizationStore', store);
  return { c, stores, record, csrfToken };
}

describe('submitDeviceLogin', () => {
  it('should answer invalid_user_code when the code matches no pending record', async () => {
    const { c, csrfToken } = await loginContext();

    expect(
      await submitDeviceLogin(c, { userCode: 'ZZZZ-ZZZZ', csrfToken, username: 'alice', password: 'correct-password' }),
    ).toEqual({ kind: 'invalid_user_code', userCode: 'ZZZZ-ZZZZ' });
  });

  // RFC 8628 §5.4: the binding cookie is what stops a forged sign-in (login CSRF).
  describe('Binding and CSRF', () => {
    it('should answer a 403 error when the binding cookie is missing', async () => {
      const { c, csrfToken } = await loginContext({ cookie: () => 'unrelated=1' });

      expect(
        await submitDeviceLogin(c, { userCode: 'BCDF-GHJK', csrfToken, username: 'alice', password: 'correct-password' }),
      ).toEqual({ kind: 'error', error: 'Device verification binding is missing', statusCode: 403 });
    });

    it('should answer a 403 error when the binding cookie holds another secret', async () => {
      const { c, csrfToken } = await loginContext({ cookie: () => 'oidc_device_BCDFGHJK=forged-secret' });

      expect(
        await submitDeviceLogin(c, { userCode: 'BCDF-GHJK', csrfToken, username: 'alice', password: 'correct-password' }),
      ).toEqual({ kind: 'error', error: 'Device verification binding is invalid', statusCode: 403 });
    });

    it('should answer a 403 error when the csrf_token does not match the record', async () => {
      const { c } = await loginContext();

      expect(
        await submitDeviceLogin(c, {
          userCode: 'BCDF-GHJK',
          csrfToken: 'forged-token',
          username: 'alice',
          password: 'correct-password',
        }),
      ).toEqual({ kind: 'error', error: 'CSRF token mismatch', statusCode: 403 });
    });
  });

  describe('Credentials', () => {
    it('should answer invalid_credentials with 4 attempts left after the first wrong password', async () => {
      const { c, record, csrfToken } = await loginContext();

      expect(
        await submitDeviceLogin(c, { userCode: 'BCDF-GHJK', csrfToken, username: 'alice', password: 'wrong' }),
      ).toEqual({ kind: 'invalid_credentials', userCode: 'BCDF-GHJK', csrfToken, remainingAttempts: 4 });
      expect(record).toMatchObject({ loginAttempts: 1, status: 'pending' });
    });

    // maxLoginAttempts is 5 (config.ts): the fifth failure denies the record.
    it('should deny the record and answer locked_out when the last allowed attempt fails', async () => {
      const { c, record, csrfToken } = await loginContext({ loginAttempts: 4 });

      expect(
        await submitDeviceLogin(c, { userCode: 'BCDF-GHJK', csrfToken, username: 'alice', password: 'wrong' }),
      ).toEqual({ kind: 'locked_out' });
      expect(record).toMatchObject({ loginAttempts: 5, status: 'denied' });
    });

    it('should open an OP session for the user and answer approval with its cookie', async () => {
      const { c, stores, csrfToken } = await loginContext();

      const outcome = await submitDeviceLogin(c, {
        userCode: 'BCDF-GHJK',
        csrfToken,
        username: 'alice',
        password: 'correct-password',
      });
      const [cookie = ''] = (outcome as Extract<DeviceOutcome, { kind: 'approval' }>).cookies;
      const sessionId = cookieValueOf(cookie, SESSION_COOKIE_NAME) ?? '';

      expect(outcome).toEqual({
        kind: 'approval',
        userCode: 'BCDF-GHJK',
        csrfToken,
        clientId: 'device-client',
        scopes: ['openid', 'profile'],
        cookies: [buildSessionCookie(sessionId)],
      });
      expect(await stores.browserSessionStore.get(sessionId)).toMatchObject({ subject: 'alice' });
    });
  });
});
