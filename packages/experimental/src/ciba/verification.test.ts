import { describe, expect, it } from 'vitest';
import { CibaVerificationError } from './errors.js';
import {
  approveCibaRequest,
  createCibaLoginTransaction,
  denyCibaRequest,
  listPendingCibaRequests,
  recordCibaLoginFailure,
  validateCibaLoginSubmission,
} from './verification.js';
import {
  createInMemoryCibaAuthenticationRequestStore,
  createInMemoryCibaLoginTransactionStore,
} from './store.js';
import { makeRecord } from './test-helpers.js';

async function expectVerificationError(action: () => Promise<unknown>): Promise<CibaVerificationError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(CibaVerificationError);
    return error as CibaVerificationError;
  }
  throw new Error('expected a CibaVerificationError');
}

describe('createCibaLoginTransaction', () => {
  it('should mint a 256-bit id, csrf token and binding secret', async () => {
    const store = createInMemoryCibaLoginTransactionStore();
    const { record, bindingSecret } = await createCibaLoginTransaction(store);

    expect(record.id.length).toBe(43);
    expect(record.csrfToken.length).toBe(43);
    expect(bindingSecret.length).toBe(43);
  });

  it('should save the transaction with a 600 second lifetime and zero attempts', async () => {
    const store = createInMemoryCibaLoginTransactionStore();
    const before = Date.now();
    const { record } = await createCibaLoginTransaction(store);
    const saved = await store.findById(record.id);

    expect(saved?.loginAttempts).toBe(0);
    const lifetimeMs = (saved?.expiresAt.getTime() ?? 0) - before;
    expect(lifetimeMs >= 600_000 && lifetimeMs <= 601_000).toBe(true);
  });

  it('should store only the SHA-256 hash of the binding secret', async () => {
    const store = createInMemoryCibaLoginTransactionStore();
    const { record, bindingSecret } = await createCibaLoginTransaction(store);

    expect(record.bindingHash === bindingSecret).toBe(false);
    expect(record.bindingHash.length).toBe(43);
  });
});

describe('validateCibaLoginSubmission', () => {
  async function setup() {
    const store = createInMemoryCibaLoginTransactionStore();
    const { record, bindingSecret } = await createCibaLoginTransaction(store);
    return { store, record, bindingSecret };
  }

  it('should return the transaction when binding and csrf both match', async () => {
    const { store, record, bindingSecret } = await setup();

    const validated = await validateCibaLoginSubmission({
      transactionId: record.id,
      csrfToken: record.csrfToken,
      bindingSecret,
      store,
    });

    expect(validated.id).toBe(record.id);
  });

  it('should reject an unknown transaction id with 403', async () => {
    const { store, record, bindingSecret } = await setup();

    const error = await expectVerificationError(() =>
      validateCibaLoginSubmission({
        transactionId: 'unknown',
        csrfToken: record.csrfToken,
        bindingSecret,
        store,
      }),
    );

    expect(error.statusCode).toBe(403);
  });

  it('should reject an expired transaction with 403', async () => {
    const store = createInMemoryCibaLoginTransactionStore();
    const { record, bindingSecret } = await createCibaLoginTransaction(store);
    record.expiresAt = new Date(Date.now() - 1_000);
    await store.update(record);

    const error = await expectVerificationError(() =>
      validateCibaLoginSubmission({
        transactionId: record.id,
        csrfToken: record.csrfToken,
        bindingSecret,
        store,
      }),
    );

    expect(error.statusCode).toBe(403);
  });

  it('should reject a missing binding secret with 403', async () => {
    const { store, record } = await setup();

    const error = await expectVerificationError(() =>
      validateCibaLoginSubmission({
        transactionId: record.id,
        csrfToken: record.csrfToken,
        bindingSecret: null,
        store,
      }),
    );

    expect(error.statusCode).toBe(403);
  });

  it('should reject a wrong binding secret with 403', async () => {
    const { store, record } = await setup();

    const error = await expectVerificationError(() =>
      validateCibaLoginSubmission({
        transactionId: record.id,
        csrfToken: record.csrfToken,
        bindingSecret: 'forged-secret',
        store,
      }),
    );

    expect(error.statusCode).toBe(403);
  });

  it('should reject a wrong csrf token with 403', async () => {
    const { store, record, bindingSecret } = await setup();

    const error = await expectVerificationError(() =>
      validateCibaLoginSubmission({
        transactionId: record.id,
        csrfToken: 'forged',
        bindingSecret,
        store,
      }),
    );

    expect(error.statusCode).toBe(403);
  });

  it('should use the same message for every failure reason', async () => {
    const { store, record, bindingSecret } = await setup();

    const unknown = await expectVerificationError(() =>
      validateCibaLoginSubmission({
        transactionId: 'unknown',
        csrfToken: record.csrfToken,
        bindingSecret,
        store,
      }),
    );
    const forgedBinding = await expectVerificationError(() =>
      validateCibaLoginSubmission({
        transactionId: record.id,
        csrfToken: record.csrfToken,
        bindingSecret: 'forged',
        store,
      }),
    );
    const forgedCsrf = await expectVerificationError(() =>
      validateCibaLoginSubmission({
        transactionId: record.id,
        csrfToken: 'forged',
        bindingSecret,
        store,
      }),
    );

    expect(unknown.message).toBe(forgedBinding.message);
    expect(forgedBinding.message).toBe(forgedCsrf.message);
  });
});

describe('recordCibaLoginFailure', () => {
  it('should count a failure and allow retrying below the limit', async () => {
    const store = createInMemoryCibaLoginTransactionStore();
    const { record } = await createCibaLoginTransaction(store);

    const result = await recordCibaLoginFailure(record, store, 5);

    expect(result).toEqual({ canRetry: true, remainingAttempts: 4 });
    expect((await store.findById(record.id))?.loginAttempts).toBe(1);
  });

  it('should delete the transaction when the limit is reached', async () => {
    const store = createInMemoryCibaLoginTransactionStore();
    const { record } = await createCibaLoginTransaction(store);

    let result = { canRetry: true, remainingAttempts: 0 };
    for (let i = 0; i < 5; i++) {
      result = await recordCibaLoginFailure(record, store, 5);
    }

    expect(result).toEqual({ canRetry: false, remainingAttempts: 0 });
    expect(await store.findById(record.id)).toBe(null);
  });
});

describe('listPendingCibaRequests', () => {
  it('should return only pending requests of the given subject', async () => {
    const store = createInMemoryCibaAuthenticationRequestStore();
    await store.save(makeRecord({ authReqId: 'mine', subject: 'testuser', expiresAt: future() }));
    await store.save(makeRecord({ authReqId: 'other', subject: 'otheruser', expiresAt: future() }));
    await store.save(makeRecord({
      authReqId: 'mine-denied',
      subject: 'testuser',
      status: 'denied',
      expiresAt: future(),
    }));

    const listed = await listPendingCibaRequests({ subject: 'testuser', store });

    expect(listed.map((record) => record.authReqId)).toEqual(['mine']);
  });

  it('should mint and persist a csrf token for every listed record', async () => {
    const store = createInMemoryCibaAuthenticationRequestStore();
    await store.save(makeRecord({ authReqId: 'mine', expiresAt: future() }));

    const [listed] = await listPendingCibaRequests({ subject: 'testuser', store });
    const persisted = await store.findByAuthReqId('mine');

    expect(typeof listed?.csrfToken).toBe('string');
    expect(persisted?.csrfToken).toBe(listed?.csrfToken ?? null);
  });

  it('should rotate the csrf token on every listing', async () => {
    const store = createInMemoryCibaAuthenticationRequestStore();
    await store.save(makeRecord({ authReqId: 'mine', expiresAt: future() }));

    // 文字列を先に取り出す: インメモリストアは同一オブジェクトを返すため、
    // 参照のまま比較すると 2 回目の回転が 1 回目の値も上書きしてしまう。
    const first = (await listPendingCibaRequests({ subject: 'testuser', store }))[0]?.csrfToken;
    const second = (await listPendingCibaRequests({ subject: 'testuser', store }))[0]?.csrfToken;

    expect(first === second).toBe(false);
  });
});

describe('approveCibaRequest', () => {
  async function setupPending() {
    const store = createInMemoryCibaAuthenticationRequestStore();
    await store.save(makeRecord({ authReqId: 'mine', expiresAt: future() }));
    const [listed] = await listPendingCibaRequests({ subject: 'testuser', store });
    return { store, csrfToken: listed?.csrfToken ?? '' };
  }

  it('should move the record to approved with authTime, scope and grantId', async () => {
    const { store, csrfToken } = await setupPending();

    const approved = await approveCibaRequest({
      authReqId: 'mine',
      subject: 'testuser',
      csrfToken,
      authTime: 1_760_000_000,
      grantId: 'grant-1',
      store,
    });

    expect(approved).toMatchObject({
      status: 'approved',
      authTime: 1_760_000_000,
      approvedScope: ['openid'],
      grantId: 'grant-1',
      csrfToken: null,
    });
    expect((await store.findByAuthReqId('mine'))?.status).toBe('approved');
  });

  it('should reject an unknown auth_req_id with 403', async () => {
    const { store, csrfToken } = await setupPending();

    const error = await expectVerificationError(() =>
      approveCibaRequest({
        authReqId: 'unknown',
        subject: 'testuser',
        csrfToken,
        authTime: 1,
        grantId: 'g',
        store,
      }),
    );

    expect(error.statusCode).toBe(403);
  });

  it('should reject a session subject that does not own the record', async () => {
    const { store, csrfToken } = await setupPending();

    const error = await expectVerificationError(() =>
      approveCibaRequest({
        authReqId: 'mine',
        subject: 'otheruser',
        csrfToken,
        authTime: 1,
        grantId: 'g',
        store,
      }),
    );

    expect(error.statusCode).toBe(403);
    expect((await store.findByAuthReqId('mine'))?.status).toBe('pending');
  });

  it('should reject a wrong csrf token with 403', async () => {
    const { store } = await setupPending();

    const error = await expectVerificationError(() =>
      approveCibaRequest({
        authReqId: 'mine',
        subject: 'testuser',
        csrfToken: 'forged',
        authTime: 1,
        grantId: 'g',
        store,
      }),
    );

    expect(error.statusCode).toBe(403);
  });

  it('should reject a record whose csrf token was never issued', async () => {
    const store = createInMemoryCibaAuthenticationRequestStore();
    await store.save(makeRecord({ authReqId: 'mine', expiresAt: future() }));

    const error = await expectVerificationError(() =>
      approveCibaRequest({
        authReqId: 'mine',
        subject: 'testuser',
        csrfToken: '',
        authTime: 1,
        grantId: 'g',
        store,
      }),
    );

    expect(error.statusCode).toBe(403);
  });

  it('should reject an expired record with 403', async () => {
    const store = createInMemoryCibaAuthenticationRequestStore();
    await store.save(makeRecord({
      authReqId: 'mine',
      csrfToken: 'csrf',
      expiresAt: new Date(Date.now() - 1_000),
    }));

    const error = await expectVerificationError(() =>
      approveCibaRequest({
        authReqId: 'mine',
        subject: 'testuser',
        csrfToken: 'csrf',
        authTime: 1,
        grantId: 'g',
        store,
      }),
    );

    expect(error.statusCode).toBe(403);
  });

  it('should reject a record that was already decided', async () => {
    const store = createInMemoryCibaAuthenticationRequestStore();
    await store.save(makeRecord({
      authReqId: 'mine',
      status: 'denied',
      csrfToken: 'csrf',
      expiresAt: future(),
    }));

    const error = await expectVerificationError(() =>
      approveCibaRequest({
        authReqId: 'mine',
        subject: 'testuser',
        csrfToken: 'csrf',
        authTime: 1,
        grantId: 'g',
        store,
      }),
    );

    expect(error.statusCode).toBe(403);
  });

  it('should use one message for unknown, mismatched and decided records', async () => {
    const { store, csrfToken } = await setupPending();

    const unknown = await expectVerificationError(() =>
      approveCibaRequest({
        authReqId: 'unknown',
        subject: 'testuser',
        csrfToken,
        authTime: 1,
        grantId: 'g',
        store,
      }),
    );
    const wrongSubject = await expectVerificationError(() =>
      approveCibaRequest({
        authReqId: 'mine',
        subject: 'otheruser',
        csrfToken,
        authTime: 1,
        grantId: 'g',
        store,
      }),
    );

    expect(unknown.message).toBe(wrongSubject.message);
  });
});

describe('denyCibaRequest', () => {
  it('should move the record to denied and clear the csrf token', async () => {
    const store = createInMemoryCibaAuthenticationRequestStore();
    await store.save(makeRecord({ authReqId: 'mine', expiresAt: future() }));
    const [listed] = await listPendingCibaRequests({ subject: 'testuser', store });

    await denyCibaRequest({
      authReqId: 'mine',
      subject: 'testuser',
      csrfToken: listed?.csrfToken ?? '',
      store,
    });

    expect(await store.findByAuthReqId('mine')).toMatchObject({
      status: 'denied',
      csrfToken: null,
    });
  });

  it('should reject a session subject that does not own the record', async () => {
    const store = createInMemoryCibaAuthenticationRequestStore();
    await store.save(makeRecord({ authReqId: 'mine', expiresAt: future() }));
    const [listed] = await listPendingCibaRequests({ subject: 'testuser', store });

    const error = await expectVerificationError(() =>
      denyCibaRequest({
        authReqId: 'mine',
        subject: 'otheruser',
        csrfToken: listed?.csrfToken ?? '',
        store,
      }),
    );

    expect(error.statusCode).toBe(403);
    expect((await store.findByAuthReqId('mine'))?.status).toBe('pending');
  });
});

function future(): Date {
  return new Date(Date.now() + 120_000);
}
