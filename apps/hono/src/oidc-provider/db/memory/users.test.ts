import { describe, expect, it } from 'vitest';
import { createEmptyDatabase } from './database.js';
import { hashPassword, registerUser, verifyPassword } from './users.js';

/** pbkdf2-sha256 $ iterations $ 16-byte salt $ 32-byte hash, both base64url without padding. */
const PASSWORD_HASH_FORMAT = /^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;

describe('registerUser', () => {
  it('should keep the claims and a hash of the password, never the password itself', async () => {
    const db = createEmptyDatabase();

    await registerUser(db, { sub: 'alice', email: 'alice@example.com', password: 'correct horse' });

    const stored = db.users.get('alice')!;
    expect(stored).toEqual({
      claims: { sub: 'alice', email: 'alice@example.com' },
      passwordHash: expect.stringMatching(PASSWORD_HASH_FORMAT),
    });
    expect(await verifyPassword('correct horse', stored.passwordHash!)).toBe(true);
  });

  it('should keep no password hash for a user registered without a password', async () => {
    const db = createEmptyDatabase();

    await registerUser(db, { sub: 'upstream-user', name: 'Upstream' });

    expect(db.users.get('upstream-user')).toEqual({ claims: { sub: 'upstream-user', name: 'Upstream' } });
  });

  it('should replace an earlier registration with the same sub', async () => {
    const db = createEmptyDatabase();

    await registerUser(db, { sub: 'alice', name: 'Old', password: 'old password' });
    await registerUser(db, { sub: 'alice', name: 'New' });

    expect(db.users.get('alice')).toEqual({ claims: { sub: 'alice', name: 'New' } });
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
  it('should reject a password that does not match the stored hash', async () => {
    const hash = await hashPassword('correct horse');

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
    expect(await verifyPassword('correct horse', `${hash}$extra`)).toBe(false);
  });
});
