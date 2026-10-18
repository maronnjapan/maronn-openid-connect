import { validateVerificationBinding } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cookieValueOf,
  pendingDeviceRecord,
  signInBrowser,
} from '../../../../../../test-support/browser-flows.js';
import { providerContext, requestTo } from '../../../../../../test-support/context.js';
import { createEmptyDatabase } from '../../../../../db/memory/database.js';
import { createProviderStores } from '../../../../../db/memory/stores.js';
import { buildDeviceBindingCookie } from '../../../cookies.js';
import { InMemoryDeviceAuthorizationStore } from '../../../store.js';
import type { DeviceOutcome } from '../outcome.js';
import { submitDeviceUserCode } from './submit-user-code.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

/** A context for POST /device on a fresh device store, from a browser signed in as alice or not. */
async function deviceContext(input: { signedIn: boolean }) {
  const db = createEmptyDatabase();
  const session = await signInBrowser(createProviderStores(db), 'alice');
  const headers: Record<string, string> = input.signedIn ? { Cookie: session.cookie } : {};
  const { c } = await providerContext({ db, request: requestTo('/device', { method: 'POST', headers }) });
  const store = new InMemoryDeviceAuthorizationStore();
  c.set('deviceAuthorizationStore', store);
  return { c, store };
}

describe('submitDeviceUserCode', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // RFC 8628 §5.1: unknown, used and expired codes share one reason-free answer.
  describe('No match', () => {
    it('should answer invalid_user_code with the submitted code when no record matches', async () => {
      const { c } = await deviceContext({ signedIn: false });

      expect(await submitDeviceUserCode(c, 'ZZZZ-ZZZZ')).toEqual({ kind: 'invalid_user_code', userCode: 'ZZZZ-ZZZZ' });
    });

    it('should answer invalid_user_code for a record that is no longer pending', async () => {
      const { c, store } = await deviceContext({ signedIn: false });
      await store.save(pendingDeviceRecord({ status: 'approved' }));

      expect(await submitDeviceUserCode(c, 'BCDF-GHJK')).toEqual({ kind: 'invalid_user_code', userCode: 'BCDF-GHJK' });
    });

    it('should answer invalid_user_code for an expired record', async () => {
      const { c, store } = await deviceContext({ signedIn: false });
      await store.save(pendingDeviceRecord({ expiresAt: new Date(NOW.getTime() - 1) }));

      expect(await submitDeviceUserCode(c, 'BCDF-GHJK')).toEqual({ kind: 'invalid_user_code', userCode: 'BCDF-GHJK' });
    });
  });

  describe('Match', () => {
    // RFC 8628 §3.3: without an OP session the End-User signs in next.
    it('should answer login with the csrf_token and a binding cookie that validates against the record', async () => {
      const { c, store } = await deviceContext({ signedIn: false });
      const record = pendingDeviceRecord();
      await store.save(record);

      const outcome = await submitDeviceUserCode(c, 'BCDF-GHJK');
      const [cookie = ''] = (outcome as Extract<DeviceOutcome, { kind: 'login' }>).cookies;
      const bindingSecret = cookieValueOf(cookie, 'oidc_device_BCDFGHJK') ?? '';

      expect(outcome).toEqual({
        kind: 'login',
        userCode: 'BCDF-GHJK',
        csrfToken: record.csrfToken,
        cookies: [buildDeviceBindingCookie('BCDFGHJK', bindingSecret, 600)],
      });
      expect(record.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(validateVerificationBinding(record, bindingSecret)).resolves.toBeUndefined();
    });

    // RFC 8628 §6.1: case and separators are not forced on the End-User.
    it('should match a code typed in lower case with a space instead of the hyphen', async () => {
      const { c, store } = await deviceContext({ signedIn: false });
      await store.save(pendingDeviceRecord());

      expect(await submitDeviceUserCode(c, 'bcdf ghjk')).toMatchObject({ kind: 'login', userCode: 'BCDF-GHJK' });
    });

    it('should answer approval with the client and scopes when the browser has an OP session', async () => {
      const { c, store } = await deviceContext({ signedIn: true });
      const record = pendingDeviceRecord({ scope: ['openid', 'email'] });
      await store.save(record);

      const outcome = await submitDeviceUserCode(c, 'BCDF-GHJK');

      expect(outcome).toMatchObject({
        kind: 'approval',
        userCode: 'BCDF-GHJK',
        csrfToken: record.csrfToken,
        clientId: 'device-client',
        scopes: ['openid', 'email'],
      });
      expect((outcome as Extract<DeviceOutcome, { kind: 'approval' }>).cookies).toHaveLength(1);
    });
  });
});
