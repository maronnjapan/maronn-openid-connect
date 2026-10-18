import type { GoogleIdTokenPayload } from '@maronn-openid-connect/google-login';
import { describe, expect, it } from 'vitest';
import { createEmptyDatabase } from '../../db/memory/database.js';
import { createProviderStores } from '../../db/memory/stores.js';
import { createGoogleLoginNonceStore, googleAccountToFederatedIdentity } from './store.js';

const EXPIRES_AT = Date.now() + 600_000;

function nonceStore() {
  const db = createEmptyDatabase();
  return { db, store: createGoogleLoginNonceStore(createProviderStores(db).upstreamLoginStore) };
}

function account(overrides: Partial<GoogleIdTokenPayload> = {}): GoogleIdTokenPayload {
  return {
    iss: 'https://accounts.google.com',
    aud: 'google-client-id',
    sub: 'google-sub-1',
    iat: 1_767_225_600,
    exp: 1_767_229_200,
    ...overrides,
  };
}

describe('createGoogleLoginNonceStore', () => {
  it('should keep the nonce without the package prefix as an upstream login at google', async () => {
    const { db, store } = nonceStore();

    await store.put('google_login_nonce:nonce-1', { transactionId: 'txn-1', expiresAt: EXPIRES_AT }, 600);

    expect([...db.upstreamLogins.entries()]).toEqual([
      ['nonce-1', { provider: 'google', transactionId: 'txn-1', expiresAt: EXPIRES_AT }],
    ]);
  });

  it('should return the transaction a prefixed nonce key was issued for', async () => {
    const { store } = nonceStore();
    await store.put('google_login_nonce:nonce-1', { transactionId: 'txn-1', expiresAt: EXPIRES_AT }, 600);

    expect(await store.get('google_login_nonce:nonce-1')).toEqual({ transactionId: 'txn-1', expiresAt: EXPIRES_AT });
  });

  it('should return null for an unknown nonce and for a nonce sent to another provider', async () => {
    const { db, store } = nonceStore();
    db.upstreamLogins.set('nonce-other', { provider: 'other-idp', transactionId: 'txn-1', expiresAt: EXPIRES_AT });

    expect(await store.get('google_login_nonce:unknown')).toBeNull();
    expect(await store.get('google_login_nonce:nonce-other')).toBeNull();
  });

  it('should delete the upstream login of a nonce', async () => {
    const { db, store } = nonceStore();
    await store.put('google_login_nonce:nonce-1', { transactionId: 'txn-1', expiresAt: EXPIRES_AT }, 600);

    await store.delete('google_login_nonce:nonce-1');

    expect(db.upstreamLogins.size).toBe(0);
  });
});

describe('googleAccountToFederatedIdentity', () => {
  it('should copy the profile and email claims Google asserted, under the Google sub', () => {
    const identity = googleAccountToFederatedIdentity(
      account({
        name: 'Alice Example',
        given_name: 'Alice',
        family_name: 'Example',
        picture: 'https://lh3.googleusercontent.com/a/alice',
        locale: 'en',
        email: 'alice@gmail.com',
        email_verified: true,
      }),
    );

    expect(identity).toEqual({
      provider: 'google',
      subject: 'google-sub-1',
      claims: {
        name: 'Alice Example',
        given_name: 'Alice',
        family_name: 'Example',
        picture: 'https://lh3.googleusercontent.com/a/alice',
        locale: 'en',
        email: 'alice@gmail.com',
        email_verified: true,
      },
    });
  });

  it('should leave out the claims Google did not assert and every token claim', () => {
    const identity = googleAccountToFederatedIdentity(
      account({ email: 'alice@example.com', email_verified: false, hd: 'example.com', nonce: 'nonce-1', azp: 'google-client-id' }),
    );

    expect(identity).toEqual({
      provider: 'google',
      subject: 'google-sub-1',
      claims: { email: 'alice@example.com', email_verified: false },
    });
  });
});
