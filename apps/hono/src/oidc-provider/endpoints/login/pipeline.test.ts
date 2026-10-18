import type { AuthTransaction } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { formPost, providerContext, requestTo } from '../../../test-support/context.js';
import {
  CSRF_TOKEN,
  TRANSACTION_ID,
  sampleTransaction,
  storeTransaction,
  transactionCookie,
} from '../../../test-support/screens.js';
import { createEmptyDatabase } from '../../db/memory/database.js';
import { registerUser } from '../../db/memory/users.js';
import { prepareLogin, submitLogin } from './pipeline.js';

/** A provider context for a login POST of the browser that is in the transaction. */
async function postContext(
  input: { transaction?: AuthTransaction; cookie?: string; headers?: Record<string, string> } = {},
) {
  const db = createEmptyDatabase();
  await registerUser(db, { sub: 'alice', password: 'correct-password' });
  await storeTransaction(db, input.transaction ?? sampleTransaction());
  const { c } = await providerContext({
    db,
    request: formPost('/login', {}, { Cookie: input.cookie ?? transactionCookie(), ...input.headers }),
  });
  return { c, db };
}

function submission(password = 'correct-password', csrfToken = CSRF_TOKEN) {
  return { csrfToken, username: 'alice', password };
}

describe('prepareLogin', () => {
  // OIDC Core 1.0 §3.1.2.1 / §3.1.2.3
  it('should describe the form for the transaction of the cookie', async () => {
    const db = createEmptyDatabase();
    await storeTransaction(db, sampleTransaction({ loginHint: 'alice' }));
    const { c } = await providerContext({ db, request: requestTo('/login', { headers: { Cookie: transactionCookie() } }) });

    expect(await prepareLogin(c)).toEqual({ kind: 'screen', csrfToken: CSRF_TOKEN, loginHint: 'alice', loginMethods: [] });
  });

  it('should answer the error page when the browser is in no transaction', async () => {
    const { c } = await providerContext({ request: requestTo('/login') });

    expect(await prepareLogin(c)).toMatchObject({ kind: 'error', statusCode: 400 });
  });
});

describe('submitLogin', () => {
  describe('Refusals', () => {
    it('should refuse a cross-site form POST before reading the transaction', async () => {
      const { c } = await postContext({ cookie: 'theme=dark', headers: { 'Sec-Fetch-Site': 'cross-site' } });

      expect(await submitLogin(c, submission())).toEqual({
        kind: 'error',
        error: 'This form can only be submitted from the authorization server itself.',
        statusCode: 403,
      });
    });

    it('should answer the error page when the browser is in no transaction', async () => {
      const { c } = await postContext({ cookie: 'theme=dark' });

      expect(await submitLogin(c, submission())).toMatchObject({ kind: 'error', statusCode: 400 });
    });

    it('should refuse a csrf_token of another transaction with 403', async () => {
      const { c } = await postContext();

      expect(await submitLogin(c, submission('correct-password', 'csrf-of-another-transaction'))).toEqual({
        kind: 'error',
        error: 'Invalid CSRF token.',
        statusCode: 403,
      });
    });
  });

  describe('Wrong credentials', () => {
    it('should show the form again with the attempts left', async () => {
      const { c } = await postContext();

      expect(await submitLogin(c, submission('wrong-password'))).toEqual({
        kind: 'invalid_credentials',
        screen: { kind: 'screen', csrfToken: CSRF_TOKEN, loginHint: undefined, loginMethods: [] },
        remainingAttempts: 4,
      });
    });

    it('should lock the transaction out at the fifth failure', async () => {
      const { c, db } = await postContext({ transaction: sampleTransaction({ failedAttempts: 4 }) });

      expect(await submitLogin(c, submission('wrong-password'))).toEqual({ kind: 'locked_out' });
      expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
    });
  });

  describe('Authenticated', () => {
    // OIDC Core 1.0 §3.1.2.3: the OP session is established and handed to the consent step.
    it('should establish the OP session and hand the subject to the consent step', async () => {
      const { c, db } = await postContext();

      const outcome = await submitLogin(c, submission());
      const [sessionId = ''] = [...db.browserSessions.keys()];

      expect(outcome).toEqual({
        kind: 'authenticated',
        cookies: [`session_id=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/`],
      });
      expect(db.browserSessions.get(sessionId)).toMatchObject({ subject: 'alice' });
      expect(db.authSessions.get(TRANSACTION_ID)).toMatchObject({ subject: 'alice', sessionId });
    });

    // OIDC Core 1.0 §3.1.2.1: prompt=login replaces the existing session.
    it('should discard the existing browser session for prompt=login', async () => {
      const { c, db } = await postContext({
        transaction: sampleTransaction({ prompt: 'login' }),
        cookie: `session_id=old-session; ${transactionCookie()}`,
      });
      db.browserSessions.set('old-session', { subject: 'bob', authTime: 1700000000 });

      await submitLogin(c, submission());

      expect(db.browserSessions.has('old-session')).toBe(false);
      expect([...db.browserSessions.values()]).toMatchObject([{ subject: 'alice' }]);
    });
  });
});
