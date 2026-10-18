import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextOf } from '../../../../../../test-support/context.js';
import { InMemoryDeviceAuthorizationStore } from '../../../store.js';
import { issueDeviceCodes } from './issue-device-code.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

describe('issueDeviceCodes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // RFC 8628 §3.2: expires_in 600 and interval 5 come from config.ts.
  it('should save a pending record for the client and scope with the configured lifetime and interval', async () => {
    const store = new InMemoryDeviceAuthorizationStore();
    const c = contextOf(undefined, { deviceAuthorizationStore: store });

    const record = await issueDeviceCodes(c, { clientId: 'device-client' }, ['openid', 'profile']);

    expect(record).toMatchObject({
      clientId: 'device-client',
      scope: ['openid', 'profile'],
      status: 'pending',
      createdAt: NOW,
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
      interval: 5,
      lastPolledAt: null,
      csrfToken: null,
      bindingHash: null,
      loginAttempts: 0,
    });
    expect(await store.findByDeviceCode(record.deviceCode)).toBe(record);
  });

  // RFC 8628 §6.1: eight characters of the base-20 charset, shown as XXXX-XXXX.
  it('should mint a base-20 user_code and its XXXX-XXXX display form', async () => {
    const store = new InMemoryDeviceAuthorizationStore();
    const c = contextOf(undefined, { deviceAuthorizationStore: store });

    const record = await issueDeviceCodes(c, { clientId: 'device-client' }, ['openid']);

    expect(record.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
    expect(record.userCodeDisplay).toBe(`${record.userCode.slice(0, 4)}-${record.userCode.slice(4)}`);
    expect(await store.findByUserCode(record.userCode)).toBe(record);
  });

  // RFC 8628 §5.2: device_code carries 256 bits (32 bytes, base64url without padding).
  it('should mint a 43-character base64url device_code that differs on every call', async () => {
    const store = new InMemoryDeviceAuthorizationStore();
    const c = contextOf(undefined, { deviceAuthorizationStore: store });

    const first = await issueDeviceCodes(c, { clientId: 'device-client' }, ['openid']);
    const second = await issueDeviceCodes(c, { clientId: 'device-client' }, ['openid']);

    expect(first.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.deviceCode).not.toBe(first.deviceCode);
  });
});
