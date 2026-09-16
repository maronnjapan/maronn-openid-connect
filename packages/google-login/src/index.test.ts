import { describe, expect, it } from 'vitest';

import * as api from './index.js';

describe('Google login package', () => {
  // 公開 API の一覧を固定する。追加・削除はこのテストの更新（= レビュー）を伴う。
  it('should export the public API', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'DEFAULT_CERTS_CACHE_TTL_SECONDS',
        'DEFAULT_CERTS_MIN_REFRESH_INTERVAL_MS',
        'DEFAULT_GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS',
        'GOOGLE_CERTS_URL',
        'GOOGLE_CREDENTIAL_PARAM',
        'GOOGLE_CSRF_TOKEN_COOKIE',
        'GOOGLE_CSRF_TOKEN_PARAM',
        'GOOGLE_GSI_CLIENT_SCRIPT_URL',
        'GOOGLE_ID_TOKEN_ISSUERS',
        'GOOGLE_ID_TOKEN_SIGNING_ALG',
        'GOOGLE_SELECT_BY_PARAM',
        'GOOGLE_SIGN_IN_CSP_SOURCES',
        'GoogleLoginError',
        'GoogleLoginErrorCode',
        'assertGoogleLoginUri',
        'buildGoogleSignInMarkup',
        'consumeGoogleLoginNonce',
        'createGoogleCertsKeyProvider',
        'createStaticGoogleSigningKeyProvider',
        'decodeGoogleIdToken',
        'escapeHtmlAttribute',
        'handleGoogleLoginRedirect',
        'issueGoogleLoginNonce',
        'parseCacheControlMaxAge',
        'parseGoogleCsrfTokenCookie',
        'parseGoogleRedirectCredential',
        'parseJwkSet',
        'readGoogleLoginParam',
        'resolveGoogleLoginSubject',
        'resolveGoogleSigningKey',
        'validateGoogleCsrfToken',
        'validateGoogleEmailVerified',
        'validateGoogleHostedDomain',
        'validateGoogleIdTokenAudience',
        'validateGoogleIdTokenExpiration',
        'validateGoogleIdTokenIssuer',
        'validateGoogleIdTokenNonce',
        'verifyGoogleIdToken',
        'verifyGoogleIdTokenSignature',
      ].sort(),
    );
  });

  it('should pin the Google endpoints the package talks to', () => {
    expect(api.GOOGLE_CERTS_URL).toBe('https://www.googleapis.com/oauth2/v3/certs');
    expect(api.GOOGLE_GSI_CLIENT_SCRIPT_URL).toBe('https://accounts.google.com/gsi/client');
    expect(api.GOOGLE_ID_TOKEN_ISSUERS).toEqual(['accounts.google.com', 'https://accounts.google.com']);
    expect(api.GOOGLE_ID_TOKEN_SIGNING_ALG).toBe('RS256');
  });
});
