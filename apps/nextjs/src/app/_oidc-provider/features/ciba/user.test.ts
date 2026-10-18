import { describe, expect, it } from 'vitest';
import { createDatabase, registerUser } from '../../db';
import { resolveCibaUser } from './user';

// provider.ts reads its users from the key-value store of db/ (in memory for
// the tests, vitest.config.ts), so the users are registered there.

// CIBA Core 1.0 §7.1: login_hint names the End-User the request is for.
describe('resolveCibaUser', () => {
  it('should resolve a login_hint that is the username of a registered user to its subject', async () => {
    await registerUser(createDatabase(), { sub: 'ciba-alice', email: 'alice@example.com', password: 'secret' });

    expect(await resolveCibaUser('ciba-alice')).toEqual({ subject: 'ciba-alice' });
  });

  it('should return null for a login_hint that names no registered user', async () => {
    expect(await resolveCibaUser('ciba-nobody')).toBeNull();
  });

  // The default reads the hint as a username only, not as an email address.
  it('should return null for the email address of a registered user', async () => {
    await registerUser(createDatabase(), { sub: 'ciba-bob', email: 'bob@example.com', password: 'secret' });

    expect(await resolveCibaUser('bob@example.com')).toBeNull();
  });
});
