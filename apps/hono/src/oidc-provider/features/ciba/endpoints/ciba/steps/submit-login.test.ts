import {
  createCibaLoginTransaction,
  createInMemoryCibaAuthenticationRequestStore,
  createInMemoryCibaLoginTransactionStore,
} from '@maronn-openid-connect/experimental/ciba';
import { describe, expect, it } from 'vitest';
import { cookieHeaderOf, cookieValueOf, pendingCibaRecord } from '../../../../../../test-support/browser-flows.js';
import { providerContext, requestTo } from '../../../../../../test-support/context.js';
import { buildSessionCookie, SESSION_COOKIE_NAME } from '../../../../../cookies.js';
import { createEmptyDatabase } from '../../../../../db/memory/database.js';
import { registerUser } from '../../../../../db/memory/users.js';
import { buildCibaLoginBindingCookie, buildClearedCibaLoginBindingCookie } from '../../../cookies.js';
import type { CibaOutcome } from '../outcome.js';
import { submitCibaLogin } from './submit-login.js';

/**
 * A login transaction (GET /ciba) and a context for POST /ciba/login from a
 * browser sending cookie (the binding cookie by default).
 */
async function loginContext(input: { cookie?: (bindingCookie: string) => string; loginAttempts?: number } = {}) {
  const db = createEmptyDatabase();
  await registerUser(db, { sub: 'alice', password: 'correct-password' });
  const transactionStore = createInMemoryCibaLoginTransactionStore();
  const requestStore = createInMemoryCibaAuthenticationRequestStore();
  const { record: transaction, bindingSecret } = await createCibaLoginTransaction(transactionStore);
  transaction.loginAttempts = input.loginAttempts ?? 0;
  const bindingCookie = cookieHeaderOf([buildCibaLoginBindingCookie(transaction.id, bindingSecret, 600)]);
  const { c, stores } = await providerContext({
    db,
    request: requestTo('/ciba/login', {
      method: 'POST',
      headers: { Cookie: (input.cookie ?? ((cookie) => cookie))(bindingCookie) },
    }),
  });
  c.set('cibaLoginTransactionStore', transactionStore);
  c.set('cibaAuthenticationRequestStore', requestStore);
  return { c, stores, transaction, transactionStore, requestStore };
}

describe('submitCibaLogin', () => {
  // A forged sign-in cannot carry the binding cookie (login CSRF).
  describe('Binding and CSRF', () => {
    it('should answer a 403 error when the binding cookie is missing', async () => {
      const { c, transaction } = await loginContext({ cookie: () => 'unrelated=1' });

      expect(
        await submitCibaLogin(c, {
          loginTransactionId: transaction.id,
          csrfToken: transaction.csrfToken,
          username: 'alice',
          password: 'correct-password',
        }),
      ).toEqual({ kind: 'error', error: 'The sign-in request could not be verified', statusCode: 403 });
    });

    it('should answer a 403 error when the csrf_token does not match the transaction', async () => {
      const { c, transaction } = await loginContext();

      expect(
        await submitCibaLogin(c, {
          loginTransactionId: transaction.id,
          csrfToken: 'forged-token',
          username: 'alice',
          password: 'correct-password',
        }),
      ).toEqual({ kind: 'error', error: 'The sign-in request could not be verified', statusCode: 403 });
    });
  });

  describe('Credentials', () => {
    it('should answer invalid_credentials with 4 attempts left after the first wrong password', async () => {
      const { c, transaction } = await loginContext();

      expect(
        await submitCibaLogin(c, {
          loginTransactionId: transaction.id,
          csrfToken: transaction.csrfToken,
          username: 'alice',
          password: 'wrong',
        }),
      ).toEqual({
        kind: 'invalid_credentials',
        loginTransactionId: transaction.id,
        csrfToken: transaction.csrfToken,
        remainingAttempts: 4,
      });
    });

    // maxLoginAttempts is 5 (config.ts): the fifth failure discards the transaction.
    it('should discard the transaction and answer locked_out when the last allowed attempt fails', async () => {
      const { c, transaction, transactionStore } = await loginContext({ loginAttempts: 4 });

      expect(
        await submitCibaLogin(c, {
          loginTransactionId: transaction.id,
          csrfToken: transaction.csrfToken,
          username: 'alice',
          password: 'wrong',
        }),
      ).toEqual({ kind: 'locked_out' });
      expect(await transactionStore.findById(transaction.id)).toBeNull();
    });

    it("should open an OP session under a new id, consume the transaction and list the user's requests", async () => {
      const { c, stores, transaction, transactionStore, requestStore } = await loginContext();
      const record = pendingCibaRecord();
      await requestStore.save(record);

      const outcome = await submitCibaLogin(c, {
        loginTransactionId: transaction.id,
        csrfToken: transaction.csrfToken,
        username: 'alice',
        password: 'correct-password',
      });
      const [sessionCookie = ''] = (outcome as Extract<CibaOutcome, { kind: 'pending_requests' }>).cookies;
      const sessionId = cookieValueOf(sessionCookie, SESSION_COOKIE_NAME) ?? '';

      expect(outcome).toMatchObject({
        kind: 'pending_requests',
        requests: [{ authReqId: record.authReqId, clientId: 'ciba-client', csrfToken: record.csrfToken }],
        cookies: [buildSessionCookie(sessionId), buildClearedCibaLoginBindingCookie(transaction.id)],
      });
      expect(await stores.browserSessionStore.get(sessionId)).toMatchObject({ subject: 'alice' });
      expect(await transactionStore.findById(transaction.id)).toBeNull();
    });
  });
});
