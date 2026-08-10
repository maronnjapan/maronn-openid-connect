import { describe, expect, it } from 'vitest';
import {
  evaluateDeviceCodeState,
  processDeviceCodeGrant,
  resolveDeviceCodeRecord,
  validateDeviceCodeGrantAllowed,
  type DeviceCodeGrantClient,
} from './device-code-grant.js';
import { DeviceAuthorizationError } from './errors.js';
import { DEVICE_CODE_GRANT_TYPE } from './store.js';
import { NOW, createInMemoryDeviceAuthorizationStore, makeRecord } from './test-helpers.js';

const DEVICE_CLIENT: DeviceCodeGrantClient = {
  clientId: 'device-client',
  grantTypes: [DEVICE_CODE_GRANT_TYPE],
};

function approvedRecord(overrides = {}) {
  return makeRecord({
    status: 'approved',
    subject: 'user-1',
    authTime: 1_800_000_000,
    approvedScope: ['openid', 'profile'],
    grantId: 'grant-1',
    ...overrides,
  });
}

async function codeFor(record = makeRecord()) {
  const store = createInMemoryDeviceAuthorizationStore();
  await store.save(record);
  return { store, record };
}

describe('validateDeviceCodeGrantAllowed', () => {
  it('should accept a client registered for the device_code grant', () => {
    expect(() => validateDeviceCodeGrantAllowed(DEVICE_CLIENT)).not.toThrow();
  });

  it('should reject a client whose grantTypes omit the device_code URN', () => {
    expect(() =>
      validateDeviceCodeGrantAllowed({ clientId: 'web-app', grantTypes: ['authorization_code'] }),
    ).toThrowError(
      new DeviceAuthorizationError(
        'unauthorized_client',
        'The client is not authorized to use the device_code grant',
      ),
    );
  });
});

describe('resolveDeviceCodeRecord', () => {
  it('should resolve the record issued to this client', async () => {
    const { store, record } = await codeFor();

    expect(
      await resolveDeviceCodeRecord({ device_code: record.deviceCode }, DEVICE_CLIENT, store),
    ).toEqual(record);
  });

  it('should reject a missing device_code with invalid_request', async () => {
    const { store } = await codeFor();

    await expect(resolveDeviceCodeRecord({}, DEVICE_CLIENT, store)).rejects.toThrowError(
      new DeviceAuthorizationError('invalid_request', 'Missing required parameter: device_code'),
    );
  });

  it('should reject an empty device_code with invalid_request', async () => {
    const { store } = await codeFor();

    await expect(
      resolveDeviceCodeRecord({ device_code: '' }, DEVICE_CLIENT, store),
    ).rejects.toThrowError(DeviceAuthorizationError);
  });

  it('should reject an unknown device_code with invalid_grant', async () => {
    const { store } = await codeFor();

    await expect(
      resolveDeviceCodeRecord({ device_code: 'unknown' }, DEVICE_CLIENT, store),
    ).rejects.toThrowError(
      new DeviceAuthorizationError(
        'invalid_grant',
        'The device_code is invalid, expired, or was issued to another client',
      ),
    );
  });

  it('should reject a device_code issued to another client with the same wording', async () => {
    // RFC 8628 §3.4: device_code は発行先クライアントに紐づく。文言を不存在時と
    // 揃えることで、他クライアントのコードの実在性を漏らさない。
    const { store, record } = await codeFor();

    await expect(
      resolveDeviceCodeRecord(
        { device_code: record.deviceCode },
        { clientId: 'other-client', grantTypes: [DEVICE_CODE_GRANT_TYPE] },
        store,
      ),
    ).rejects.toThrowError(
      new DeviceAuthorizationError(
        'invalid_grant',
        'The device_code is invalid, expired, or was issued to another client',
      ),
    );
  });
});

describe('evaluateDeviceCodeState', () => {
  describe('expired_token (RFC 8628 §3.5)', () => {
    it('should return expired_token once the lifetime has passed', async () => {
      const { store, record } = await codeFor(
        makeRecord({ expiresAt: new Date(NOW.getTime() - 1) }),
      );

      await expect(evaluateDeviceCodeState(record, store, NOW)).rejects.toThrowError(
        new DeviceAuthorizationError(
          'expired_token',
          'The device_code has expired. Start a new device authorization request.',
        ),
      );
    });

    it('should return expired_token exactly at the expiry instant', async () => {
      const { store, record } = await codeFor(makeRecord({ expiresAt: NOW }));

      const error = await evaluateDeviceCodeState(record, store, NOW).catch(
        (caught: DeviceAuthorizationError) => caught,
      );

      expect(error.code).toBe('expired_token');
    });

    it('should delete the expired record', async () => {
      const { store, record } = await codeFor(makeRecord({ expiresAt: NOW }));

      await evaluateDeviceCodeState(record, store, NOW).catch(() => undefined);

      expect(await store.findByDeviceCode(record.deviceCode)).toBe(null);
    });

    it('should prefer expired_token over slow_down for an expired record', async () => {
      const { store, record } = await codeFor(
        makeRecord({ expiresAt: NOW, lastPolledAt: NOW }),
      );

      const error = await evaluateDeviceCodeState(record, store, NOW).catch(
        (caught: DeviceAuthorizationError) => caught,
      );

      expect(error.code).toBe('expired_token');
    });
  });

  describe('slow_down (RFC 8628 §3.5)', () => {
    it('should return slow_down when polled inside the interval', async () => {
      const { store, record } = await codeFor(
        makeRecord({ lastPolledAt: new Date(NOW.getTime() - 1_000) }),
      );

      const error = await evaluateDeviceCodeState(record, store, NOW).catch(
        (caught: DeviceAuthorizationError) => caught,
      );

      expect(error.code).toBe('slow_down');
    });

    it('should increase the stored interval by 5 seconds on slow_down', async () => {
      const { store, record } = await codeFor(
        makeRecord({ interval: 5, lastPolledAt: new Date(NOW.getTime() - 1_000) }),
      );

      await evaluateDeviceCodeState(record, store, NOW).catch(() => undefined);

      expect((await store.findByDeviceCode(record.deviceCode))?.interval).toBe(10);
    });

    it('should keep raising the interval on repeated slow_down responses', async () => {
      const { store, record } = await codeFor(
        makeRecord({ interval: 5, lastPolledAt: new Date(NOW.getTime() - 1_000) }),
      );

      await evaluateDeviceCodeState(record, store, NOW).catch(() => undefined);
      await evaluateDeviceCodeState(record, store, NOW).catch(() => undefined);

      expect((await store.findByDeviceCode(record.deviceCode))?.interval).toBe(15);
    });

    it('should not return slow_down exactly at the interval boundary', async () => {
      const { store, record } = await codeFor(
        makeRecord({ interval: 5, lastPolledAt: new Date(NOW.getTime() - 5_000) }),
      );

      const error = await evaluateDeviceCodeState(record, store, NOW).catch(
        (caught: DeviceAuthorizationError) => caught,
      );

      expect(error.code).toBe('authorization_pending');
    });
  });

  describe('authorization_pending (RFC 8628 §3.5)', () => {
    it('should return authorization_pending on the first poll', async () => {
      const { store, record } = await codeFor();

      await expect(evaluateDeviceCodeState(record, store, NOW)).rejects.toThrowError(
        new DeviceAuthorizationError(
          'authorization_pending',
          'The authorization request is still pending',
        ),
      );
    });

    it('should record the poll timestamp so the next poll can be rate-checked', async () => {
      const { store, record } = await codeFor();

      await evaluateDeviceCodeState(record, store, NOW).catch(() => undefined);

      expect((await store.findByDeviceCode(record.deviceCode))?.lastPolledAt).toEqual(NOW);
    });

    it('should keep the record so the device can poll again', async () => {
      const { store, record } = await codeFor();

      await evaluateDeviceCodeState(record, store, NOW).catch(() => undefined);

      expect((await store.findByDeviceCode(record.deviceCode))?.status).toBe('pending');
    });
  });

  describe('access_denied (RFC 8628 §3.5)', () => {
    it('should return access_denied for a denied record', async () => {
      const { store, record } = await codeFor(makeRecord({ status: 'denied' }));

      await expect(evaluateDeviceCodeState(record, store, NOW)).rejects.toThrowError(
        new DeviceAuthorizationError(
          'access_denied',
          'The end-user denied the authorization request',
        ),
      );
    });

    it('should delete the denied record', async () => {
      const { store, record } = await codeFor(makeRecord({ status: 'denied' }));

      await evaluateDeviceCodeState(record, store, NOW).catch(() => undefined);

      expect(await store.findByDeviceCode(record.deviceCode)).toBe(null);
    });
  });

  describe('Approved (RFC 8628 §3.5 → RFC 6749 §5.1)', () => {
    it('should return the grant context for an approved record', async () => {
      const { store, record } = await codeFor(approvedRecord());

      expect(await evaluateDeviceCodeState(record, store, NOW)).toEqual({
        subject: 'user-1',
        clientId: 'device-client',
        scope: ['openid', 'profile'],
        authTime: 1_800_000_000,
        grantId: 'grant-1',
      });
    });

    it('should consume the record so the device_code cannot be reused', async () => {
      const { store, record } = await codeFor(approvedRecord());

      await evaluateDeviceCodeState(record, store, NOW);

      expect(await store.findByDeviceCode(record.deviceCode)).toBe(null);
    });

    it('should fall back to the requested scope when approvedScope is absent', async () => {
      const { store, record } = await codeFor(
        approvedRecord({ approvedScope: undefined, scope: ['openid'] }),
      );

      expect((await evaluateDeviceCodeState(record, store, NOW)).scope).toEqual(['openid']);
    });

    it('should reject a concurrent second redemption with invalid_grant', async () => {
      const { store, record } = await codeFor(approvedRecord());
      await evaluateDeviceCodeState(record, store, NOW);

      await expect(evaluateDeviceCodeState(record, store, NOW)).rejects.toThrowError(
        new DeviceAuthorizationError(
          'invalid_grant',
          'The device_code is invalid, expired, or was issued to another client',
        ),
      );
    });
  });
});

describe('processDeviceCodeGrant', () => {
  it('should issue the grant context for an approved device_code', async () => {
    const { store, record } = await codeFor(approvedRecord());

    const result = await processDeviceCodeGrant({
      params: { device_code: record.deviceCode },
      client: DEVICE_CLIENT,
      store,
      now: NOW,
    });

    expect(result).toEqual({
      subject: 'user-1',
      clientId: 'device-client',
      scope: ['openid', 'profile'],
      authTime: 1_800_000_000,
      grantId: 'grant-1',
    });
  });

  it('should reject a client that is not registered for the device_code grant', async () => {
    const { store, record } = await codeFor(approvedRecord());

    await expect(
      processDeviceCodeGrant({
        params: { device_code: record.deviceCode },
        client: { clientId: 'device-client', grantTypes: ['authorization_code'] },
        store,
        now: NOW,
      }),
    ).rejects.toThrowError(DeviceAuthorizationError);
  });

  it('should return invalid_grant when the same device_code is redeemed twice', async () => {
    const { store, record } = await codeFor(approvedRecord());
    const input = {
      params: { device_code: record.deviceCode },
      client: DEVICE_CLIENT,
      store,
      now: NOW,
    };
    await processDeviceCodeGrant(input);

    const error = await processDeviceCodeGrant(input).catch(
      (caught: DeviceAuthorizationError) => caught,
    );

    expect(error.code).toBe('invalid_grant');
  });

  it('should answer every state error with HTTP 400', async () => {
    const { store, record } = await codeFor();

    const error = await processDeviceCodeGrant({
      params: { device_code: record.deviceCode },
      client: DEVICE_CLIENT,
      store,
      now: NOW,
    }).catch((caught: DeviceAuthorizationError) => caught);

    expect(error.statusCode).toBe(400);
  });

  it('should not leak the device_code into the error description', async () => {
    const { store, record } = await codeFor();

    const error = await processDeviceCodeGrant({
      params: { device_code: record.deviceCode },
      client: DEVICE_CLIENT,
      store,
      now: NOW,
    }).catch((caught: DeviceAuthorizationError) => caught);

    expect(error.errorDescription.includes(record.deviceCode)).toBe(false);
  });
});
