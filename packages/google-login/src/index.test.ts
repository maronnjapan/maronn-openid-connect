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
        'GOOGLE_SELECT_BY_PARAM',
        'GoogleLoginError',
        'GoogleLoginErrorCode',
        'consumeGoogleLoginNonce',
        'createGoogleIdTokenVerifier',
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

  // フロント側の設定（g_id_onload の属性）は Node 非依存のサブパス ./sign-in にあり、
  // サーバー側のエントリポイントには含めない（ブラウザ向けバンドルに google-auth-library を
  // 引き込ませないため）。
  it('should keep the front-end sign-in helpers out of the server entry point', () => {
    expect('buildGoogleSignInAttributes' in api).toBe(false);
    expect('googleSignInAttributesToHtml' in api).toBe(false);
  });
});
