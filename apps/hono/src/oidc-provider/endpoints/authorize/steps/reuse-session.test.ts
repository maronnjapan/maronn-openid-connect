import type { AuthTransaction } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_ID,
  secondsAgo,
  SESSION_ID,
  signIn,
  SUBJECT,
  TRANSACTION_ID,
  transactionOf,
} from '../../../../test-support/authorize.js';
import { providerContext, requestTo } from '../../../../test-support/context.js';
import { reuseExistingSession } from './reuse-session.js';

const TRANSACTION_COOKIE = '__Host-oidc_txn=txn-1; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600';

/** A request from the browser that holds the session cookie. */
function ssoContext() {
  return providerContext({ request: requestTo('/authorize', { headers: { Cookie: 'session_id=' + SESSION_ID } }) });
}

function inputOf(
  overrides: { promptValues?: string[]; transaction?: AuthTransaction; verifiedHintSubject?: string } = {},
) {
  return {
    promptValues: [],
    transactionId: TRANSACTION_ID,
    transaction: transactionOf(),
    transactionTtlSeconds: 600,
    verifiedHintSubject: undefined,
    ...overrides,
  };
}

describe('reuseExistingSession', () => {
  describe('Session reused', () => {
    // OIDC Core 1.0 §3.1.2.3: an active session with prior consent needs no interaction.
    it('should return the session when the End-User already consented to the requested scopes', async () => {
      const authTime = secondsAgo(30);
      const { c, stores } = await ssoContext();
      await signIn(stores, { authTime });
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      expect(await reuseExistingSession(c, inputOf())).toEqual({
        session: { subject: SUBJECT, authTime, sessionId: SESSION_ID },
      });
    });

    it('should continue on the consent screen and hand the login over to it when consent is missing', async () => {
      const authTime = secondsAgo(30);
      const { c, db, stores } = await ssoContext();
      await signIn(stores, { authTime });

      expect(await reuseExistingSession(c, inputOf())).toEqual({ kind: 'consent', cookies: [TRANSACTION_COOKIE] });
      expect(db.authSessions.get(TRANSACTION_ID)).toEqual({ subject: SUBJECT, authTime, sessionId: SESSION_ID });
    });

    // OIDC Core 1.0 §3.1.2.1: prompt=consent MUST prompt for consent again.
    it('should continue on the consent screen for prompt=consent even with prior consent', async () => {
      const { c, stores } = await ssoContext();
      await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      expect(await reuseExistingSession(c, inputOf({ promptValues: ['consent'] }))).toEqual({
        kind: 'consent',
        cookies: [TRANSACTION_COOKIE],
      });
    });
  });

  // undefined: the pipeline continues on the login screen.
  describe('Session not reused', () => {
    // OIDC Core 1.0 §3.1.2.1: login and select_account force the End-User to interact.
    it.each(['login', 'select_account'])('should return undefined for prompt=%s despite an active session', async (prompt) => {
      const { c, stores } = await ssoContext();
      await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      expect(await reuseExistingSession(c, inputOf({ promptValues: [prompt] }))).toBeUndefined();
    });

    it('should return undefined when no session is active', async () => {
      const { c } = await ssoContext();

      expect(await reuseExistingSession(c, inputOf())).toBeUndefined();
    });

    // OIDC Core 1.0 §3.1.2.1: max_age bounds how old the authentication may be.
    it('should return undefined when the session is older than max_age', async () => {
      const { c, stores } = await ssoContext();
      await signIn(stores, { authTime: secondsAgo(3600) });
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      expect(await reuseExistingSession(c, inputOf({ transaction: transactionOf({ maxAge: 60 }) }))).toBeUndefined();
    });

    // OIDC Core 1.0 §3.1.2.1: a code is never issued for another End-User than the hint names.
    it('should return undefined when id_token_hint names another End-User than the session', async () => {
      const { c, db, stores } = await ssoContext();
      await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      expect(await reuseExistingSession(c, inputOf({ verifiedHintSubject: 'bob' }))).toBeUndefined();
      expect(db.authSessions.size).toBe(0);
    });

    it('should return undefined when no session resolver is configured', async () => {
      const { c } = await ssoContext();
      c.set('sessionResolver', undefined);

      expect(await reuseExistingSession(c, inputOf())).toBeUndefined();
    });
  });
});
