import { beforeEach, describe, expect, it } from 'vitest';

import { GoogleLoginError, GoogleLoginErrorCode } from './errors.js';
import type { GoogleIdTokenPayload } from './id-token.js';
import { handleGoogleLoginRedirect } from './login-redirect.js';
import { issueGoogleLoginNonce } from './nonce.js';
import {
  captureRejection,
  createFakeVerifier,
  createGoogleIdTokenPayload,
  createInMemoryNonceStore,
  expectGoogleLoginError,
  TEST_CLIENT_ID,
  type FakeVerifier,
  type InMemoryNonceStore,
} from './test-helpers.js';

const CSRF = 'g-csrf-token-value';
const VALID_ID_TOKEN = 'valid.id.token';

let verifier: FakeVerifier;
let nonceStore: InMemoryNonceStore;
let nonce: string;
let issued: GoogleIdTokenPayload;

beforeEach(async () => {
  nonceStore = createInMemoryNonceStore();
  nonce = await issueGoogleLoginNonce({
    transactionId: 'txn-1',
    expiresAt: Date.now() + 600_000,
    store: nonceStore,
  });
  issued = createGoogleIdTokenPayload({ nonce });
  // google-auth-library の代わり: 既知のトークン文字列だけを受け入れる
  verifier = createFakeVerifier((idToken) => {
    if (idToken === VALID_ID_TOKEN) return issued;
    throw new GoogleLoginError(GoogleLoginErrorCode.InvalidIdToken, 'Invalid token signature');
  });
});

describe('handleGoogleLoginRedirect', () => {
  it('should return the transaction id and the verified account for a valid redirect POST', async () => {
    const result = await handleGoogleLoginRedirect({
      params: { credential: VALID_ID_TOKEN, g_csrf_token: CSRF, select_by: 'btn' },
      cookieHeader: `session_id=abc; g_csrf_token=${CSRF}`,
      clientId: TEST_CLIENT_ID,
      verifier,
      nonceStore,
    });

    expect(result).toEqual({ transactionId: 'txn-1', account: issued, selectBy: 'btn' });
    expect(verifier.calls).toEqual([{ idToken: VALID_ID_TOKEN, clientId: TEST_CLIENT_ID }]);
  });

  it('should accept the POST body as FormData', async () => {
    const form = new FormData();
    form.set('credential', VALID_ID_TOKEN);
    form.set('g_csrf_token', CSRF);

    const result = await handleGoogleLoginRedirect({
      params: form,
      cookieHeader: `g_csrf_token=${CSRF}`,
      clientId: TEST_CLIENT_ID,
      verifier,
      nonceStore,
    });

    expect(result.transactionId).toBe('txn-1');
  });

  it('should omit selectBy when the POST does not carry select_by', async () => {
    const result = await handleGoogleLoginRedirect({
      params: { credential: VALID_ID_TOKEN, g_csrf_token: CSRF },
      cookieHeader: `g_csrf_token=${CSRF}`,
      clientId: TEST_CLIENT_ID,
      verifier,
      nonceStore,
    });

    expect('selectBy' in result).toBe(false);
  });

  it('should consume the nonce so the same credential cannot be replayed', async () => {
    const context = {
      params: { credential: VALID_ID_TOKEN, g_csrf_token: CSRF },
      cookieHeader: `g_csrf_token=${CSRF}`,
      clientId: TEST_CLIENT_ID,
      verifier,
      nonceStore,
    };
    await handleGoogleLoginRedirect(context);

    const error = await captureRejection(handleGoogleLoginRedirect(context));

    expectGoogleLoginError(error, GoogleLoginErrorCode.LoginNonceNotFound, 400);
    expect(nonceStore.records.size).toBe(0);
  });

  // CSRF 検証は ID トークンに触れる前に行う: ライブラリの検証も nonce の消費も起きない
  it('should reject a POST without the CSRF cookie before touching the credential', async () => {
    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential: VALID_ID_TOKEN, g_csrf_token: CSRF },
        cookieHeader: 'session_id=abc',
        clientId: TEST_CLIENT_ID,
        verifier,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.CsrfTokenMissingInCookie, 400);
    expect(verifier.calls).toEqual([]);
    expect(nonceStore.records.size).toBe(1);
  });

  it('should reject a POST whose CSRF cookie and body differ', async () => {
    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential: VALID_ID_TOKEN, g_csrf_token: 'other' },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        verifier,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.CsrfTokenMismatch, 400);
    expect(verifier.calls).toEqual([]);
  });

  it('should reject a POST without credential', async () => {
    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        verifier,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.MissingCredential, 400);
  });

  // 検証を通らないトークンでは nonce を消費しない（ログイン試行の妨害を防ぐ）
  it('should reject a credential the library does not accept without consuming the nonce', async () => {
    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential: 'forged.id.token', g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        verifier,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidIdToken, 401);
    expect(nonceStore.records.size).toBe(1);
  });

  it('should surface a failure to fetch Google public keys as signing_key_unavailable', async () => {
    const unavailable = createFakeVerifier(() => {
      throw new GoogleLoginError(
        GoogleLoginErrorCode.SigningKeyUnavailable,
        'Failed to retrieve verification certificates: network down',
      );
    });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential: VALID_ID_TOKEN, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        verifier: unavailable,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.SigningKeyUnavailable, 503);
    expect(nonceStore.records.size).toBe(1);
  });

  it('should reject a credential without a nonce claim', async () => {
    issued = createGoogleIdTokenPayload({ nonce: undefined });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential: VALID_ID_TOKEN, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        verifier,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidNonce, 400);
  });

  it('should reject a credential whose nonce was not issued by this provider', async () => {
    issued = createGoogleIdTokenPayload({ nonce: 'forged-nonce' });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential: VALID_ID_TOKEN, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        verifier,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.LoginNonceNotFound, 400);
    expect(nonceStore.records.size).toBe(1);
  });

  it('should reject a login attempt whose nonce record has expired', async () => {
    const expiringNonce = await issueGoogleLoginNonce({
      transactionId: 'txn-2',
      expiresAt: Date.now() + 1_000,
      store: nonceStore,
    });
    issued = createGoogleIdTokenPayload({ nonce: expiringNonce });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential: VALID_ID_TOKEN, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        verifier,
        nonceStore,
        now: new Date(Date.now() + 2_000),
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.LoginNonceExpired, 400);
  });

  it('should enforce the hosted domain restriction', async () => {
    issued = createGoogleIdTokenPayload({ nonce, hd: 'other.example' });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential: VALID_ID_TOKEN, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        verifier,
        nonceStore,
        hostedDomain: 'example.com',
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidHostedDomain, 403);
    expect(nonceStore.records.size).toBe(1);
  });

  it('should require a verified email when requested', async () => {
    issued = createGoogleIdTokenPayload({ nonce, email_verified: false });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential: VALID_ID_TOKEN, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        verifier,
        nonceStore,
        requireVerifiedEmail: true,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.EmailNotVerified, 403);
  });
});
