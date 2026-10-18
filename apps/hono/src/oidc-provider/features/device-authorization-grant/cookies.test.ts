import { describe, expect, it } from 'vitest';
import {
  buildClearedDeviceBindingCookie,
  buildDeviceBindingCookie,
  parseDeviceBindingSecret,
} from './cookies.js';

describe('buildDeviceBindingCookie', () => {
  // RFC 8628 §5.4: HttpOnly, Secure, SameSite=Lax, named after the user_code.
  it('should build an HttpOnly, Secure, SameSite=Lax cookie named after the user_code with the given Max-Age', () => {
    expect(buildDeviceBindingCookie('BCDFGHJK', 'secret-1', 600)).toBe(
      'oidc_device_BCDFGHJK=secret-1; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600',
    );
  });
});

describe('buildClearedDeviceBindingCookie', () => {
  it('should build an empty cookie of the same name with Max-Age=0', () => {
    expect(buildClearedDeviceBindingCookie('BCDFGHJK')).toBe(
      'oidc_device_BCDFGHJK=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    );
  });
});

describe('parseDeviceBindingSecret', () => {
  it('should return the secret of the cookie for the user_code among other cookies', () => {
    expect(
      parseDeviceBindingSecret('session_id=s1; oidc_device_WDJBMJHT=other; oidc_device_BCDFGHJK=secret-1', 'BCDFGHJK'),
    ).toBe('secret-1');
  });

  it('should return null when only another user_code has a cookie', () => {
    expect(parseDeviceBindingSecret('oidc_device_WDJBMJHT=other; malformed', 'BCDFGHJK')).toBeNull();
  });

  it('should return null without a Cookie header', () => {
    expect(parseDeviceBindingSecret(null, 'BCDFGHJK')).toBeNull();
  });
});
