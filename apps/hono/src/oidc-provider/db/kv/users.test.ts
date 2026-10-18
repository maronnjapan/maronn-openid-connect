import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapKvDatabase, type MapKvDatabase } from '../../../test-support/databases.js';
import { readRecord, writeRecord } from './database.js';
import { keys, type UserRecord } from './keys.js';
import { hashPassword, registerUser, verifyPassword } from './users.js';

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW_MS = Date.UTC(2026, 0, 1);
const NOW = NOW_MS / 1000;

/** pbkdf2-sha256 $ iterations $ 16-byte salt $ 32-byte hash, both base64url without padding. */
const PASSWORD_HASH_FORMAT = /^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;

let db: MapKvDatabase;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  db = createMapKvDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

function userRecord(sub: string): Promise<UserRecord | undefined> {
  return readRecord<UserRecord>(db, keys.user(sub));
}

/** A hash in the format of hashPassword(), made with another iteration count. */
async function pbkdf2Hash(password: string, iterations: number): Promise<string> {
  const salt = new Uint8Array(16).fill(7);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  const base64Url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return ['pbkdf2-sha256', iterations, base64Url(salt), base64Url(new Uint8Array(bits))].join('$');
}

describe('registerUser', () => {
  it('should save the claims and a hash of the password, never the password itself', async () => {
    await registerUser(db, { sub: 'alice', email: 'alice@example.com', name: 'Alice', password: 'correct horse' });

    const stored = await userRecord('alice');
    expect(stored).toEqual({
      email: 'alice@example.com',
      is_verified: false,
      password_hash: expect.stringMatching(PASSWORD_HASH_FORMAT),
      created_at: NOW,
      updated_at: NOW,
      claims: { name: 'Alice' },
    });
    expect(await verifyPassword('correct horse', stored!.password_hash)).toBe(true);
  });

  it('should save email_verified to is_verified', async () => {
    await registerUser(db, { sub: 'alice', email: 'alice@example.com', email_verified: true });

    expect(await userRecord('alice')).toEqual({
      email: 'alice@example.com',
      is_verified: true,
      password_hash: null,
      created_at: NOW,
      updated_at: NOW,
      claims: {},
    });
  });

  it('should save no password hash for a user registered without a password', async () => {
    await registerUser(db, { sub: 'upstream-user', name: 'Upstream' });

    expect(await userRecord('upstream-user')).toEqual({
      email: null,
      is_verified: false,
      password_hash: null,
      created_at: NOW,
      updated_at: NOW,
      claims: { name: 'Upstream' },
    });
  });

  it('should replace an earlier registration with the same sub and keep when the user was created', async () => {
    await registerUser(db, { sub: 'alice', email: 'old@example.com', name: 'Old', password: 'old password' });
    vi.setSystemTime(NOW_MS + 10_000);
    await registerUser(db, { sub: 'alice', name: 'New' });

    expect(await userRecord('alice')).toEqual({
      email: null,
      is_verified: false,
      password_hash: null,
      created_at: NOW,
      updated_at: NOW + 10,
      claims: { name: 'New' },
    });
  });

  it('should keep the federated identities of a user registered again', async () => {
    const linked: UserRecord = {
      email: null,
      is_verified: false,
      password_hash: null,
      created_at: NOW,
      updated_at: NOW,
      claims: {},
      federated_identities: [{ provider: 'google', provider_sub: 'google-sub-1' }],
    };
    await writeRecord(db, keys.user('alice'), linked);

    await registerUser(db, { sub: 'alice', name: 'Alice' });

    expect(await userRecord('alice')).toEqual({
      ...linked,
      claims: { name: 'Alice' },
    });
  });
});

describe('hashPassword', () => {
  it('should hash the same password differently each time with a new salt', async () => {
    const first = await hashPassword('correct horse');
    const second = await hashPassword('correct horse');

    expect(first).toMatch(PASSWORD_HASH_FORMAT);
    expect(second).toMatch(PASSWORD_HASH_FORMAT);
    expect(second).not.toBe(first);
  });
});

describe('verifyPassword', () => {
  it('should accept the password a hash was made from', async () => {
    const hash = await hashPassword('correct horse');

    expect(await verifyPassword('correct horse', hash)).toBe(true);
  });

  it('should reject a password that does not match the stored hash', async () => {
    const hash = await hashPassword('correct horse');

    expect(await verifyPassword('battery staple', hash)).toBe(false);
  });

  // A stored hash records its iteration count, so raising PASSWORD_HASH_ITERATIONS keeps old hashes valid.
  it('should verify a hash made with another iteration count by the count it records', async () => {
    const hash = await pbkdf2Hash('correct horse', 1_000);

    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('battery staple', hash)).toBe(false);
  });

  it('should reject every password when there is no stored hash', async () => {
    expect(await verifyPassword('', null)).toBe(false);
  });

  it('should reject a stored value in another format', async () => {
    const hash = await hashPassword('correct horse');
    const [, , salt, digest] = hash.split('$');

    expect(await verifyPassword('correct horse', 'correct horse')).toBe(false);
    expect(await verifyPassword('correct horse', `bcrypt$100000$${salt}$${digest}`)).toBe(false);
    expect(await verifyPassword('correct horse', `pbkdf2-sha256$0$${salt}$${digest}`)).toBe(false);
    expect(await verifyPassword('correct horse', `pbkdf2-sha256$1.5$${salt}$${digest}`)).toBe(false);
    expect(await verifyPassword('correct horse', `pbkdf2-sha256$100000$$${digest}`)).toBe(false);
    expect(await verifyPassword('correct horse', `${hash}$extra`)).toBe(false);
  });
});
