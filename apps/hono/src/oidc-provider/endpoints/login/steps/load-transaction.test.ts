import { describe, expect, it } from 'vitest';
import { providerContext, requestTo } from '../../../../test-support/context.js';
import {
  TRANSACTION_ID,
  sampleTransaction,
  storeTransaction,
  transactionCookie,
} from '../../../../test-support/screens.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { loadTransaction, loadTransactionById } from './load-transaction.js';

const NO_TRANSACTION_MESSAGE =
  'No authorization request is in progress in this browser. Start again from the application.';

function loginRequest(cookie?: string): Request {
  return requestTo('/login', cookie === undefined ? {} : { headers: { Cookie: cookie } });
}

describe('loadTransaction', () => {
  // OIDC Core 1.0 §3.1.2.3: the transaction cookie names the request this browser is in.
  it('should load the transaction the transaction cookie names', async () => {
    const db = createEmptyDatabase();
    const transaction = await storeTransaction(db);
    const { c } = await providerContext({ db, request: loginRequest(`theme=dark; ${transactionCookie()}`) });

    expect(await loadTransaction(c)).toEqual({ transactionId: TRANSACTION_ID, transaction });
  });

  it('should answer 400 when the browser has no transaction cookie', async () => {
    const { c } = await providerContext({ request: loginRequest() });

    expect(await loadTransaction(c)).toEqual({ kind: 'error', error: NO_TRANSACTION_MESSAGE, statusCode: 400 });
  });

  it('should answer 400 when the transaction of the cookie is not stored', async () => {
    const { c } = await providerContext({ request: loginRequest(transactionCookie('finished-txn')) });

    expect(await loadTransaction(c)).toEqual({
      kind: 'error',
      error: 'Auth transaction not found. The session may have expired.',
      statusCode: 400,
    });
  });

  it('should answer 400 for a stored transaction whose expiresAt has passed', async () => {
    const db = createEmptyDatabase();
    await storeTransaction(db, sampleTransaction({ expiresAt: Date.now() - 1000 }));
    const { c } = await providerContext({ db, request: loginRequest(transactionCookie()) });

    expect(await loadTransaction(c)).toEqual({
      kind: 'error',
      error: 'Auth transaction has expired. Please start the authorization flow again.',
      statusCode: 400,
    });
  });
});

describe('loadTransactionById', () => {
  it('should load the transaction stored under the id', async () => {
    const db = createEmptyDatabase();
    const transaction = await storeTransaction(db);
    const { c } = await providerContext({ db });

    expect(await loadTransactionById(c, TRANSACTION_ID)).toEqual({ transaction });
  });

  it('should rethrow a failure of the store that is not a transaction error', async () => {
    const { c } = await providerContext();
    c.set('transactionStore', {
      async get() {
        throw new Error('store unavailable');
      },
    });

    await expect(loadTransactionById(c, TRANSACTION_ID)).rejects.toThrow('store unavailable');
  });
});
