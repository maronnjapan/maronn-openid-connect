import { describe, expect, it } from 'vitest';
import { providerContext, requestTo } from '../../../../test-support/context.js';
import {
  TRANSACTION_ID,
  sampleTransaction,
  storeTransaction,
  transactionCookie,
} from '../../../../test-support/screens.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { loadTransaction } from './load-transaction.js';

function consentRequest(cookie?: string): Request {
  return requestTo('/consent', cookie === undefined ? {} : { headers: { Cookie: cookie } });
}

describe('loadTransaction', () => {
  // OIDC Core 1.0 §3.1.2.4: the transaction cookie names the request this browser is in.
  it('should load the transaction the transaction cookie names', async () => {
    const db = createEmptyDatabase();
    const transaction = await storeTransaction(db);
    const { c } = await providerContext({ db, request: consentRequest(transactionCookie()) });

    expect(await loadTransaction(c)).toEqual({ transactionId: TRANSACTION_ID, transaction });
  });

  it('should answer 400 when the browser has no transaction cookie', async () => {
    const { c } = await providerContext({ request: consentRequest('session_id=sid-1') });

    expect(await loadTransaction(c)).toEqual({
      kind: 'error',
      error: 'No authorization request is in progress in this browser. Start again from the application.',
      statusCode: 400,
    });
  });

  it('should answer 400 for a transaction that is finished or expired', async () => {
    const db = createEmptyDatabase();
    await storeTransaction(db, sampleTransaction({ expiresAt: Date.now() - 1000 }));
    const { c } = await providerContext({ db, request: consentRequest(transactionCookie()) });

    expect(await loadTransaction(c)).toEqual({
      kind: 'error',
      error: 'Auth transaction has expired. Please start the authorization flow again.',
      statusCode: 400,
    });
  });

  it('should rethrow a failure of the store that is not a transaction error', async () => {
    const { c } = await providerContext({ request: consentRequest(transactionCookie()) });
    c.set('transactionStore', {
      async get() {
        throw new Error('store unavailable');
      },
    });

    await expect(loadTransaction(c)).rejects.toThrow('store unavailable');
  });
});
