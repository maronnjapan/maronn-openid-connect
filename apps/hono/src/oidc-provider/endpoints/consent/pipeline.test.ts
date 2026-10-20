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
import { createProviderStores } from '../../db/memory/stores.js';
import { prepareConsent, submitConsent } from './pipeline.js';

const CLEARED_TRANSACTION_COOKIE = '__Host-oidc_txn=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

/** A consent POST of the browser that is in the transaction, with alice signed in for it unless loggedIn is false. */
async function postContext(
  input: { cookie?: string; headers?: Record<string, string>; loggedIn?: boolean; transaction?: AuthTransaction } = {},
) {
  const db = createEmptyDatabase();
  await storeTransaction(db, input.transaction);
  if (input.loggedIn !== false) {
    await createProviderStores(db).authSessionStore.set(TRANSACTION_ID, {
      subject: 'alice',
      authTime: 1700000000,
      sessionId: 'sid-1',
    });
  }
  const { c } = await providerContext({
    db,
    request: formPost('/consent', {}, { Cookie: input.cookie ?? transactionCookie(), ...input.headers }),
  });
  return { c, db };
}

describe('prepareConsent', () => {
  it('should describe the form for the transaction of the cookie', async () => {
    const db = createEmptyDatabase();
    await storeTransaction(db);
    const { c } = await providerContext({
      db,
      request: requestTo('/consent', { headers: { Cookie: transactionCookie() } }),
    });

    expect(await prepareConsent(c)).toEqual({
      kind: 'screen',
      csrfToken: CSRF_TOKEN,
      clientId: 'client-1',
      scopes: ['openid', 'profile'],
    });
  });

  it('should answer the error page when the browser is in no transaction', async () => {
    const { c } = await providerContext({ request: requestTo('/consent') });

    expect(await prepareConsent(c)).toMatchObject({ kind: 'error', statusCode: 400 });
  });
});

describe('submitConsent', () => {
  describe('Refusals', () => {
    it('should refuse a decision posted from a sibling subdomain with 403', async () => {
      const { c, db } = await postContext({ headers: { 'Sec-Fetch-Site': 'same-site' } });

      expect(await submitConsent(c, { csrfToken: CSRF_TOKEN, action: 'approve' })).toMatchObject({
        kind: 'error',
        statusCode: 403,
      });
      expect(db.codes.size).toBe(0);
    });

    it('should refuse a csrf_token of another transaction with 403', async () => {
      const { c } = await postContext();

      expect(await submitConsent(c, { csrfToken: 'csrf-of-another-transaction', action: 'approve' })).toEqual({
        kind: 'error',
        error: 'Invalid CSRF token.',
        statusCode: 403,
      });
    });

    // OIDC Core 1.0 §3.1.2.4: no decision is not a denial and never an approval.
    it('should answer invalid_decision for an unknown action and keep the transaction', async () => {
      const { c, db } = await postContext();

      expect(await submitConsent(c, { csrfToken: CSRF_TOKEN, action: 'maybe' })).toEqual({ kind: 'invalid_decision' });
      expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(true);
    });

    it('should answer session_missing when no End-User signed in for the transaction', async () => {
      const { c, db } = await postContext({ loggedIn: false });

      expect(await submitConsent(c, { csrfToken: CSRF_TOKEN, action: 'approve' })).toEqual({
        kind: 'session_missing',
      });
      expect(db.codes.size).toBe(0);
    });
  });

  // OIDC Core 1.0 §3.1.2.6
  it('should answer access_denied to the client when the End-User denies', async () => {
    const { c, db } = await postContext();

    expect(await submitConsent(c, { csrfToken: CSRF_TOKEN, action: 'deny' })).toEqual({
      kind: 'authorization_response',
      response: { method: 'redirect', location: 'https://rp.example.com/callback?error=access_denied&state=state-1&iss=https%3A%2F%2Fop.example.com' },
      cookies: [CLEARED_TRANSACTION_COOKIE],
    });
    expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
  });

  // OIDC Core 1.0 §3.1.2.5 / RFC 9207 §2
  it('should issue a code, record the consent and answer the client when the End-User approves', async () => {
    const { c, db } = await postContext();

    const outcome = await submitConsent(c, { csrfToken: CSRF_TOKEN, action: 'approve' });
    const [code = ''] = [...db.codes.keys()];

    expect(outcome).toEqual({
      kind: 'authorization_response',
      response: { method: 'redirect', location: `https://rp.example.com/callback?code=${code}&state=state-1&iss=https%3A%2F%2Fop.example.com` },
      cookies: [CLEARED_TRANSACTION_COOKIE],
    });
    expect(db.codes.get(code)).toMatchObject({ subject: 'alice', sessionId: 'sid-1', scope: ['openid', 'profile'] });
    expect(await createProviderStores(db).consentStore.hasConsent('alice', 'client-1', ['openid', 'profile'])).toBe(
      true,
    );
    expect(db.authSessions.has(TRANSACTION_ID)).toBe(false);
  });

  // OIDC Core 1.0 §3.2: /authorize stored the fragment response mode for a
  // request of the Implicit Flow.
  describe('Implicit Flow', () => {
    const implicitTransaction = sampleTransaction({
      responseType: 'id_token token',
      nonce: 'nonce-1',
      responseMode: 'fragment',
    } as Partial<AuthTransaction>);

    // OIDC Core 1.0 §3.2.2.5 / RFC 9207 §2: the tokens in place of a code.
    it('should issue the tokens, record the consent and answer in the fragment when the End-User approves', async () => {
      const { c, db } = await postContext({ transaction: implicitTransaction });

      const outcome = await submitConsent(c, { csrfToken: CSRF_TOKEN, action: 'approve' });
      const [accessToken = ''] = [...db.accessTokens.keys()];

      expect(outcome).toEqual({
        kind: 'authorization_response',
        response: {
          method: 'redirect',
          location: expect.stringMatching(
            new RegExp(
              `^https://rp\\.example\\.com/callback#access_token=${accessToken}&token_type=Bearer&expires_in=3600&scope=openid\\+profile&id_token=[^&]+&state=state-1&iss=https%3A%2F%2Fop\\.example\\.com$`,
            ),
          ),
        },
        cookies: [CLEARED_TRANSACTION_COOKIE],
      });
      expect(db.codes.size).toBe(0);
      expect(await createProviderStores(db).consentStore.hasConsent('alice', 'client-1', ['openid', 'profile'])).toBe(
        true,
      );
      expect(db.authSessions.has(TRANSACTION_ID)).toBe(false);
    });

    // OIDC Core 1.0 §3.2.2.6: the error goes back in the fragment.
    it('should answer access_denied in the fragment when the End-User denies', async () => {
      const { c, db } = await postContext({ transaction: implicitTransaction });

      expect(await submitConsent(c, { csrfToken: CSRF_TOKEN, action: 'deny' })).toEqual({
        kind: 'authorization_response',
        response: { method: 'redirect', location: 'https://rp.example.com/callback#error=access_denied&state=state-1&iss=https%3A%2F%2Fop.example.com' },
        cookies: [CLEARED_TRANSACTION_COOKIE],
      });
      expect(db.accessTokens.size).toBe(0);
    });
  });

  // OIDC Core 1.0 §3.3: /authorize stored the fragment response mode for a
  // request of the Hybrid Flow.
  describe('Hybrid Flow', () => {
    const hybridTransaction = sampleTransaction({
      responseType: 'code id_token token',
      nonce: 'nonce-1',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      responseMode: 'fragment',
    } as Partial<AuthTransaction>);

    // OIDC Core 1.0 §3.3.2.5 / RFC 9207 §2: the code with the tokens.
    it('should issue the code and the tokens, record the consent and answer in the fragment when the End-User approves', async () => {
      const { c, db } = await postContext({ transaction: hybridTransaction });

      const outcome = await submitConsent(c, { csrfToken: CSRF_TOKEN, action: 'approve' });
      const [code = ''] = [...db.codes.keys()];
      const [accessToken = ''] = [...db.accessTokens.keys()];

      expect(outcome).toEqual({
        kind: 'authorization_response',
        response: {
          method: 'redirect',
          location: expect.stringMatching(
            new RegExp(
              `^https://rp\\.example\\.com/callback#code=${code}&access_token=${accessToken}&token_type=Bearer&expires_in=3600&scope=openid\\+profile&id_token=[^&]+&state=state-1&iss=https%3A%2F%2Fop\\.example\\.com$`,
            ),
          ),
        },
        cookies: [CLEARED_TRANSACTION_COOKIE],
      });
      expect(db.codes.get(code)).toMatchObject({ subject: 'alice', sessionId: 'sid-1', scope: ['openid', 'profile'], nonce: 'nonce-1' });
      expect(await createProviderStores(db).consentStore.hasConsent('alice', 'client-1', ['openid', 'profile'])).toBe(
        true,
      );
      expect(db.authSessions.has(TRANSACTION_ID)).toBe(false);
    });

    // OIDC Core 1.0 §3.3.2.6: the error goes back in the fragment.
    it('should answer access_denied in the fragment when the End-User denies', async () => {
      const { c, db } = await postContext({ transaction: hybridTransaction });

      expect(await submitConsent(c, { csrfToken: CSRF_TOKEN, action: 'deny' })).toEqual({
        kind: 'authorization_response',
        response: { method: 'redirect', location: 'https://rp.example.com/callback#error=access_denied&state=state-1&iss=https%3A%2F%2Fop.example.com' },
        cookies: [CLEARED_TRANSACTION_COOKIE],
      });
      expect(db.codes.size).toBe(0);
      expect(db.accessTokens.size).toBe(0);
    });
  });
});
