import { createInMemoryRarDetailsStore, type AuthorizationDetailTypeDefinition } from '@maronn-openid-connect/experimental/rar';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { describeTransactionAuthorizationDetails } from './describe-authorization-details.js';

const DETAILS = [{ type: 'payment_initiation', actions: ['initiate'], instructedAmount: { currency: 'EUR', amount: '123.50' } }];

const PAYMENT_TYPE: AuthorizationDetailTypeDefinition = {
  type: 'payment_initiation',
  validate(): void {},
  describe(detail): readonly string[] {
    const amount = detail['instructedAmount'] as { currency: string; amount: string };
    return [`Initiate a payment of ${amount.currency} ${amount.amount}`];
  },
};

describe('describeTransactionAuthorizationDetails', () => {
  it('should return the display lines of the stored details', async () => {
    const rarTransactionStore = createInMemoryRarDetailsStore();
    await rarTransactionStore.set('txn-1', DETAILS);
    const c = contextOf(undefined, { rarTransactionStore, config: { rarTypes: [PAYMENT_TYPE] } });

    expect(await describeTransactionAuthorizationDetails(c, 'txn-1')).toEqual([
      'Initiate a payment of EUR 123.50',
    ]);
  });

  it('should return undefined for a transaction without details', async () => {
    const c = contextOf(undefined, {
      rarTransactionStore: createInMemoryRarDetailsStore(),
      config: { rarTypes: [PAYMENT_TYPE] },
    });

    expect(await describeTransactionAuthorizationDetails(c, 'txn-1')).toBe(undefined);
  });

  it('should throw when the stored details name a type the config no longer defines', async () => {
    // 表示できない要素を黙って落とすと、見ていない権限が承認されてしまう。
    const rarTransactionStore = createInMemoryRarDetailsStore();
    await rarTransactionStore.set('txn-1', DETAILS);
    const c = contextOf(undefined, { rarTransactionStore, config: { rarTypes: [] } });

    await expect(describeTransactionAuthorizationDetails(c, 'txn-1')).rejects.toThrow(
      'authorization_details contains an unsupported type',
    );
  });
});
