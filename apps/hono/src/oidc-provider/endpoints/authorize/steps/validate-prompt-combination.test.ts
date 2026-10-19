import { describe, expect, it } from 'vitest';
import {
  RECORDED_RESPONSE,
  recordingResponseMode,
  REDIRECT_URI,
  STATE,
  storeTransaction,
  TRANSACTION_ID,
  transactionOf,
} from '../../../../test-support/authorize.js';
import { providerContext, TEST_ISSUER } from '../../../../test-support/context.js';
import { rejectCombinedPromptNone } from './validate-prompt-combination.js';

describe('rejectCombinedPromptNone', () => {
  it.each([
    ['none alone', ['none']],
    ['values without none', ['login', 'consent']],
    ['no prompt', []],
  ])('should return undefined and keep the transaction for %s', async (_label, promptValues) => {
    const { c, db, stores } = await providerContext();
    const transaction = transactionOf();
    await storeTransaction(stores, transaction);

    expect(await rejectCombinedPromptNone(c, promptValues, TRANSACTION_ID, transaction, TEST_ISSUER, undefined)).toBeUndefined();
    expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(true);
  });

  // OIDC Core 1.0 §3.1.2.1: none MUST NOT be combined with any other value.
  it('should redirect invalid_request with the state and iss and drop the transaction when none is combined with login', async () => {
    const { c, db, stores } = await providerContext();
    const transaction = transactionOf();
    await storeTransaction(stores, transaction);

    const outcome = await rejectCombinedPromptNone(c, ['none', 'login'], TRANSACTION_ID, transaction, TEST_ISSUER, undefined);

    expect(outcome).toEqual({
      kind: 'authorization_response',
      response: {
        method: 'redirect',
        location:
          'https://rp.example.com/callback?error=invalid_request' +
          '&error_description=prompt%3Dnone+must+not+be+combined+with+other+prompt+values' +
          '&state=state-1&iss=https%3A%2F%2Fop.example.com',
      },
    });
    expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
  });

  it('should answer in the response mode the request asked for', async () => {
    const { c, stores } = await providerContext();
    const transaction = transactionOf();
    await storeTransaction(stores, transaction);
    const { responseMode, respond } = recordingResponseMode();

    const outcome = await rejectCombinedPromptNone(c, ['none', 'consent'], TRANSACTION_ID, transaction, TEST_ISSUER, responseMode);

    expect(outcome).toEqual({ kind: 'authorization_response', response: RECORDED_RESPONSE });
    expect(respond.mock.calls).toEqual([
      [
        REDIRECT_URI,
        { error: 'invalid_request', error_description: 'prompt=none must not be combined with other prompt values', state: STATE },
      ],
    ]);
  });
});
