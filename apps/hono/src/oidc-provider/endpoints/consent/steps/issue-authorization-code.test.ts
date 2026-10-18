import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import {
  REDIRECT_URI,
  TRANSACTION_ID,
  sampleTransaction,
  storeTransaction,
} from '../../../../test-support/screens.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { RESTRICTED_SCOPE_SUBJECTS } from '../../../scopes.js';
import { issueConsentedAuthorizationCode } from './issue-authorization-code.js';

const NOW_SECONDS = 1767225600; // 2026-01-01T00:00:00Z
const session = { subject: 'alice', authTime: NOW_SECONDS - 30, sessionId: 'sid-1' };

async function setUp(input: { authorizationCodeTtl?: number; scope?: string } = {}) {
  const db = createEmptyDatabase();
  const transaction = await storeTransaction(
    db,
    sampleTransaction({ scope: input.scope ?? 'openid profile', nonce: 'nonce-1', codeChallenge: 'challenge-1', codeChallengeMethod: 'S256' }),
  );
  const { c } = await providerContext({
    db,
    options: {
      config: {
        issuer: 'https://op.example.com',
        ...(input.authorizationCodeTtl === undefined ? {} : { authorizationCodeTtl: input.authorizationCodeTtl }),
      },
    },
  });
  return { c, db, transaction };
}

describe('issueConsentedAuthorizationCode', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_SECONDS * 1000));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // OIDC Core 1.0 §3.1.2.5 / §3.1.3.1
  it('should store a code bound to the End-User, the session and the request', async () => {
    const { c, db, transaction } = await setUp();

    const { authCodeData } = await issueConsentedAuthorizationCode(c, TRANSACTION_ID, transaction, session);

    expect(db.codes.get(authCodeData.code)).toEqual({
      code: authCodeData.code,
      grantId: authCodeData.grantId,
      clientId: 'client-1',
      redirectUri: REDIRECT_URI,
      redirectUriExplicit: true,
      scope: ['openid', 'profile'],
      subject: 'alice',
      used: false,
      // OIDC Core 1.0 §3.1.3.1: short-lived, config.authorizationCodeTtl (300 seconds by default).
      expiresAt: NOW_SECONDS + 300,
      authTime: NOW_SECONDS - 30,
      nonce: 'nonce-1',
      codeChallenge: 'challenge-1',
      codeChallengeMethod: 'S256',
      sessionId: 'sid-1',
      transactionId: TRANSACTION_ID,
    });
  });

  it('should finish the transaction so that it cannot issue a second code', async () => {
    const { c, db, transaction } = await setUp();

    await issueConsentedAuthorizationCode(c, TRANSACTION_ID, transaction, session);

    expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
  });

  it('should return the response parameters of the request and the granted scope', async () => {
    const { c, transaction } = await setUp();

    const { responseParams, grantedScope } = await issueConsentedAuthorizationCode(c, TRANSACTION_ID, transaction, session);

    expect(responseParams).toMatchObject({ redirectUri: REDIRECT_URI, state: 'state-1', clientId: 'client-1' });
    expect(grantedScope).toEqual(['openid', 'profile']);
  });

  it('should let the code live for config.authorizationCodeTtl seconds', async () => {
    const { c, transaction } = await setUp({ authorizationCodeTtl: 60 });

    const { authCodeData } = await issueConsentedAuthorizationCode(c, TRANSACTION_ID, transaction, session);

    expect(authCodeData.expiresAt).toBe(NOW_SECONDS + 60);
  });

  describe('Scope policy', () => {
    beforeEach(() => {
      RESTRICTED_SCOPE_SUBJECTS['reports.read'] = ['bob'];
    });
    afterEach(() => {
      delete RESTRICTED_SCOPE_SUBJECTS['reports.read'];
    });

    // RFC 6749 §3.3: a scope the End-User cannot hold narrows the grant instead of failing it.
    it('should issue the code for the scopes the End-User may be granted', async () => {
      const { c, transaction } = await setUp({ scope: 'openid reports.read' });

      const { authCodeData, grantedScope } = await issueConsentedAuthorizationCode(
        c,
        TRANSACTION_ID,
        transaction,
        session,
      );

      expect(grantedScope).toEqual(['openid']);
      expect(authCodeData.scope).toEqual(['openid']);
    });
  });
});
