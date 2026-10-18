import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapKvDatabase, type MapKvDatabase } from '../../../test-support/databases.js';
import { readRecord, writeRecord } from './database.js';

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW_MS = Date.UTC(2026, 0, 1);

let db: MapKvDatabase;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  db = createMapKvDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readRecord', () => {
  it('should parse the JSON text under the key', async () => {
    await db.set('oidc:user:alice', '{"email":"alice@example.com","is_verified":true}');

    expect(await readRecord(db, 'oidc:user:alice')).toEqual({ email: 'alice@example.com', is_verified: true });
  });

  it('should return undefined for a missing key', async () => {
    expect(await readRecord(db, 'oidc:user:nobody')).toBeUndefined();
  });
});

describe('writeRecord', () => {
  it('should store the record as JSON text', async () => {
    await writeRecord(db, 'oidc:user:alice', { email: 'alice@example.com', claims: { name: 'Alice' } });

    expect(db.entries()).toEqual([['oidc:user:alice', '{"email":"alice@example.com","claims":{"name":"Alice"}}']]);
  });

  it('should store the record with the TTL it is given', async () => {
    await writeRecord(db, 'oidc:code:hash', { grant_id: 'grant-1' }, 60);

    vi.setSystemTime(NOW_MS + 59_999);
    const beforeExpiry = await readRecord(db, 'oidc:code:hash');
    vi.setSystemTime(NOW_MS + 60_000);
    const atExpiry = await readRecord(db, 'oidc:code:hash');

    expect(beforeExpiry).toEqual({ grant_id: 'grant-1' });
    expect(atExpiry).toBeUndefined();
  });

  it('should store a record written without a TTL so that it does not expire', async () => {
    await writeRecord(db, 'oidc:user:alice', { email: null });

    vi.setSystemTime(NOW_MS + 10 * 365 * 86_400_000);

    expect(await readRecord(db, 'oidc:user:alice')).toEqual({ email: null });
  });
});
