import { describe, expect, it } from 'vitest';
import {
  buildCibaLoginBindingCookie,
  buildClearedCibaLoginBindingCookie,
  parseCibaLoginBindingSecret,
} from './cookies.js';

describe('buildCibaLoginBindingCookie', () => {
  it('should build an HttpOnly, Secure, SameSite=Lax cookie named after the transaction with the given Max-Age', () => {
    expect(buildCibaLoginBindingCookie('txn-1', 'secret-1', 600)).toBe(
      'oidc_ciba_login_txn-1=secret-1; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600',
    );
  });
});

describe('buildClearedCibaLoginBindingCookie', () => {
  it('should build an empty cookie of the same name with Max-Age=0', () => {
    expect(buildClearedCibaLoginBindingCookie('txn-1')).toBe(
      'oidc_ciba_login_txn-1=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    );
  });
});

describe('parseCibaLoginBindingSecret', () => {
  it('should return the secret of the cookie for the transaction among other cookies', () => {
    expect(parseCibaLoginBindingSecret('session_id=s1; oidc_ciba_login_txn-2=other; oidc_ciba_login_txn-1=secret-1', 'txn-1')).toBe(
      'secret-1',
    );
  });

  it('should return null when only another transaction has a cookie', () => {
    expect(parseCibaLoginBindingSecret('oidc_ciba_login_txn-2=other; malformed', 'txn-1')).toBeNull();
  });

  it('should return null without a Cookie header', () => {
    expect(parseCibaLoginBindingSecret(null, 'txn-1')).toBeNull();
  });
});
