import { describe, expect, it } from 'vitest';
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  findPendingRecordByUserCode,
  issueVerificationBinding,
  recordDeviceLoginFailure,
  validateVerificationBinding,
  validateVerificationCsrfToken,
} from './verification.js';
import { DeviceAuthorizationError, DeviceVerificationError } from './errors.js';
import { NOW, createInMemoryDeviceAuthorizationStore, makeRecord } from './test-helpers.js';

describe('findPendingRecordByUserCode', () => {
  it('should find a pending record by its normalized user_code', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord();
    await store.save(record);

    expect(await findPendingRecordByUserCode('WDJBMJHT', store, NOW)).toEqual(record);
  });

  it('should accept the display form with its hyphen', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord();
    await store.save(record);

    expect(await findPendingRecordByUserCode('WDJB-MJHT', store, NOW)).toEqual(record);
  });

  it('should accept a lower-case code with surrounding spaces', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord();
    await store.save(record);

    expect(await findPendingRecordByUserCode(' wdjb-mjht ', store, NOW)).toEqual(record);
  });

  it('should return null for an unknown code', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    await store.save(makeRecord());

    expect(await findPendingRecordByUserCode('BCDFGHJK', store, NOW)).toBe(null);
  });

  it('should return null for an empty input', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    await store.save(makeRecord());

    expect(await findPendingRecordByUserCode('', store, NOW)).toBe(null);
  });

  it('should return null for an expired record', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    await store.save(makeRecord({ expiresAt: new Date(NOW.getTime() - 1) }));

    expect(await findPendingRecordByUserCode('WDJBMJHT', store, NOW)).toBe(null);
  });

  it('should return null exactly at the expiry instant', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    await store.save(makeRecord({ expiresAt: NOW }));

    expect(await findPendingRecordByUserCode('WDJBMJHT', store, NOW)).toBe(null);
  });

  it('should return null for an already approved record', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    await store.save(makeRecord({ status: 'approved' }));

    expect(await findPendingRecordByUserCode('WDJBMJHT', store, NOW)).toBe(null);
  });

  it('should return null for an already denied record', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    await store.save(makeRecord({ status: 'denied' }));

    expect(await findPendingRecordByUserCode('WDJBMJHT', store, NOW)).toBe(null);
  });
});

describe('issueVerificationBinding', () => {
  it('should persist the binding hash and the csrf token together', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord();
    await store.save(record);

    const { csrfToken } = await issueVerificationBinding(record, store);
    const stored = await store.findByDeviceCode(record.deviceCode);

    expect([stored?.bindingHash === null, stored?.csrfToken]).toEqual([false, csrfToken]);
  });

  it('should never store the raw binding secret on the record', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord();
    await store.save(record);

    const { bindingSecret } = await issueVerificationBinding(record, store);
    const stored = await store.findByDeviceCode(record.deviceCode);

    expect(stored?.bindingHash === bindingSecret).toBe(false);
  });

  it('should rotate both the binding secret and the csrf token on re-issue', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord();
    await store.save(record);

    const first = await issueVerificationBinding(record, store);
    const second = await issueVerificationBinding(record, store);

    expect([
      first.bindingSecret === second.bindingSecret,
      first.csrfToken === second.csrfToken,
    ]).toEqual([false, false]);
  });
});

describe('validateVerificationBinding', () => {
  it('should accept the binding secret that was just issued', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord();
    await store.save(record);
    const { bindingSecret } = await issueVerificationBinding(record, store);

    await expect(validateVerificationBinding(record, bindingSecret)).resolves.toBeUndefined();
  });

  it('should reject a missing cookie with 403', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord();
    await store.save(record);
    await issueVerificationBinding(record, store);

    await expect(validateVerificationBinding(record, null)).rejects.toThrowError(
      new DeviceVerificationError('Device verification binding is missing', 403),
    );
  });

  it('should reject a record that never issued a binding', async () => {
    const record = makeRecord();

    await expect(validateVerificationBinding(record, 'anything')).rejects.toThrowError(
      new DeviceVerificationError('Device verification binding is missing', 403),
    );
  });

  it('should reject a binding secret that does not match the stored hash', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord();
    await store.save(record);
    await issueVerificationBinding(record, store);

    await expect(validateVerificationBinding(record, 'wrong-secret')).rejects.toThrowError(
      new DeviceVerificationError('Device verification binding is invalid', 403),
    );
  });

  it('should reject the binding secret issued before a rotation', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord();
    await store.save(record);
    const stale = await issueVerificationBinding(record, store);
    await issueVerificationBinding(record, store);

    await expect(validateVerificationBinding(record, stale.bindingSecret)).rejects.toThrowError(
      new DeviceVerificationError('Device verification binding is invalid', 403),
    );
  });

  it('should report 403 as the status code for a binding failure', async () => {
    const record = makeRecord();

    const error = await validateVerificationBinding(record, null).catch(
      (caught: DeviceVerificationError) => caught,
    );

    expect(error.statusCode).toBe(403);
  });
});

describe('validateVerificationCsrfToken', () => {
  it('should accept the stored csrf token', () => {
    const record = makeRecord({ csrfToken: 'csrf-value' });

    expect(() => validateVerificationCsrfToken(record, 'csrf-value')).not.toThrow();
  });

  it('should reject a different csrf token with 403', () => {
    const record = makeRecord({ csrfToken: 'csrf-value' });

    expect(() => validateVerificationCsrfToken(record, 'other')).toThrowError(
      new DeviceVerificationError('CSRF token mismatch', 403),
    );
  });

  it('should reject an empty csrf token', () => {
    const record = makeRecord({ csrfToken: 'csrf-value' });

    expect(() => validateVerificationCsrfToken(record, '')).toThrowError(DeviceVerificationError);
  });

  it('should reject when the record has no csrf token yet', () => {
    const record = makeRecord({ csrfToken: null });

    expect(() => validateVerificationCsrfToken(record, '')).toThrowError(DeviceVerificationError);
  });
});

describe('recordDeviceLoginFailure', () => {
  it('should increment the attempt counter and allow a retry below the limit', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord();
    await store.save(record);

    const result = await recordDeviceLoginFailure(record, store, 5);

    expect(result).toEqual({ canRetry: true, remainingAttempts: 4 });
  });

  it('should keep the record pending while retries remain', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord();
    await store.save(record);

    await recordDeviceLoginFailure(record, store, 5);

    expect((await store.findByDeviceCode(record.deviceCode))?.status).toBe('pending');
  });

  it('should refuse a retry once the attempt limit is reached', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord({ loginAttempts: 4 });
    await store.save(record);

    const result = await recordDeviceLoginFailure(record, store, 5);

    expect(result).toEqual({ canRetry: false, remainingAttempts: 0 });
  });

  it('should move the record to denied when the attempt limit is exceeded', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord({ loginAttempts: 4 });
    await store.save(record);

    await recordDeviceLoginFailure(record, store, 5);

    expect((await store.findByDeviceCode(record.deviceCode))?.status).toBe('denied');
  });
});

describe('approveDeviceAuthorization', () => {
  it('should move the record to approved with the full grant context', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord({ csrfToken: 'csrf-value', scope: ['openid', 'profile'] });
    await store.save(record);

    const approved = await approveDeviceAuthorization({
      record,
      store,
      csrfToken: 'csrf-value',
      subject: 'user-1',
      authTime: 1_800_000_000,
    });

    expect(approved).toMatchObject({
      status: 'approved',
      subject: 'user-1',
      authTime: 1_800_000_000,
      approvedScope: ['openid', 'profile'],
    });
  });

  it('should mint a grantId so revocation can kill the grant', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord({ csrfToken: 'csrf-value' });
    await store.save(record);

    const approved = await approveDeviceAuthorization({
      record,
      store,
      csrfToken: 'csrf-value',
      subject: 'user-1',
      authTime: 1_800_000_000,
    });

    expect(approved.grantId).toHaveLength(43);
  });

  it('should clear the binding hash and csrf token after approval', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord({ csrfToken: 'csrf-value', bindingHash: 'hash' });
    await store.save(record);

    const approved = await approveDeviceAuthorization({
      record,
      store,
      csrfToken: 'csrf-value',
      subject: 'user-1',
      authTime: 1_800_000_000,
    });

    expect([approved.bindingHash, approved.csrfToken]).toEqual([null, null]);
  });

  it('should persist the approved record through the store', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord({ csrfToken: 'csrf-value' });
    await store.save(record);

    await approveDeviceAuthorization({
      record,
      store,
      csrfToken: 'csrf-value',
      subject: 'user-1',
      authTime: 1_800_000_000,
    });

    expect((await store.findByDeviceCode(record.deviceCode))?.status).toBe('approved');
  });

  it('should reject an approval whose csrf token does not match', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord({ csrfToken: 'csrf-value' });
    await store.save(record);

    await expect(
      approveDeviceAuthorization({
        record,
        store,
        csrfToken: 'wrong',
        subject: 'user-1',
        authTime: 1_800_000_000,
      }),
    ).rejects.toThrowError(DeviceVerificationError);
  });

  it('should leave the record pending when the csrf check fails', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord({ csrfToken: 'csrf-value' });
    await store.save(record);

    await approveDeviceAuthorization({
      record,
      store,
      csrfToken: 'wrong',
      subject: 'user-1',
      authTime: 1_800_000_000,
    }).catch(() => undefined);

    expect((await store.findByDeviceCode(record.deviceCode))?.status).toBe('pending');
  });

  it('should refuse to approve a record that was already denied', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord({ csrfToken: 'csrf-value', status: 'denied' });
    await store.save(record);

    await expect(
      approveDeviceAuthorization({
        record,
        store,
        csrfToken: 'csrf-value',
        subject: 'user-1',
        authTime: 1_800_000_000,
      }),
    ).rejects.toThrowError(DeviceAuthorizationError);
  });
});

describe('denyDeviceAuthorization', () => {
  it('should move the record to denied', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord({ csrfToken: 'csrf-value' });
    await store.save(record);

    const denied = await denyDeviceAuthorization({ record, store, csrfToken: 'csrf-value' });

    expect(denied.status).toBe('denied');
  });

  it('should not record a subject when the user denies', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord({ csrfToken: 'csrf-value' });
    await store.save(record);

    const denied = await denyDeviceAuthorization({ record, store, csrfToken: 'csrf-value' });

    expect(denied.subject).toBeUndefined();
  });

  it('should reject a denial whose csrf token does not match', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord({ csrfToken: 'csrf-value' });
    await store.save(record);

    await expect(
      denyDeviceAuthorization({ record, store, csrfToken: 'wrong' }),
    ).rejects.toThrowError(DeviceVerificationError);
  });

  it('should refuse to deny a record that was already approved', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const record = makeRecord({ csrfToken: 'csrf-value', status: 'approved' });
    await store.save(record);

    await expect(
      denyDeviceAuthorization({ record, store, csrfToken: 'csrf-value' }),
    ).rejects.toThrowError(DeviceAuthorizationError);
  });
});
