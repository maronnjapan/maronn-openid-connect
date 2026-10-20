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
import { issueHybridConsentResponse } from './issue-hybrid-response.js';

const NOW_SECONDS = 1767225600; // 2026-01-01T00:00:00Z
const session = { subject: 'alice', authTime: NOW_SECONDS - 30, sessionId: 'sid-1' };

/** A transaction of the Hybrid Flow as /authorize stores it, answered in the fragment. */
function hybridTransaction(overrides: Partial<AuthTransaction> & { responseMode?: string } = {}): AuthTransaction {
  return sampleTransaction({
    responseType: 'code id_token token',
    nonce: 'nonce-1',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    responseMode: 'fragment',
    ...overrides,
  } as Partial<AuthTransaction>);
}

/** Store the transaction, sign alice in for it and approve it. */
async function approve(transaction: AuthTransaction, client: Partial<ClientRegistration> = {}) {
  const db = createEmptyDatabase();
  await storeTransaction(db, transaction);
  const context = await providerContext({ db });
  await registerTestClient(db, client);
  await context.stores.authSessionStore.set(TRANSACTION_ID, session);
  const outcome = await issueHybridConsentResponse(context.c, {
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

describe('issueHybridConsentResponse', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_SECONDS * 1000));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Other flows', () => {
    // The steps after this one issue the code; the Implicit Flow has a step of its own.
    it('should return undefined and keep the transaction of response_type=code and of id_token', async () => {
      const code = await approve(sampleTransaction());
      const implicit = await approve(sampleTransaction({ responseType: 'id_token', nonce: 'nonce-1' }));

      expect(code.outcome).toBeUndefined();
      expect(code.db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(true);
      expect(implicit.outcome).toBeUndefined();
      expect(implicit.db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(true);
    });
  });

  describe('Authorization response', () => {
    // OIDC Core 1.0 §3.3.2.5 / RFC 9207 §2: the code, the tokens, the state and
    // iss in the fragment; the transaction cookie is cleared.
    it('should redirect with the code, the tokens, the state and iss in the fragment and clear the transaction cookie', async () => {
      const { db, outcome } = await approve(hybridTransaction());

      const { target, params } = fragmentOf(outcome);
      expect(target).toBe(REDIRECT_URI);
      expect(params).toEqual({
        code: [...db.codes.keys()][0],
        access_token: [...db.accessTokens.keys()][0],
        token_type: 'Bearer',
        expires_in: '3600',
        scope: 'openid profile',
        id_token: expect.any(String),
        state: 'state-1',
        iss: TEST_ISSUER,
      });
      expect(outcome).toMatchObject({ cookies: [buildClearedTransactionCookie()] });
    });

    // OIDC Core 1.0 §3.3.2.11: the ID Token carries the nonce of the request and c_hash.
    it('should issue an ID Token for alice with the nonce of the request and c_hash for response_type=code id_token', async () => {
      const { outcome } = await approve(hybridTransaction({ responseType: 'code id_token' }));

      const { params } = fragmentOf(outcome);
      expect(Object.keys(params)).toEqual(['code', 'id_token', 'state', 'iss']);
      expect(decodeJwt(params['id_token'] ?? '').payload).toMatchObject({
        sub: 'alice',
        aud: 'client-1',
        nonce: 'nonce-1',
        c_hash: expect.any(String),
      });
    });

    // OAuth 2.0 Form Post Response Mode §2: the response mode the request asked for.
    it('should post the code and the tokens when the request asked for response_mode=form_post', async () => {
      const { outcome } = await approve(hybridTransaction({ responseType: 'code token', responseMode: 'form_post' }));

      expect(outcome).toEqual({
        kind: 'authorization_response',
        response: {
          method: 'form_post',
          action: REDIRECT_URI,
          fields: {
            code: expect.any(String),
            access_token: expect.any(String),
            token_type: 'Bearer',
            expires_in: '3600',
            scope: 'openid profile',
            state: 'state-1',
            iss: TEST_ISSUER,
          },
        },
        cookies: [buildClearedTransactionCookie()],
      });
    });

    // OAuth 2.0 Multiple Response Type Encoding Practices §5: never the query,
    // even for a transaction that stores no response mode.
    it('should answer in the fragment when the transaction stores no response mode', async () => {
      const { outcome } = await approve(hybridTransaction({ responseType: 'code id_token', responseMode: undefined }));

      expect(Object.keys(fragmentOf(outcome).params)).toEqual(['code', 'id_token', 'state', 'iss']);
    });
  });

  describe('Grant', () => {
    // One-time use: the transaction cannot be approved twice.
    it('should finish the transaction and discard the login hand-off', async () => {
      const { db } = await approve(hybridTransaction());

      expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
      expect(db.authSessions.has(TRANSACTION_ID)).toBe(false);
    });

    // OIDC Core 1.0 §3.1.2.1: a later prompt=none finds the consent, and
    // withdrawing it revokes the one grant of the code and the access token.
    it('should record the consent and the grant of the code and the access token', async () => {
      const { db, stores } = await approve(hybridTransaction());

      const [code] = [...db.codes.values()];
      const [accessToken] = [...db.accessTokens.values()];
      expect(await stores.consentStore.hasConsent('alice', 'client-1', ['openid', 'profile'])).toBe(true);
      expect(accessToken?.grantId).toBe(code?.grantId);
      expect([...(db.consentGrants.get('alice')?.get('client-1') ?? [])]).toEqual([code?.grantId]);
    });

    // The code binds the online refresh token to the login session the login step stored.
    it('should store the code for the session of the login step', async () => {
      const { db } = await approve(hybridTransaction());

      expect([...db.codes.values()]).toEqual([
        expect.objectContaining({ subject: 'alice', sessionId: 'sid-1', nonce: 'nonce-1', scope: ['openid', 'profile'] }),
      ]);
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
    it('should issue the code and the tokens for the scopes the End-User may be granted', async () => {
      const { db, outcome } = await approve(hybridTransaction({ scope: 'openid reports.read' }));

      expect(fragmentOf(outcome).params['scope']).toBe('openid');
      expect([...db.codes.values()].map((record) => record.scope)).toEqual([['openid']]);
      expect([...db.accessTokens.values()].map((record) => record.scope)).toEqual([['openid']]);
    });
  });

  describe('Errors', () => {
    // OIDC Core 1.0 §3.3.2.6: the error goes back to the client in the fragment.
    it('should answer server_error in the fragment, recording no consent and no code, when no ID Token signing key has the registered alg', async () => {
      const { db, outcome, stores } = await approve(hybridTransaction(), { idTokenSignedResponseAlg: 'ES256' });

      expect(fragmentOf(outcome).params).toEqual({
        error: 'server_error',
        error_description: 'No ID Token signing key registered for alg ES256',
        state: 'state-1',
        iss: TEST_ISSUER,
      });
      expect(outcome).toMatchObject({ cookies: [buildClearedTransactionCookie()] });
      expect(await stores.consentStore.hasConsent('alice', 'client-1', ['openid'])).toBe(false);
      expect(db.codes.size).toBe(0);
    });
  });
});
