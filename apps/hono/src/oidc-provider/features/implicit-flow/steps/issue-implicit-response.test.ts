import type { AuthTransaction } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTestClient } from '../../../../test-support/authorize.js';
import { providerContext, TEST_ISSUER } from '../../../../test-support/context.js';
import {
  REDIRECT_URI,
  TRANSACTION_ID,
  sampleTransaction,
  storeTransaction,
} from '../../../../test-support/screens.js';
import { decodeJwt } from '../../../../test-support/token.js';
import type { ClientRegistration } from '../../../config.js';
import { buildClearedTransactionCookie } from '../../../cookies.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { RESTRICTED_SCOPE_SUBJECTS } from '../../../scopes.js';
import { issueImplicitConsentResponse } from './issue-implicit-response.js';

const NOW_SECONDS = 1767225600; // 2026-01-01T00:00:00Z
const session = { subject: 'alice', authTime: NOW_SECONDS - 30, sessionId: 'sid-1' };

/** A transaction of the Implicit Flow as /authorize stores it, answered in the fragment. */
function implicitTransaction(overrides: Partial<AuthTransaction> & { responseMode?: string } = {}): AuthTransaction {
  return sampleTransaction({ responseType: 'id_token token', nonce: 'nonce-1', responseMode: 'fragment', ...overrides } as Partial<AuthTransaction>);
}

/** Store the transaction, sign alice in for it and approve it. */
async function approve(transaction: AuthTransaction, client: Partial<ClientRegistration> = {}) {
  const db = createEmptyDatabase();
  await storeTransaction(db, transaction);
  const context = await providerContext({ db });
  await registerTestClient(db, client);
  await context.stores.authSessionStore.set(TRANSACTION_ID, session);
  const outcome = await issueImplicitConsentResponse(context.c, {
    transactionId: TRANSACTION_ID,
    transaction,
    session,
    issuer: TEST_ISSUER,
  });
  return { ...context, outcome };
}

/** The parameters in the fragment of the redirect the outcome answers with. */
function fragmentOf(outcome: unknown): { target: string; params: Record<string, string> } {
  expect(outcome).toMatchObject({ kind: 'authorization_response', response: { method: 'redirect', location: expect.any(String) } });
  const url = new URL((outcome as { response: { location: string } }).response.location);
  return { target: url.origin + url.pathname + url.search, params: Object.fromEntries(new URLSearchParams(url.hash.slice(1))) };
}

describe('issueImplicitConsentResponse', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_SECONDS * 1000));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Authorization Code Flow', () => {
    // The steps after this one issue the code.
    it('should return undefined and keep the transaction of response_type=code', async () => {
      const { db, outcome } = await approve(sampleTransaction());

      expect(outcome).toBeUndefined();
      expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(true);
    });
  });

  describe('Authorization response', () => {
    // OIDC Core 1.0 §3.2.2.5 / RFC 9207 §2: the tokens, the state and iss in
    // the fragment; the transaction cookie is cleared.
    it('should redirect with the tokens, the state and iss in the fragment and clear the transaction cookie', async () => {
      const { outcome } = await approve(implicitTransaction());

      const { target, params } = fragmentOf(outcome);
      expect(target).toBe(REDIRECT_URI);
      expect(params).toEqual({
        access_token: expect.any(String),
        token_type: 'Bearer',
        expires_in: '3600',
        scope: 'openid profile',
        id_token: expect.any(String),
        state: 'state-1',
        iss: TEST_ISSUER,
      });
      expect(outcome).toMatchObject({ cookies: [buildClearedTransactionCookie()] });
    });

    // OIDC Core 1.0 §3.2.2.10: the ID Token carries the nonce of the request.
    it('should issue an ID Token for alice with the nonce of the request', async () => {
      const { outcome } = await approve(implicitTransaction({ responseType: 'id_token' }));

      const { params } = fragmentOf(outcome);
      expect(Object.keys(params)).toEqual(['id_token', 'state', 'iss']);
      expect(decodeJwt(params['id_token'] ?? '').payload).toMatchObject({ sub: 'alice', aud: 'client-1', nonce: 'nonce-1' });
    });

    // OAuth 2.0 Form Post Response Mode §2: the response mode the request asked for.
    it('should post the tokens when the request asked for response_mode=form_post', async () => {
      const { outcome } = await approve(implicitTransaction({ responseType: 'id_token', responseMode: 'form_post' }));

      expect(outcome).toEqual({
        kind: 'authorization_response',
        response: {
          method: 'form_post',
          action: REDIRECT_URI,
          fields: { id_token: expect.any(String), state: 'state-1', iss: TEST_ISSUER },
        },
        cookies: [buildClearedTransactionCookie()],
      });
    });

    // OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5: never the
    // query, even for a transaction that stores no response mode.
    it('should answer in the fragment when the transaction stores no response mode', async () => {
      const { outcome } = await approve(implicitTransaction({ responseType: 'id_token', responseMode: undefined }));

      expect(Object.keys(fragmentOf(outcome).params)).toEqual(['id_token', 'state', 'iss']);
    });
  });

  describe('Grant', () => {
    // One-time use: the transaction cannot be approved twice.
    it('should finish the transaction and discard the login hand-off', async () => {
      const { db } = await approve(implicitTransaction());

      expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
      expect(db.authSessions.has(TRANSACTION_ID)).toBe(false);
    });

    // OIDC Core 1.0 §3.1.2.1: a later prompt=none finds the consent, and
    // withdrawing it revokes the access token of the grant.
    it('should record the consent and the grant of the access token', async () => {
      const { db, stores } = await approve(implicitTransaction());

      const [record] = [...db.accessTokens.values()];
      expect(await stores.consentStore.hasConsent('alice', 'client-1', ['openid', 'profile'])).toBe(true);
      expect([...(db.consentGrants.get('alice')?.get('client-1') ?? [])]).toEqual([record?.grantId]);
    });
  });

  describe('Scope policy', () => {
    beforeEach(() => {
      RESTRICTED_SCOPE_SUBJECTS['reports.read'] = ['bob'];
    });
    afterEach(() => {
      delete RESTRICTED_SCOPE_SUBJECTS['reports.read'];
    });

    // RFC 6749 §3.3: a scope the End-User cannot hold narrows the grant.
    it('should issue the tokens for the scopes the End-User may be granted', async () => {
      const { db, outcome } = await approve(implicitTransaction({ scope: 'openid reports.read' }));

      expect(fragmentOf(outcome).params['scope']).toBe('openid');
      expect([...db.accessTokens.values()].map((record) => record.scope)).toEqual([['openid']]);
    });
  });

  describe('Errors', () => {
    // OIDC Core 1.0 §3.2.2.6: the error goes back to the client in the fragment.
    it('should answer server_error in the fragment, recording no consent, when no ID Token signing key has the registered alg', async () => {
      const { outcome, stores } = await approve(implicitTransaction(), { idTokenSignedResponseAlg: 'ES256' });

      expect(fragmentOf(outcome).params).toEqual({
        error: 'server_error',
        error_description: 'No ID Token signing key registered for alg ES256',
        state: 'state-1',
        iss: TEST_ISSUER,
      });
      expect(outcome).toMatchObject({ cookies: [buildClearedTransactionCookie()] });
      expect(await stores.consentStore.hasConsent('alice', 'client-1', ['openid'])).toBe(false);
    });
  });
});
