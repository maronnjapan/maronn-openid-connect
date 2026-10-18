import { describe, expect, it } from 'vitest';
import {
  buildClearedLogoutConfirmationCookie,
  buildLogoutConfirmationCookie,
  parseLogoutConfirmation,
} from './cookies.js';

describe('buildLogoutConfirmationCookie', () => {
  it('should carry the secret and the base64url redirect target in an HttpOnly cookie that lasts 10 minutes', () => {
    expect(buildLogoutConfirmationCookie({ csrfSecret: 'secret-1', redirectTo: 'https://rp.example.com/bye' })).toBe(
      'oidc_logout_confirm=secret-1.aHR0cHM6Ly9ycC5leGFtcGxlLmNvbS9ieWU; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600',
    );
  });

  it('should leave the redirect part empty when there is no redirect target', () => {
    expect(buildLogoutConfirmationCookie({ csrfSecret: 'secret-1', redirectTo: null })).toBe(
      'oidc_logout_confirm=secret-1.; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600',
    );
  });
});

describe('buildClearedLogoutConfirmationCookie', () => {
  it('should build an empty confirmation cookie with Max-Age=0', () => {
    expect(buildClearedLogoutConfirmationCookie()).toBe(
      'oidc_logout_confirm=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    );
  });
});

describe('parseLogoutConfirmation', () => {
  it('should read back the secret and a redirect target with non-ASCII characters', () => {
    const cookie = buildLogoutConfirmationCookie({
      csrfSecret: 'secret-1',
      redirectTo: 'https://rp.example.com/bye?state=日本語',
    }).split(';')[0];

    expect(parseLogoutConfirmation(`session_id=s1; ${cookie}`)).toEqual({
      csrfSecret: 'secret-1',
      redirectTo: 'https://rp.example.com/bye?state=日本語',
    });
  });

  it('should read back a confirmation without a redirect target', () => {
    expect(parseLogoutConfirmation('oidc_logout_confirm=secret-1.')).toEqual({ csrfSecret: 'secret-1', redirectTo: null });
  });

  // A malformed cookie is answered with 400 and deletes nothing.
  describe('Malformed cookies', () => {
    it('should return null without the confirmation cookie', () => {
      expect(parseLogoutConfirmation('session_id=s1')).toBeNull();
      expect(parseLogoutConfirmation(null)).toBeNull();
    });

    it('should return null for a value without the separator or with an empty secret', () => {
      expect(parseLogoutConfirmation('oidc_logout_confirm=secret-1')).toBeNull();
      expect(parseLogoutConfirmation('oidc_logout_confirm=.aHR0cHM6Ly9ycA')).toBeNull();
    });

    it('should return null for a redirect part that is not base64url', () => {
      expect(parseLogoutConfirmation('oidc_logout_confirm=secret-1.aHR0c+/=')).toBeNull();
    });
  });
});
