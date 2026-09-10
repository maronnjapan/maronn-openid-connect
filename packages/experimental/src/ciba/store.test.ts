import { describe, expect, it } from 'vitest';
import {
  createInMemoryCibaAuthenticationRequestStore,
  createInMemoryCibaLoginTransactionStore,
} from './store.js';
import { makeRecord } from './test-helpers.js';

describe('createInMemoryCibaAuthenticationRequestStore', () => {
  it('should find a saved record by auth_req_id', async () => {
    const store = createInMemoryCibaAuthenticationRequestStore();
    await store.save(makeRecord({ expiresAt: future() }));

    expect((await store.findByAuthReqId('auth-req-id-value'))?.clientId).toBe('ciba-client');
  });

  it('should return null for an unknown auth_req_id', async () => {
    const store = createInMemoryCibaAuthenticationRequestStore();

    expect(await store.findByAuthReqId('unknown')).toBe(null);
  });

  describe('consume (single use, CIBA Section 11)', () => {
    it('should return the record exactly once', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ expiresAt: future() }));

      const first = await store.consume('auth-req-id-value');
      const second = await store.consume('auth-req-id-value');

      expect(first?.authReqId).toBe('auth-req-id-value');
      expect(second).toBe(null);
    });

    it('should hand the record to only one concurrent consumer', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ expiresAt: future() }));

      const results = await Promise.all([
        store.consume('auth-req-id-value'),
        store.consume('auth-req-id-value'),
        store.consume('auth-req-id-value'),
      ]);

      expect(results.filter((record) => record !== null).length).toBe(1);
    });
  });

  describe('listPendingBySubject', () => {
    it('should exclude records that are decided or expired', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ authReqId: 'live', expiresAt: future() }));
      await store.save(makeRecord({ authReqId: 'approved', status: 'approved', expiresAt: future() }));
      await store.save(makeRecord({
        authReqId: 'expired',
        expiresAt: new Date(Date.now() - 1_000),
      }));

      const pending = await store.listPendingBySubject('testuser');

      expect(pending.map((record) => record.authReqId)).toEqual(['live']);
    });
  });
});

describe('createInMemoryCibaLoginTransactionStore', () => {
  it('should save, find, update and delete a transaction', async () => {
    const store = createInMemoryCibaLoginTransactionStore();
    const record = {
      id: 'txn-1',
      csrfToken: 'csrf',
      bindingHash: 'hash',
      loginAttempts: 0,
      expiresAt: future(),
    };
    await store.save(record);
    expect((await store.findById('txn-1'))?.csrfToken).toBe('csrf');

    record.loginAttempts = 2;
    await store.update(record);
    expect((await store.findById('txn-1'))?.loginAttempts).toBe(2);

    await store.delete('txn-1');
    expect(await store.findById('txn-1')).toBe(null);
  });
});

function future(): Date {
  return new Date(Date.now() + 120_000);
}
