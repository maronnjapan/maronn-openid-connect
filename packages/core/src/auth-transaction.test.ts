import { describe, it, expect } from 'vitest';
import {
  computeTransactionBindingHash,
  createAuthTransaction,
  AuthTransactionError,
  AuthTransactionErrorCode,
  getAuthTransaction,
  validateCsrfToken,
  validateTransactionBinding,
  handleLoginFailure,
  completeAuthTransaction,
  requiresReauthentication,
} from './auth-transaction.js';
import { sha256 } from './crypto-utils.js';
import type {
  AuthTransaction,
  AuthTransactionStore,
} from './auth-transaction.js';
import type { ValidatedAuthorizationRequest } from './authorization-request.js';

function createValidatedRequest(
  overrides?: Partial<ValidatedAuthorizationRequest>,
): ValidatedAuthorizationRequest {
  return {
    clientId: 'client-1',
    redirectUri: 'https://client.example.com/cb',
    responseType: 'code',
    scope: ['openid', 'profile'],
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
    state: 'state-1',
    ...overrides,
  } as ValidatedAuthorizationRequest;
}

function createTransaction(overrides?: Partial<AuthTransaction>): AuthTransaction {
  const validated = createValidatedRequest();
  return {
    ...createAuthTransaction(validated, 'csrf-token'),
    ...overrides,
  };
}

class InMemoryStore implements AuthTransactionStore {
  private map = new Map<string, { value: AuthTransaction; expiresAt: number }>();

  async get(key: string): Promise<AuthTransaction | null> {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: AuthTransaction, ttlSeconds: number): Promise<void> {
    this.map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

// Quick smoke tests for existing functions that previously had no dedicated test file.
describe('createAuthTransaction', () => {
  it('should store idTokenHint when provided in ValidatedAuthorizationRequest', () => {
    const validated = createValidatedRequest({ idTokenHint: 'hint.jwt.token' });
    const txn = createAuthTransaction(validated, 'csrf');
    expect(txn.idTokenHint).toBe('hint.jwt.token');
  });

  it('should not set idTokenHint when not provided', () => {
    const validated = createValidatedRequest();
    const txn = createAuthTransaction(validated, 'csrf');
    expect(txn.idTokenHint).toBeUndefined();
  });

  // OIDC Core 1.0 §3.1.2.1 / §5.2: ui_locales / claims_locales pass through to the
  // transaction so the login/consent UI and claim rendering can honor them.
  it('should store uiLocales and claimsLocales when provided', () => {
    const validated = createValidatedRequest({
      uiLocales: 'fr-CA fr en',
      claimsLocales: 'en de',
    });
    const txn = createAuthTransaction(validated, 'csrf');
    expect(txn.uiLocales).toBe('fr-CA fr en');
    expect(txn.claimsLocales).toBe('en de');
  });

  it('should leave uiLocales and claimsLocales undefined when not provided', () => {
    const validated = createValidatedRequest();
    const txn = createAuthTransaction(validated, 'csrf');
    expect(txn.uiLocales).toBeUndefined();
    expect(txn.claimsLocales).toBeUndefined();
  });

  it('should set createdAt and expiresAt with provided ttl', () => {
    const validated = createValidatedRequest();
    const before = Date.now();
    const txn = createAuthTransaction(validated, 'csrf', { ttlMs: 1000 });
    expect(txn.createdAt).toBeGreaterThanOrEqual(before);
    expect(txn.expiresAt - txn.createdAt).toBe(1000);
  });

  it('should preserve csrf token', () => {
    const validated = createValidatedRequest();
    const txn = createAuthTransaction(validated, 'my-csrf');
    expect(txn.csrfToken).toBe('my-csrf');
  });

  it('should join scope with space', () => {
    const validated = createValidatedRequest({ scope: ['openid', 'email'] });
    const txn = createAuthTransaction(validated, 'csrf');
    expect(txn.scope).toBe('openid email');
  });

  it('should omit PKCE fields when the validated request has no PKCE binding', () => {
    const validated = createValidatedRequest({
      codeChallenge: undefined,
      codeChallengeMethod: undefined,
    });
    const txn = createAuthTransaction(validated, 'csrf');
    expect(txn.codeChallenge).toBeUndefined();
    expect(txn.codeChallengeMethod).toBeUndefined();
  });

  describe('User-Agent binding', () => {
    it('should store the bindingHash passed through options', async () => {
      const validated = createValidatedRequest();
      const bindingHash = await computeTransactionBindingHash('binding-secret');
      const txn = createAuthTransaction(validated, 'csrf', { bindingHash });
      expect(txn.bindingHash).toBe(bindingHash);
    });

    // The raw secret lives only in the User-Agent's cookie. Storing the hash means
    // a leak of the transaction store alone cannot be replayed as a valid binding.
    it('should store only the hash and never the raw binding secret in the transaction', async () => {
      const validated = createValidatedRequest();
      const bindingHash = await computeTransactionBindingHash('binding-secret');
      const txn = createAuthTransaction(validated, 'csrf', { bindingHash });
      expect(JSON.stringify(txn).includes('binding-secret')).toBe(false);
    });

    it('should leave bindingHash undefined when no options are given', () => {
      const validated = createValidatedRequest();
      const txn = createAuthTransaction(validated, 'csrf');
      expect(txn.bindingHash).toBeUndefined();
    });

    it('should apply ttlMs from the options object', async () => {
      const validated = createValidatedRequest();
      const bindingHash = await computeTransactionBindingHash('binding-secret');
      const txn = createAuthTransaction(validated, 'csrf', { ttlMs: 1000, bindingHash });
      expect(txn.expiresAt - txn.createdAt).toBe(1000);
    });

  });
});

describe('getAuthTransaction', () => {
  it('should throw when transaction is missing', async () => {
    const store = new InMemoryStore();
    await expect(getAuthTransaction('missing', store)).rejects.toBeInstanceOf(AuthTransactionError);
  });

  it('should throw when transaction is expired', async () => {
    const store = new InMemoryStore();
    const validated = createValidatedRequest();
    const txn = createAuthTransaction(validated, 'csrf', { ttlMs: 1000 });
    txn.expiresAt = Date.now() - 1;
    await store.put('auth_txn:abc', txn, 60);
    try {
      await getAuthTransaction('abc', store);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthTransactionError);
      expect((e as AuthTransactionError).code).toBe(AuthTransactionErrorCode.TransactionExpired);
    }
  });
});

describe('validateCsrfToken', () => {
  it('should throw when token is empty', () => {
    const txn = createTransaction();
    expect(() => validateCsrfToken(txn, '')).toThrow(AuthTransactionError);
  });

  it('should throw when token does not match', () => {
    const txn = createTransaction({ csrfToken: 'real' });
    expect(() => validateCsrfToken(txn, 'fake')).toThrow(AuthTransactionError);
  });

  it('should not throw when token matches', () => {
    const txn = createTransaction({ csrfToken: 'real' });
    expect(() => validateCsrfToken(txn, 'real')).not.toThrow();
  });
});

// OIDC Core 1.0 §3.1.2.3 / §3.1.2.4: the End-User that is authenticated and that
// grants consent must be the same User-Agent that sent the authorization request.
// The spec leaves the mechanism to the implementation; this binds the transaction
// to a secret handed to that User-Agent in a cookie.
describe('validateTransactionBinding', () => {
  it('should accept a transaction when the presented binding secret matches the stored hash', async () => {
    const txn = createTransaction({
      bindingHash: await computeTransactionBindingHash('binding-secret'),
    });
    await expect(validateTransactionBinding(txn, 'binding-secret')).resolves.toBeUndefined();
  });

  it('should reject a transaction when the presented binding secret does not match', async () => {
    const txn = createTransaction({
      bindingHash: await computeTransactionBindingHash('binding-secret'),
    });
    await expect(validateTransactionBinding(txn, 'other-secret')).rejects.toMatchObject({
      name: 'AuthTransactionError',
      code: AuthTransactionErrorCode.InvalidTransactionBinding,
    });
  });

  it('should reject a transaction when no binding secret is presented', async () => {
    const txn = createTransaction({
      bindingHash: await computeTransactionBindingHash('binding-secret'),
    });
    await expect(validateTransactionBinding(txn, undefined)).rejects.toMatchObject({
      name: 'AuthTransactionError',
      code: AuthTransactionErrorCode.InvalidTransactionBinding,
    });
  });

  it('should reject a transaction when an empty binding secret is presented', async () => {
    const txn = createTransaction({
      bindingHash: await computeTransactionBindingHash('binding-secret'),
    });
    await expect(validateTransactionBinding(txn, '')).rejects.toMatchObject({
      name: 'AuthTransactionError',
      code: AuthTransactionErrorCode.InvalidTransactionBinding,
    });
  });

  // A transaction without a bindingHash cannot prove which User-Agent started it,
  // so it is rejected even when a binding secret is presented.
  it('should reject a transaction that has no bindingHash', async () => {
    const txn = createTransaction();
    expect(txn.bindingHash).toBeUndefined();
    await expect(validateTransactionBinding(txn, 'binding-secret')).rejects.toMatchObject({
      name: 'AuthTransactionError',
      code: AuthTransactionErrorCode.InvalidTransactionBinding,
    });
  });

  it('should report 400 as the HTTP status code for a binding failure', async () => {
    const txn = createTransaction({
      bindingHash: await computeTransactionBindingHash('binding-secret'),
    });
    try {
      await validateTransactionBinding(txn, 'other-secret');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthTransactionError);
      expect((e as AuthTransactionError).httpStatusCode).toBe(400);
    }
  });
});

describe('computeTransactionBindingHash', () => {
  it('should return the base64url SHA-256 digest of the binding secret', async () => {
    // SHA-256('binding-secret') as base64url, computed independently of the implementation.
    expect(await computeTransactionBindingHash('binding-secret')).toBe(
      await sha256('binding-secret'),
    );
  });

  it('should return different hashes for different secrets', async () => {
    const a = await computeTransactionBindingHash('secret-a');
    const b = await computeTransactionBindingHash('secret-b');
    expect(a === b).toBe(false);
  });
});

describe('handleLoginFailure', () => {
  it('should increment failedAttempts and persist when below max', async () => {
    const store = new InMemoryStore();
    const txn = createTransaction({ failedAttempts: 0 });
    await store.put('auth_txn:t', txn, 60);
    const result = await handleLoginFailure('t', txn, store, 3);
    expect(result.canRetry).toBe(true);
    expect(result.failedAttempts).toBe(1);
  });

  it('should delete transaction when reaching max attempts', async () => {
    const store = new InMemoryStore();
    const txn = createTransaction({ failedAttempts: 2 });
    await store.put('auth_txn:t', txn, 60);
    const result = await handleLoginFailure('t', txn, store, 3);
    expect(result.canRetry).toBe(false);
    expect(await store.get('auth_txn:t')).toBeNull();
  });
});

describe('completeAuthTransaction', () => {
  it('should delete transaction from the store', async () => {
    const store = new InMemoryStore();
    const txn = createTransaction();
    await store.put('auth_txn:t', txn, 60);
    await completeAuthTransaction('t', txn, store);
    expect(await store.get('auth_txn:t')).toBeNull();
  });

  it('should return AuthorizationResponseParams with redirectUri and clientId', async () => {
    const store = new InMemoryStore();
    const txn = createTransaction({ redirectUri: 'https://x/cb', clientId: 'c1', state: 's1' });
    await store.put('auth_txn:t', txn, 60);
    const result = await completeAuthTransaction('t', txn, store);
    expect(result.redirectUri).toBe('https://x/cb');
    expect(result.clientId).toBe('c1');
    expect(result.state).toBe('s1');
  });

  it('should omit PKCE fields when the transaction has no PKCE binding', async () => {
    const store = new InMemoryStore();
    const txn = createTransaction({
      codeChallenge: undefined,
      codeChallengeMethod: undefined,
    });
    await store.put('auth_txn:t', txn, 60);

    const result = await completeAuthTransaction('t', txn, store);

    expect(result.codeChallenge).toBeUndefined();
    expect(result.codeChallengeMethod).toBeUndefined();
  });

  // OIDC Core 1.0 §3.1.2.1: acr_values requested at the authorization endpoint must
  // survive into the authorization response so it can reach the AcrResolver later.
  it('should carry acrValues into AuthorizationResponseParams', async () => {
    const store = new InMemoryStore();
    const txn = createTransaction({ acrValues: 'loa2 loa3' });
    await store.put('auth_txn:t', txn, 60);

    const result = await completeAuthTransaction('t', txn, store);

    expect(result.acrValues).toBe('loa2 loa3');
  });

  it('should omit acrValues when the transaction has none', async () => {
    const store = new InMemoryStore();
    const txn = createTransaction({ acrValues: undefined });
    await store.put('auth_txn:t', txn, 60);

    const result = await completeAuthTransaction('t', txn, store);

    expect(result.acrValues).toBeUndefined();
  });

  // The authorization code is issued from these params, so naming the transaction
  // lets a store record which transaction produced the code.
  it('should return the id of the completed transaction', async () => {
    const store = new InMemoryStore();
    const txn = createTransaction();
    await store.put('auth_txn:txn-1', txn, 60);

    const result = await completeAuthTransaction('txn-1', txn, store);

    expect(result.transactionId).toBe('txn-1');
  });
});

describe('requiresReauthentication', () => {
  it('should return true when session is older than maxAge', () => {
    const past = Math.floor(Date.now() / 1000) - 1000;
    expect(requiresReauthentication(60, past)).toBe(true);
  });

  it('should return false when session is fresh enough', () => {
    const recent = Math.floor(Date.now() / 1000) - 10;
    expect(requiresReauthentication(60, recent)).toBe(false);
  });

  // OIDC Core 1.0 Section 3.1.2.1: max_age=0 means the End-User MUST be
  // actively re-authenticated. auth_time is a second-precision NumericDate
  // (Section 2), so a login and an authorization within the same wall-clock
  // second give authTime === now; a strict `now - authTime > 0` would wrongly
  // return false and reuse the existing session.
  it('should return true when maxAge is 0 and authTime equals now', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(requiresReauthentication(0, now)).toBe(true);
  });

  it('should return true when maxAge is 0 and authTime is in the past', () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    expect(requiresReauthentication(0, past)).toBe(true);
  });

  // Negative maxAge is not a valid request value, but guard to the safe side
  // (force re-authentication) rather than reuse the session.
  it('should return true when maxAge is negative', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(requiresReauthentication(-1, now)).toBe(true);
  });

  // Regression fixes for the existing greater-than boundary (max_age > 0).
  it('should return true when maxAge is 10 and 11 seconds elapsed', () => {
    const authTime = Math.floor(Date.now() / 1000) - 11;
    expect(requiresReauthentication(10, authTime)).toBe(true);
  });
});
