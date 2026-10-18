import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { TRANSACTION_ID, sampleTransaction, storeTransaction } from '../../../../test-support/screens.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { recordLoginFailure } from './record-login-failure.js';

describe('recordLoginFailure', () => {
  it('should count the first failure and leave four attempts', async () => {
    const db = createEmptyDatabase();
    const transaction = await storeTransaction(db);
    const { c } = await providerContext({ db });

    expect(await recordLoginFailure(c, TRANSACTION_ID, transaction)).toEqual({ canRetry: true, remainingAttempts: 4 });
    expect(db.transactions.get('auth_txn:' + TRANSACTION_ID)?.value.failedAttempts).toBe(1);
  });

  it('should keep the transaction with the count while an attempt is left', async () => {
    const db = createEmptyDatabase();
    const transaction = await storeTransaction(db, sampleTransaction({ failedAttempts: 3 }));
    const { c } = await providerContext({ db });

    expect(await recordLoginFailure(c, TRANSACTION_ID, transaction)).toEqual({ canRetry: true, remainingAttempts: 1 });
    expect(db.transactions.get('auth_txn:' + TRANSACTION_ID)?.value.failedAttempts).toBe(4);
  });

  it('should delete the transaction at the fifth failure and accept no further attempt', async () => {
    const db = createEmptyDatabase();
    const transaction = await storeTransaction(db, sampleTransaction({ failedAttempts: 4 }));
    const { c } = await providerContext({ db });

    expect(await recordLoginFailure(c, TRANSACTION_ID, transaction)).toEqual({ canRetry: false, remainingAttempts: 0 });
    expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
  });
});
