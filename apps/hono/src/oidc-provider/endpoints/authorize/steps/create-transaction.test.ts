import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ID,
  CODE_CHALLENGE,
  NONCE,
  recordingResponseMode,
  REDIRECT_URI,
  STATE,
  validatedRequestOf,
} from '../../../../test-support/authorize.js';
import { providerContext } from '../../../../test-support/context.js';
import { createAuthorizationTransaction } from './create-transaction.js';

const NOW = new Date('2026-01-01T00:00:00Z').getTime();

describe('createAuthorizationTransaction', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // OIDC Core 1.0 §3.1.2.3: the request is kept for the login / consent steps.
  it('should build the transaction from the validated request with a ten-minute lifetime', async () => {
    const { c } = await providerContext();

    const { transaction, transactionTtlSeconds } = await createAuthorizationTransaction(
      c,
      validatedRequestOf({ scope: ['openid', 'profile'], prompt: ['login'], maxAge: 120 }),
      undefined,
    );

    expect(transactionTtlSeconds).toBe(600);
    expect(transaction).toEqual({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      redirectUriExplicit: true,
      responseType: 'code',
      scope: 'openid profile',
      state: STATE,
      nonce: NONCE,
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: 'S256',
      prompt: 'login',
      maxAge: 120,
      csrfToken: transaction.csrfToken,
      createdAt: NOW,
      expiresAt: NOW + 600_000,
      failedAttempts: 0,
    });
  });

  it('should store the transaction under auth_txn:<transactionId> until it expires', async () => {
    const { c, db } = await providerContext();

    const { transactionId, transaction } = await createAuthorizationTransaction(c, validatedRequestOf(), undefined);

    expect([...db.transactions.entries()]).toEqual([
      ['auth_txn:' + transactionId, { value: transaction, expiresAt: NOW + 600_000 }],
    ]);
  });

  // The transaction id only travels in the HttpOnly cookie and the csrf token
  // only in the forms, so each must be an unguessable value of its own.
  it('should give the transaction id and the csrf token 256-bit random values that differ', async () => {
    const { c } = await providerContext();

    const { transactionId, transaction } = await createAuthorizationTransaction(c, validatedRequestOf(), undefined);

    expect(transactionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(transaction.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(transactionId).not.toBe(transaction.csrfToken);
  });

  // JARM §2.3: /consent restores the response mode from the stored transaction.
  it('should record the name of the response mode on the stored transaction only', async () => {
    const { c, db } = await providerContext();
    const { responseMode } = recordingResponseMode('query.jwt');

    const { transactionId, transaction } = await createAuthorizationTransaction(c, validatedRequestOf(), responseMode);

    expect(db.transactions.get('auth_txn:' + transactionId)?.value).toEqual({ ...transaction, responseMode: 'query.jwt' });
    expect(transaction).not.toHaveProperty('responseMode');
  });
});
