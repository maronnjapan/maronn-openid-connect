import { describe, expect, it } from 'vitest';

import { GoogleLoginErrorCode } from './errors.js';
import {
  GOOGLE_CREDENTIAL_PARAM,
  GOOGLE_CSRF_TOKEN_COOKIE,
  GOOGLE_CSRF_TOKEN_PARAM,
  GOOGLE_SELECT_BY_PARAM,
  parseGoogleCsrfTokenCookie,
  parseGoogleRedirectCredential,
  readGoogleLoginParam,
  validateGoogleCsrfToken,
} from './redirect-credential.js';
import { captureThrow, expectGoogleLoginError } from './test-helpers.js';

describe('parameter names', () => {
  // GIS の redirect mode が login_uri へ POST するフィールド名と Cookie 名
  it('should use the field names that Google Identity Services posts', () => {
    expect(GOOGLE_CREDENTIAL_PARAM).toBe('credential');
    expect(GOOGLE_CSRF_TOKEN_PARAM).toBe('g_csrf_token');
    expect(GOOGLE_CSRF_TOKEN_COOKIE).toBe('g_csrf_token');
    expect(GOOGLE_SELECT_BY_PARAM).toBe('select_by');
  });
});

describe('readGoogleLoginParam', () => {
  it('should read a string from a record', () => {
    expect(readGoogleLoginParam({ credential: 'jwt' }, 'credential')).toBe('jwt');
  });

  it('should read a value from URLSearchParams', () => {
    expect(readGoogleLoginParam(new URLSearchParams('credential=jwt&select_by=btn'), 'select_by')).toBe('btn');
  });

  it('should read a value from FormData', () => {
    const form = new FormData();
    form.set('credential', 'jwt');

    expect(readGoogleLoginParam(form, 'credential')).toBe('jwt');
  });

  it('should return undefined for a missing parameter', () => {
    expect(readGoogleLoginParam({}, 'credential')).toBe(undefined);
    expect(readGoogleLoginParam(new URLSearchParams(''), 'credential')).toBe(undefined);
  });

  it('should ignore values that are not strings', () => {
    expect(readGoogleLoginParam({ credential: 123 }, 'credential')).toBe(undefined);
    expect(readGoogleLoginParam({ credential: ['a'] }, 'credential')).toBe(undefined);
  });
});

describe('parseGoogleRedirectCredential', () => {
  it('should extract credential, csrf token and select_by', () => {
    expect(
      parseGoogleRedirectCredential({ credential: 'jwt', g_csrf_token: 'csrf', select_by: 'btn' }),
    ).toEqual({ credential: 'jwt', csrfToken: 'csrf', selectBy: 'btn' });
  });

  it('should accept URLSearchParams', () => {
    expect(
      parseGoogleRedirectCredential(new URLSearchParams('credential=jwt&g_csrf_token=csrf&select_by=user')),
    ).toEqual({ credential: 'jwt', csrfToken: 'csrf', selectBy: 'user' });
  });

  it('should omit csrfToken and selectBy when the body does not carry them', () => {
    expect(parseGoogleRedirectCredential({ credential: 'jwt' })).toEqual({ credential: 'jwt' });
  });

  it('should reject a body without credential', () => {
    const error = captureThrow(() => parseGoogleRedirectCredential({ g_csrf_token: 'csrf' }));

    expectGoogleLoginError(error, GoogleLoginErrorCode.MissingCredential, 400);
  });

  it('should reject an empty credential', () => {
    const error = captureThrow(() => parseGoogleRedirectCredential({ credential: '' }));

    expectGoogleLoginError(error, GoogleLoginErrorCode.MissingCredential, 400);
  });
});

describe('parseGoogleCsrfTokenCookie', () => {
  it('should read g_csrf_token from a single cookie', () => {
    expect(parseGoogleCsrfTokenCookie('g_csrf_token=abc123')).toBe('abc123');
  });

  it('should read g_csrf_token among other cookies', () => {
    expect(parseGoogleCsrfTokenCookie('session_id=s1; g_csrf_token=abc123; theme=dark')).toBe('abc123');
  });

  it('should tolerate whitespace around the cookie name', () => {
    expect(parseGoogleCsrfTokenCookie('session_id=s1;  g_csrf_token =abc123')).toBe('abc123');
  });

  it('should return undefined when the header is missing', () => {
    expect(parseGoogleCsrfTokenCookie(null)).toBe(undefined);
    expect(parseGoogleCsrfTokenCookie(undefined)).toBe(undefined);
    expect(parseGoogleCsrfTokenCookie('')).toBe(undefined);
  });

  it('should return undefined when the cookie is absent', () => {
    expect(parseGoogleCsrfTokenCookie('session_id=s1')).toBe(undefined);
  });

  it('should return undefined when the cookie value is empty', () => {
    expect(parseGoogleCsrfTokenCookie('g_csrf_token=')).toBe(undefined);
  });

  it('should not match a cookie whose name merely ends with g_csrf_token', () => {
    expect(parseGoogleCsrfTokenCookie('xg_csrf_token=abc123')).toBe(undefined);
  });

  it('should return the first g_csrf_token when the header repeats it', () => {
    expect(parseGoogleCsrfTokenCookie('g_csrf_token=first; g_csrf_token=second')).toBe('first');
  });
});

describe('validateGoogleCsrfToken', () => {
  it('should accept equal tokens', () => {
    expect(() => validateGoogleCsrfToken('abc123', 'abc123')).not.toThrow();
  });

  // Google のドキュメントのサンプルと同じ順序: Cookie 無し → 本文無し → 不一致
  it('should reject a missing cookie before looking at the body', () => {
    const error = captureThrow(() => validateGoogleCsrfToken(undefined, undefined));

    expectGoogleLoginError(error, GoogleLoginErrorCode.CsrfTokenMissingInCookie, 400);
    expect((error as Error).message).toBe('No CSRF token in Cookie.');
  });

  it('should reject a missing body token', () => {
    const error = captureThrow(() => validateGoogleCsrfToken(undefined, 'abc123'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.CsrfTokenMissingInBody, 400);
    expect((error as Error).message).toBe('No CSRF token in post body.');
  });

  it('should reject an empty body token', () => {
    const error = captureThrow(() => validateGoogleCsrfToken('', 'abc123'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.CsrfTokenMissingInBody, 400);
  });

  it('should reject tokens that differ', () => {
    const error = captureThrow(() => validateGoogleCsrfToken('abc123', 'abc124'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.CsrfTokenMismatch, 400);
    expect((error as Error).message).toBe('Failed to verify double submit cookie.');
  });

  it('should reject tokens of different length', () => {
    const error = captureThrow(() => validateGoogleCsrfToken('abc123', 'abc1234'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.CsrfTokenMismatch, 400);
  });
});
