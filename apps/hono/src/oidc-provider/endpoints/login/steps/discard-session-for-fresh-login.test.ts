import { describe, expect, it } from 'vitest';
import { providerContext, requestTo } from '../../../../test-support/context.js';
import { TRANSACTION_ID, sampleTransaction } from '../../../../test-support/screens.js';
import { discardSessionForFreshLogin } from './discard-session-for-fresh-login.js';

/** A context whose browser holds session sid-1, with a login hand-off for the transaction. */
async function setUp(cookie = 'session_id=sid-1') {
  const { c, db, stores } = await providerContext({
    request: requestTo('/login', { method: 'POST', headers: { Cookie: cookie } }),
  });
  await stores.browserSessionStore.set('sid-1', { subject: 'alice', authTime: 1700000000 });
  await stores.browserSessionStore.set('sid-other', { subject: 'bob', authTime: 1700000000 });
  await stores.authSessionStore.set(TRANSACTION_ID, { subject: 'alice', authTime: 1700000000, sessionId: 'sid-1' });
  return { c, db };
}

describe('discardSessionForFreshLogin', () => {
  // OIDC Core 1.0 §3.1.2.1: prompt=login requires the End-User to authenticate again.
  it('should discard the hand-off and the browser session for prompt=login', async () => {
    const { c, db } = await setUp();

    await discardSessionForFreshLogin(c, TRANSACTION_ID, sampleTransaction({ prompt: 'login' }));

    expect(db.authSessions.has(TRANSACTION_ID)).toBe(false);
    expect([...db.browserSessions.keys()]).toEqual(['sid-other']);
  });

  // OIDC Core 1.0 §3.1.2.1: prompt is a space-delimited list.
  it('should discard them when login is one value of a space-delimited prompt', async () => {
    const { c, db } = await setUp();

    await discardSessionForFreshLogin(c, TRANSACTION_ID, sampleTransaction({ prompt: ' consent  login ' }));

    expect(db.authSessions.has(TRANSACTION_ID)).toBe(false);
    expect(db.browserSessions.has('sid-1')).toBe(false);
  });

  it('should discard them for prompt=select_account', async () => {
    const { c, db } = await setUp();

    await discardSessionForFreshLogin(c, TRANSACTION_ID, sampleTransaction({ prompt: 'select_account' }));

    expect(db.authSessions.has(TRANSACTION_ID)).toBe(false);
    expect(db.browserSessions.has('sid-1')).toBe(false);
  });

  it('should keep both for a transaction without prompt', async () => {
    const { c, db } = await setUp();

    await discardSessionForFreshLogin(c, TRANSACTION_ID, sampleTransaction());

    expect(db.authSessions.has(TRANSACTION_ID)).toBe(true);
    expect([...db.browserSessions.keys()]).toEqual(['sid-1', 'sid-other']);
  });

  it('should keep both for prompt=consent', async () => {
    const { c, db } = await setUp();

    await discardSessionForFreshLogin(c, TRANSACTION_ID, sampleTransaction({ prompt: 'consent' }));

    expect(db.authSessions.has(TRANSACTION_ID)).toBe(true);
    expect(db.browserSessions.has('sid-1')).toBe(true);
  });

  it('should discard only the hand-off when the browser has no session cookie', async () => {
    const { c, db } = await setUp('theme=dark');

    await discardSessionForFreshLogin(c, TRANSACTION_ID, sampleTransaction({ prompt: 'login' }));

    expect(db.authSessions.has(TRANSACTION_ID)).toBe(false);
    expect([...db.browserSessions.keys()]).toEqual(['sid-1', 'sid-other']);
  });
});
