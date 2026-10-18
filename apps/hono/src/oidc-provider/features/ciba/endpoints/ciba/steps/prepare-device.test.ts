import {
  createInMemoryCibaAuthenticationRequestStore,
  createInMemoryCibaLoginTransactionStore,
  validateCibaLoginSubmission,
} from '@maronn-openid-connect/experimental/ciba';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cookieValueOf, pendingCibaRecord, signInBrowser } from '../../../../../../test-support/browser-flows.js';
import { providerContext, requestTo } from '../../../../../../test-support/context.js';
import { createEmptyDatabase } from '../../../../../db/memory/database.js';
import { createProviderStores } from '../../../../../db/memory/stores.js';
import { buildCibaLoginBindingCookie } from '../../../cookies.js';
import type { CibaOutcome } from '../outcome.js';
import { prepareCibaDevice } from './prepare-device.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

/** A context for GET /ciba with fresh CIBA stores, from a browser sending cookie. */
async function cibaContext(cookieOf: (sessionCookie: string) => string) {
  const db = createEmptyDatabase();
  const session = await signInBrowser(createProviderStores(db), 'alice');
  const headers = { Cookie: cookieOf(session.cookie) };
  const { c } = await providerContext({ db, request: requestTo('/ciba', { headers }) });
  const requestStore = createInMemoryCibaAuthenticationRequestStore();
  const transactionStore = createInMemoryCibaLoginTransactionStore();
  c.set('cibaAuthenticationRequestStore', requestStore);
  c.set('cibaLoginTransactionStore', transactionStore);
  return { c, requestStore, transactionStore };
}

describe('prepareCibaDevice', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should list the signed-in user's pending requests without setting a cookie", async () => {
    const { c, requestStore } = await cibaContext((sessionCookie) => sessionCookie);
    const record = pendingCibaRecord();
    await requestStore.save(record);

    expect(await prepareCibaDevice(c)).toEqual({
      kind: 'pending_requests',
      requests: [
        {
          authReqId: record.authReqId,
          clientId: 'ciba-client',
          scopes: ['openid', 'profile'],
          bindingMessage: undefined,
          expiresInSeconds: 120,
          csrfToken: record.csrfToken,
        },
      ],
      cookies: [],
    });
  });

  // The binding cookie is what stops a forged sign-in (login CSRF).
  it('should start a login transaction bound to this browser when there is no OP session', async () => {
    const { c, transactionStore } = await cibaContext(() => '');

    const outcome = await prepareCibaDevice(c);
    const login = outcome as Extract<CibaOutcome, { kind: 'login' }>;
    const bindingSecret = cookieValueOf(login.cookies[0] ?? '', 'oidc_ciba_login_' + login.loginTransactionId) ?? '';

    expect(outcome).toEqual({
      kind: 'login',
      loginTransactionId: login.loginTransactionId,
      csrfToken: login.csrfToken,
      cookies: [buildCibaLoginBindingCookie(login.loginTransactionId, bindingSecret, 600)],
    });
    await expect(
      validateCibaLoginSubmission({
        transactionId: login.loginTransactionId,
        csrfToken: login.csrfToken,
        bindingSecret,
        store: transactionStore,
      }),
    ).resolves.toMatchObject({ id: login.loginTransactionId, loginAttempts: 0 });
  });

  it('should treat a session cookie whose session is gone as no OP session', async () => {
    const { c } = await cibaContext(() => 'session_id=ended-session');

    expect(await prepareCibaDevice(c)).toMatchObject({ kind: 'login' });
  });
});
