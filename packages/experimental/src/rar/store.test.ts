import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryRarDetailsStore } from './store.js';

const DETAILS = [{ type: 'payment_initiation', actions: ['initiate'] }] as const;

describe('createInMemoryRarDetailsStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return stored details for a key', async () => {
    const store = createInMemoryRarDetailsStore();
    await store.set('txn-1', DETAILS);
    expect(await store.get('txn-1')).toEqual(DETAILS);
  });

  it('should return undefined for an unknown key', async () => {
    const store = createInMemoryRarDetailsStore();
    expect(await store.get('missing')).toBe(undefined);
  });

  it('should return undefined after delete', async () => {
    const store = createInMemoryRarDetailsStore();
    await store.set('txn-1', DETAILS);
    await store.delete('txn-1');
    expect(await store.get('txn-1')).toBe(undefined);
  });

  it('should return undefined once expiresAt has passed', async () => {
    const store = createInMemoryRarDetailsStore();
    await store.set('grant-1', DETAILS, Date.now() + 1000);
    expect(await store.get('grant-1')).toEqual(DETAILS);
    vi.advanceTimersByTime(1000);
    expect(await store.get('grant-1')).toBe(undefined);
  });

  it('should keep an entry without expiresAt alive', async () => {
    const store = createInMemoryRarDetailsStore();
    await store.set('txn-1', DETAILS);
    vi.advanceTimersByTime(10 * 24 * 60 * 60 * 1000);
    expect(await store.get('txn-1')).toEqual(DETAILS);
  });

  it('should evict expired entries on the next set', async () => {
    const store = createInMemoryRarDetailsStore();
    await store.set('grant-1', DETAILS, Date.now() + 1000);
    vi.advanceTimersByTime(2000);
    // 書き込み時の lazy eviction で、失効済みの grant-1 が掃除される。
    await store.set('grant-2', DETAILS, Date.now() + 1000);
    expect(await store.get('grant-1')).toBe(undefined);
    expect(await store.get('grant-2')).toEqual(DETAILS);
  });
});
