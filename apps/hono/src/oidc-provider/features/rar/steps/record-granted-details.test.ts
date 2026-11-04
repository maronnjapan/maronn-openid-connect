import type { AuthorizationCodeData } from '@maronn-openid-connect/core';
import { createInMemoryRarDetailsStore } from '@maronn-openid-connect/experimental/rar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { recordAuthorizationDetails } from './record-authorization-details.js';
import { recordGrantedAuthorizationDetails } from './record-granted-details.js';

const DETAILS = [{ type: 'payment_initiation', actions: ['initiate'] }];

const AUTH_CODE = { code: 'code-1', grantId: 'grant-1' } as AuthorizationCodeData;

function storesContext() {
  const rarTransactionStore = createInMemoryRarDetailsStore();
  const rarGrantStore = createInMemoryRarDetailsStore();
  const c = contextOf(undefined, {
    rarTransactionStore,
    rarGrantStore,
    config: { refreshTokenAbsoluteLifetime: 7776000 },
  });
  return { c, rarTransactionStore, rarGrantStore };
}

describe('recordAuthorizationDetails', () => {
  it('should store the details under the transaction id', async () => {
    const { c, rarTransactionStore } = storesContext();
    await recordAuthorizationDetails(c, { transactionId: 'txn-1', transactionTtlSeconds: 600, authorizationDetails: DETAILS });
    expect(await rarTransactionStore.get('txn-1')).toEqual(DETAILS);
  });

  it('should store nothing for a request without details', async () => {
    const { c, rarTransactionStore } = storesContext();
    await recordAuthorizationDetails(c, { transactionId: 'txn-1', transactionTtlSeconds: 600, authorizationDetails: undefined });
    expect(await rarTransactionStore.get('txn-1')).toBe(undefined);
  });

  it('should expire the entry with the transaction ttl', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T00:00:00Z'));
    try {
      const { c, rarTransactionStore } = storesContext();
      await recordAuthorizationDetails(c, { transactionId: 'txn-1', transactionTtlSeconds: 600, authorizationDetails: DETAILS });
      vi.advanceTimersByTime(600 * 1000);
      expect(await rarTransactionStore.get('txn-1')).toBe(undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('recordGrantedAuthorizationDetails', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should move the details from the transaction key to the grant key', async () => {
    const { c, rarTransactionStore, rarGrantStore } = storesContext();
    await rarTransactionStore.set('txn-1', DETAILS);

    await recordGrantedAuthorizationDetails(c, 'txn-1', AUTH_CODE);

    expect(await rarGrantStore.get('grant-1')).toEqual(DETAILS);
    expect(await rarTransactionStore.get('txn-1')).toBe(undefined);
  });

  it('should do nothing for a transaction without details', async () => {
    const { c, rarGrantStore } = storesContext();
    await recordGrantedAuthorizationDetails(c, 'txn-1', AUTH_CODE);
    expect(await rarGrantStore.get('grant-1')).toBe(undefined);
  });

  it('should keep the grant entry alive for the refresh token absolute lifetime', async () => {
    const { c, rarTransactionStore, rarGrantStore } = storesContext();
    await rarTransactionStore.set('txn-1', DETAILS);
    await recordGrantedAuthorizationDetails(c, 'txn-1', AUTH_CODE);

    vi.advanceTimersByTime(7776000 * 1000 - 1);
    expect(await rarGrantStore.get('grant-1')).toEqual(DETAILS);
    vi.advanceTimersByTime(1);
    expect(await rarGrantStore.get('grant-1')).toBe(undefined);
  });
});
