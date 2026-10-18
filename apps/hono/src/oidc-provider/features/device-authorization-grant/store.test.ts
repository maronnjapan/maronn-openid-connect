import { afterEach, describe, expect, it, vi } from 'vitest';
import { pendingDeviceRecord } from '../../../test-support/browser-flows.js';
import { InMemoryDeviceAuthorizationStore } from './store.js';

describe('InMemoryDeviceAuthorizationStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should find a saved record by its device_code and by its normalized user_code', async () => {
    const store = new InMemoryDeviceAuthorizationStore();
    const record = pendingDeviceRecord();
    await store.save(record);

    expect(await store.findByDeviceCode(record.deviceCode)).toBe(record);
    expect(await store.findByUserCode('BCDFGHJK')).toBe(record);
  });

  it('should return null for codes it never saved', async () => {
    const store = new InMemoryDeviceAuthorizationStore();

    expect(await store.findByDeviceCode('unknown')).toBeNull();
    expect(await store.findByUserCode('ZZZZZZZZ')).toBeNull();
  });

  it('should replace a record on update and forget it on delete', async () => {
    const store = new InMemoryDeviceAuthorizationStore();
    const record = pendingDeviceRecord();
    await store.save(record);

    const approved = { ...record, status: 'approved' as const };
    await store.update(approved);
    expect(await store.findByDeviceCode(record.deviceCode)).toBe(approved);

    await store.delete(record.deviceCode);
    expect(await store.findByDeviceCode(record.deviceCode)).toBeNull();
  });

  // RFC 8628 §3.5: a device_code is redeemed once.
  it('should return a record from consume once and null afterwards', async () => {
    const store = new InMemoryDeviceAuthorizationStore();
    const record = pendingDeviceRecord();
    await store.save(record);

    expect(await store.consume(record.deviceCode)).toBe(record);
    expect(await store.consume(record.deviceCode)).toBeNull();
    expect(await store.findByUserCode('BCDFGHJK')).toBeNull();
  });

  // A record is reclaimed only one TTL (600 s) after it expired, so expired_token stays answerable until then.
  it('should drop records expired for longer than the grace period when it saves another', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:30:00.000Z'));
    const store = new InMemoryDeviceAuthorizationStore();
    const longExpired = pendingDeviceRecord({ expiresAt: new Date('2026-01-01T00:19:59.000Z') });
    const recentlyExpired = pendingDeviceRecord({
      userCode: 'WDJBMJHT',
      expiresAt: new Date('2026-01-01T00:20:01.000Z'),
    });
    await store.save(longExpired);
    await store.save(recentlyExpired);

    await store.save(pendingDeviceRecord({ userCode: 'MNPQRSTV' }));

    expect(await store.findByDeviceCode(longExpired.deviceCode)).toBeNull();
    expect(await store.findByDeviceCode(recentlyExpired.deviceCode)).toBe(recentlyExpired);
  });
});
