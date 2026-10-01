import { describe, expect, it } from 'vitest';

import { GoogleLoginErrorCode } from './errors.js';
import { consumeGoogleLoginNonce, issueGoogleLoginNonce } from './nonce.js';
import { captureRejection, createInMemoryNonceStore, expectGoogleLoginError } from './test-helpers.js';

const now = new Date(1_700_000_000_000);

describe('issueGoogleLoginNonce', () => {
  it('should return a 43 character base64url nonce', async () => {
    const nonce = await issueGoogleLoginNonce({
      transactionId: 'txn-1',
      expiresAt: now.getTime() + 600_000,
      store: createInMemoryNonceStore(),
    });

    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('should store the transaction id under a prefixed key with the transaction expiry', async () => {
    const store = createInMemoryNonceStore();

    const nonce = await issueGoogleLoginNonce({
      transactionId: 'txn-1',
      expiresAt: now.getTime() + 600_000,
      store,
      now,
    });

    expect([...store.records.entries()]).toEqual([
      [`google_login_nonce:${nonce}`, { transactionId: 'txn-1', expiresAt: now.getTime() + 600_000 }],
    ]);
  });

  it('should derive the ttl from the remaining lifetime rounded up to whole seconds', async () => {
    const store = createInMemoryNonceStore();

    const nonce = await issueGoogleLoginNonce({
      transactionId: 'txn-1',
      expiresAt: now.getTime() + 90_500,
      store,
      now,
    });

    expect(store.ttls.get(`google_login_nonce:${nonce}`)).toBe(91);
  });

  it('should keep at least one second of ttl for a transaction about to expire', async () => {
    const store = createInMemoryNonceStore();

    const nonce = await issueGoogleLoginNonce({
      transactionId: 'txn-1',
      expiresAt: now.getTime(),
      store,
      now,
    });

    expect(store.ttls.get(`google_login_nonce:${nonce}`)).toBe(1);
  });

  it('should issue a different nonce each time', async () => {
    const store = createInMemoryNonceStore();
    const options = { transactionId: 'txn-1', expiresAt: now.getTime() + 600_000, store };

    const first = await issueGoogleLoginNonce(options);
    const second = await issueGoogleLoginNonce(options);

    expect(first).not.toBe(second);
    expect(store.records.size).toBe(2);
  });
});

describe('consumeGoogleLoginNonce', () => {
  it('should return the record and delete it', async () => {
    const store = createInMemoryNonceStore();
    const nonce = await issueGoogleLoginNonce({
      transactionId: 'txn-1',
      expiresAt: now.getTime() + 600_000,
      store,
      now,
    });

    const record = await consumeGoogleLoginNonce(nonce, store, now);

    expect(record).toEqual({ transactionId: 'txn-1', expiresAt: now.getTime() + 600_000 });
    expect(store.records.size).toBe(0);
  });

  it('should reject an unknown nonce', async () => {
    const error = await captureRejection(consumeGoogleLoginNonce('unknown', createInMemoryNonceStore(), now));

    expectGoogleLoginError(error, GoogleLoginErrorCode.LoginNonceNotFound, 400);
  });

  it('should reject a second use of the same nonce', async () => {
    const store = createInMemoryNonceStore();
    const nonce = await issueGoogleLoginNonce({
      transactionId: 'txn-1',
      expiresAt: now.getTime() + 600_000,
      store,
      now,
    });
    await consumeGoogleLoginNonce(nonce, store, now);

    const error = await captureRejection(consumeGoogleLoginNonce(nonce, store, now));

    expectGoogleLoginError(error, GoogleLoginErrorCode.LoginNonceNotFound, 400);
  });

  it('should reject and delete an expired record', async () => {
    const store = createInMemoryNonceStore();
    const nonce = await issueGoogleLoginNonce({
      transactionId: 'txn-1',
      expiresAt: now.getTime() + 1_000,
      store,
      now,
    });

    const error = await captureRejection(
      consumeGoogleLoginNonce(nonce, store, new Date(now.getTime() + 1_000)),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.LoginNonceExpired, 400);
    expect(store.records.size).toBe(0);
  });

  it('should use the current time when now is omitted', async () => {
    const store = createInMemoryNonceStore();
    const nonce = await issueGoogleLoginNonce({
      transactionId: 'txn-1',
      expiresAt: Date.now() + 600_000,
      store,
    });

    expect((await consumeGoogleLoginNonce(nonce, store)).transactionId).toBe('txn-1');
  });
});
