import { describe, expect, it } from 'vitest';
import { continueToLogin } from './continue-to-login.js';

describe('continueToLogin', () => {
  // OIDC Core 1.0 §3.1.2.3: the transaction id travels only in the HttpOnly
  // __Host- cookie, which lives as long as the transaction.
  it('should continue on the login screen with the transaction cookie', () => {
    expect(continueToLogin('txn-1', 600)).toEqual({
      kind: 'login',
      cookies: ['__Host-oidc_txn=txn-1; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600'],
    });
  });

  it('should give the cookie the lifetime of the transaction', () => {
    expect(continueToLogin('txn-2', 120)).toEqual({
      kind: 'login',
      cookies: ['__Host-oidc_txn=txn-2; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=120'],
    });
  });
});
