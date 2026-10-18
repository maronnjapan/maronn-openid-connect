import { describe, expect, it } from 'vitest';
import { contextOf, providerContext } from '../../../../test-support/context.js';
import { registerUser } from '../../../db/memory/users.js';
import { authenticateEndUser } from './authenticate-user.js';

async function contextWithAlice() {
  const { c, db } = await providerContext();
  await registerUser(db, { sub: 'alice', email: 'alice@example.com', password: 'correct-password' });
  return c;
}

describe('authenticateEndUser', () => {
  it('should return the End-User for the right username and password', async () => {
    const c = await contextWithAlice();

    expect(await authenticateEndUser(c, 'alice', 'correct-password')).toMatchObject({
      sub: 'alice',
      email: 'alice@example.com',
    });
  });

  it('should return undefined for a wrong password', async () => {
    const c = await contextWithAlice();

    expect(await authenticateEndUser(c, 'alice', 'wrong-password')).toBeUndefined();
  });

  it('should return undefined for an unknown username', async () => {
    const c = await contextWithAlice();

    expect(await authenticateEndUser(c, 'mallory', 'correct-password')).toBeUndefined();
  });

  it('should return undefined when the authenticateUser of the context answers null', async () => {
    const c = contextOf(undefined, { authenticateUser: async () => null });

    expect(await authenticateEndUser(c, 'alice', 'correct-password')).toBeUndefined();
  });
});
