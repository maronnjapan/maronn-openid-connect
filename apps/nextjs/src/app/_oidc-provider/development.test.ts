import { describe, expect, it } from 'vitest';
import { createMapKvDatabase } from '../../test-support/databases';
import { createProviderStores } from './db/kv/stores';
import { registerUser } from './db/kv/users';
import { registerDevelopmentUsers } from './development';

// This app runs on the key-value database (db/index.ts), so the development
// users go there.

describe('registerDevelopmentUsers', () => {
  it('should register testuser and otheruser so that both sign in with the password "password"', async () => {
    const db = createMapKvDatabase();
    const { userStore } = createProviderStores(db);

    await registerDevelopmentUsers(db);

    expect(await userStore.authenticate('testuser', 'password')).toMatchObject({ sub: 'testuser' });
    expect(await userStore.authenticate('otheruser', 'password')).toMatchObject({ sub: 'otheruser' });
  });

  // OIDC Core 1.0 §5.4: testuser carries a claim for every claim scope Discovery advertises.
  it('should give testuser the claims of the email, address and phone scopes', async () => {
    const db = createMapKvDatabase();

    await registerDevelopmentUsers(db);

    expect(await createProviderStores(db).userStore.getClaims('testuser')).toMatchObject({
      email: 'test@example.com',
      email_verified: true,
      address: { country: 'JP', postal_code: '10000' },
      phone_number: '+81-3-0000-0000',
      phone_number_verified: true,
    });
  });

  it('should leave a user that is already registered as it is', async () => {
    const db = createMapKvDatabase();
    await registerUser(db, { sub: 'testuser', name: 'Kept User', password: 'kept-password' });
    const { userStore } = createProviderStores(db);

    await registerDevelopmentUsers(db);

    expect(await userStore.getClaims('testuser')).toEqual({ sub: 'testuser', name: 'Kept User' });
    expect(await userStore.authenticate('testuser', 'password')).toBeUndefined();
  });
});
