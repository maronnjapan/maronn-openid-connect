import { describe, expect, it } from 'vitest';
import { pendingCibaRecord } from '../../../test-support/browser-flows.js';
import { cibaAuthenticationRequestStore, cibaLoginTransactionStore } from './store.js';

// The stores live on globalThis and are shared by every test, so each test uses ids of its own.
describe('cibaAuthenticationRequestStore', () => {
  it('should find a saved request by auth_req_id and list it as pending for its subject', async () => {
    const subject = 'user-' + crypto.randomUUID();
    const record = pendingCibaRecord({ subject });
    await cibaAuthenticationRequestStore.save(record);

    expect(await cibaAuthenticationRequestStore.findByAuthReqId(record.authReqId)).toBe(record);
    expect(await cibaAuthenticationRequestStore.listPendingBySubject(subject)).toEqual([record]);
  });

  // CIBA Core 1.0 §11: an auth_req_id is redeemed once.
  it('should return a request from consume once and null afterwards', async () => {
    const record = pendingCibaRecord({ status: 'approved' });
    await cibaAuthenticationRequestStore.save(record);

    expect(await cibaAuthenticationRequestStore.consume(record.authReqId)).toBe(record);
    expect(await cibaAuthenticationRequestStore.consume(record.authReqId)).toBeNull();
  });
});

describe('cibaLoginTransactionStore', () => {
  it('should find a saved login transaction by id until it is deleted', async () => {
    const transaction = {
      id: 'txn-' + crypto.randomUUID(),
      csrfToken: 'csrf-1',
      bindingHash: 'hash-1',
      loginAttempts: 0,
      expiresAt: new Date(Date.now() + 600_000),
    };
    await cibaLoginTransactionStore.save(transaction);

    expect(await cibaLoginTransactionStore.findById(transaction.id)).toBe(transaction);

    await cibaLoginTransactionStore.delete(transaction.id);
    expect(await cibaLoginTransactionStore.findById(transaction.id)).toBeNull();
  });
});
