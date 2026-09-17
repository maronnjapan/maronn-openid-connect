import { describe, expect, it } from 'vitest';

import * as api from './index.js';

describe('Google login package', () => {
  // 公開 API の一覧を固定する。追加・削除はこのテストの更新（= レビュー）を伴う。
  it('should export the public API', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'GOOGLE_CREDENTIAL_PARAM',
        'GOOGLE_CSRF_TOKEN_COOKIE',
        'GOOGLE_CSRF_TOKEN_PARAM',
        'GOOGLE_GSI_CLIENT_SCRIPT_URL',
        'GOOGLE_SELECT_BY_PARAM',
        'GOOGLE_SIGN_IN_CSP_SOURCES',
        'GoogleLoginError',
        'GoogleLoginErrorCode',
        'assertGoogleLoginUri',
        'buildGoogleSignInMarkup',
        'consumeGoogleLoginNonce',
        'createGoogleIdTokenVerifier',
        'escapeHtmlAttribute',
        'getDefaultGoogleIdTokenVerifier',
        'handleGoogleLoginRedirect',
        'issueGoogleLoginNonce',
        'parseGoogleCsrfTokenCookie',
        'parseGoogleRedirectCredential',
        'readGoogleLoginParam',
        'resolveGoogleLoginSubject',
        'validateGoogleCsrfToken',
        'validateGoogleEmailVerified',
        'validateGoogleHostedDomain',
        'validateGoogleIdTokenNonce',
        'verifyGoogleIdToken',
      ].sort(),
    );
  });

  it('should pin the GIS client script the login page loads', () => {
    expect(api.GOOGLE_GSI_CLIENT_SCRIPT_URL).toBe('https://accounts.google.com/gsi/client');
  });
});
