import type { AuthTransaction } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import {
  authorizationRedirectOf,
  CLIENT_ID,
  REDIRECT_URI,
  secondsAgo,
  SESSION_ID,
  signIn,
  STATE,
  storeTransaction,
  SUBJECT,
  TRANSACTION_ID,
  transactionOf,
} from '../../../../test-support/authorize.js';
import { providerContext, requestTo, TEST_ISSUER } from '../../../../test-support/context.js';
import { completePromptNoneRequest } from './authenticate-silently.js';

/** A request from the browser that holds the session cookie, with the transaction stored. */
async function silentContext(transaction: AuthTransaction = transactionOf()) {
  const context = await providerContext({
    request: requestTo('/authorize', { headers: { Cookie: 'session_id=' + SESSION_ID } }),
  });
  await storeTransaction(context.stores, transaction);
  return { ...context, transaction };
}

function inputOf(transaction: AuthTransaction, overrides: { promptValues?: string[]; verifiedHintSubject?: string } = {}) {
  return {
    promptValues: ['none'],
    transactionId: TRANSACTION_ID,
    transaction,
    verifiedHintSubject: undefined,
    issuer: TEST_ISSUER,
    responseMode: undefined,
    ...overrides,
  };
}

/** The query of the error redirect the step answers with. */
function errorRedirect(error: string, description: string) {
  return { target: REDIRECT_URI, params: { error, error_description: description, state: STATE, iss: TEST_ISSUER } };
}

describe('completePromptNoneRequest', () => {
  it('should return undefined when the request does not ask for prompt=none', async () => {
    const { c, stores, transaction } = await silentContext();
    await signIn(stores);
    await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

    expect(await completePromptNoneRequest(c, inputOf(transaction, { promptValues: ['login'] }))).toBeUndefined();
  });

  describe('Silent authentication', () => {
    // OIDC Core 1.0 §3.1.2.1: prompt=none succeeds only with an active session and prior consent.
    it('should return the active session when the End-User consented to every requested scope', async () => {
      const authTime = secondsAgo(30);
      const { c, db, stores, transaction } = await silentContext();
      await signIn(stores, { authTime });
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      expect(await completePromptNoneRequest(c, inputOf(transaction))).toEqual({
        session: { subject: SUBJECT, authTime, sessionId: SESSION_ID },
      });
      // The issue-authorization-code step consumes the transaction afterwards.
      expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(true);
    });

    // OIDC Core 1.0 §3.1.2.1: the OP MUST NOT show a login screen for prompt=none.
    it('should redirect login_required and drop the transaction when no session is active', async () => {
      const { c, db, transaction } = await silentContext();

      const outcome = await completePromptNoneRequest(c, inputOf(transaction));

      expect(authorizationRedirectOf(outcome)).toEqual(
        errorRedirect('login_required', 'No active session found. Silent authentication failed.'),
      );
      expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
    });

    // OIDC Core 1.0 §3.1.2.1: the OP MUST NOT show a consent screen for prompt=none.
    it('should redirect consent_required when the End-User has not consented to the requested scopes', async () => {
      const { c, db, stores, transaction } = await silentContext(transactionOf({ scope: 'openid profile' }));
      await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      const outcome = await completePromptNoneRequest(c, inputOf(transaction));

      expect(authorizationRedirectOf(outcome)).toEqual(
        errorRedirect('consent_required', 'Consent has not been granted. Silent authentication cannot show consent UI.'),
      );
      expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
    });

    // OIDC Core 1.0 §3.1.2.1: the hint is checked before consent, so the
    // consent of another End-User is never looked up (there is none here).
    it('should redirect login_required when id_token_hint names another End-User than the session', async () => {
      const { c, stores, transaction } = await silentContext();
      await signIn(stores);

      const outcome = await completePromptNoneRequest(c, inputOf(transaction, { verifiedHintSubject: 'bob' }));

      expect(authorizationRedirectOf(outcome)).toEqual(
        errorRedirect('login_required', 'id_token_hint subject does not match the active session.'),
      );
    });

    // OIDC Core 1.0 §3.1.2.1: max_age cannot trigger re-authentication under prompt=none.
    it('should redirect login_required when the session is older than max_age', async () => {
      const { c, stores, transaction } = await silentContext(transactionOf({ maxAge: 60 }));
      await signIn(stores, { authTime: secondsAgo(3600) });
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      const outcome = await completePromptNoneRequest(c, inputOf(transaction));

      expect(authorizationRedirectOf(outcome)).toEqual(
        errorRedirect('login_required', 'Session exceeds the requested max_age; re-authentication required'),
      );
    });

    it('should redirect server_error with the failure message when the session lookup fails', async () => {
      const { c, transaction } = await silentContext();
      c.set('sessionResolver', {
        async resolve() {
          throw new Error('session store is unavailable');
        },
      });

      const outcome = await completePromptNoneRequest(c, inputOf(transaction));

      expect(authorizationRedirectOf(outcome)).toEqual(errorRedirect('server_error', 'session store is unavailable'));
    });
  });

  describe('Missing resolvers', () => {
    it('should redirect login_required when no session resolver is configured', async () => {
      const { c, transaction } = await silentContext();
      c.set('sessionResolver', undefined);

      const outcome = await completePromptNoneRequest(c, inputOf(transaction));

      expect(authorizationRedirectOf(outcome)).toEqual(
        errorRedirect('login_required', 'sessionResolver is not configured; cannot satisfy prompt=none'),
      );
    });

    it('should redirect consent_required when no consent resolver is configured', async () => {
      const { c, stores, transaction } = await silentContext();
      await signIn(stores);
      c.set('consentResolver', undefined);

      const outcome = await completePromptNoneRequest(c, inputOf(transaction));

      expect(authorizationRedirectOf(outcome)).toEqual(
        errorRedirect('consent_required', 'consentResolver is not configured; cannot satisfy prompt=none'),
      );
    });
  });
});
