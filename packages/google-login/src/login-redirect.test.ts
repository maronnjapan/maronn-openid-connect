import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createGoogleCertsKeyProvider, type GoogleCertsKeyProvider } from './certs.js';
import { GoogleLoginErrorCode } from './errors.js';
import { handleGoogleLoginRedirect } from './login-redirect.js';
import { issueGoogleLoginNonce } from './nonce.js';
import {
  captureRejection,
  createFakeFetch,
  createGoogleIdTokenPayload,
  createInMemoryNonceStore,
  createJwksResponse,
  expectGoogleLoginError,
  generateGoogleTestKey,
  signGoogleIdToken,
  TEST_CLIENT_ID,
  type FakeFetch,
  type GoogleTestKey,
  type InMemoryNonceStore,
} from './test-helpers.js';

const CSRF = 'g-csrf-token-value';

let key: GoogleTestKey;
let otherKey: GoogleTestKey;
let fake: FakeFetch;
let keyProvider: GoogleCertsKeyProvider;
let nonceStore: InMemoryNonceStore;
let nonce: string;

beforeAll(async () => {
  key = await generateGoogleTestKey('google-kid-1');
  otherKey = await generateGoogleTestKey('google-kid-2');
});

beforeEach(async () => {
  fake = createFakeFetch(() => createJwksResponse([key.jwk]));
  keyProvider = createGoogleCertsKeyProvider({ fetch: fake.fetch });
  nonceStore = createInMemoryNonceStore();
  nonce = await issueGoogleLoginNonce({
    transactionId: 'txn-1',
    expiresAt: Date.now() + 600_000,
    store: nonceStore,
  });
});

async function credentialWith(overrides: Record<string, unknown> = {}, signingKey: GoogleTestKey = key) {
  return signGoogleIdToken({
    key: signingKey,
    payload: createGoogleIdTokenPayload({ nonce, ...overrides }),
    header: { kid: key.kid },
  });
}

describe('handleGoogleLoginRedirect', () => {
  it('should return the transaction id and the verified account for a valid redirect POST', async () => {
    const credential = await credentialWith();

    const result = await handleGoogleLoginRedirect({
      params: { credential, g_csrf_token: CSRF, select_by: 'btn' },
      cookieHeader: `session_id=abc; g_csrf_token=${CSRF}`,
      clientId: TEST_CLIENT_ID,
      keyProvider,
      nonceStore,
    });

    expect(result).toMatchObject({
      transactionId: 'txn-1',
      selectBy: 'btn',
      account: {
        sub: '10769150350006150715113082367',
        email: 'jsmith@example.com',
        email_verified: true,
        nonce,
      },
      idToken: { header: { alg: 'RS256', kid: 'google-kid-1', typ: 'JWT' } },
    });
    expect(result.idToken.payload).toEqual(result.account);
  });

  it('should accept the POST body as FormData', async () => {
    const credential = await credentialWith();
    const form = new FormData();
    form.set('credential', credential);
    form.set('g_csrf_token', CSRF);

    const result = await handleGoogleLoginRedirect({
      params: form,
      cookieHeader: `g_csrf_token=${CSRF}`,
      clientId: TEST_CLIENT_ID,
      keyProvider,
      nonceStore,
    });

    expect(result.transactionId).toBe('txn-1');
  });

  it('should omit selectBy when the POST does not carry select_by', async () => {
    const credential = await credentialWith();

    const result = await handleGoogleLoginRedirect({
      params: { credential, g_csrf_token: CSRF },
      cookieHeader: `g_csrf_token=${CSRF}`,
      clientId: TEST_CLIENT_ID,
      keyProvider,
      nonceStore,
    });

    expect('selectBy' in result).toBe(false);
  });

  it('should consume the nonce so the same credential cannot be replayed', async () => {
    const credential = await credentialWith();
    const context = {
      params: { credential, g_csrf_token: CSRF },
      cookieHeader: `g_csrf_token=${CSRF}`,
      clientId: TEST_CLIENT_ID,
      keyProvider,
      nonceStore,
    };
    await handleGoogleLoginRedirect(context);

    const error = await captureRejection(handleGoogleLoginRedirect(context));

    expectGoogleLoginError(error, GoogleLoginErrorCode.LoginNonceNotFound, 400);
    expect(nonceStore.records.size).toBe(0);
  });

  // CSRF 検証は ID トークンに触れる前に行う: Google の鍵取得も nonce の消費も起きない
  it('should reject a POST without the CSRF cookie before touching the credential', async () => {
    const credential = await credentialWith();

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential, g_csrf_token: CSRF },
        cookieHeader: 'session_id=abc',
        clientId: TEST_CLIENT_ID,
        keyProvider,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.CsrfTokenMissingInCookie, 400);
    expect(fake.calls.length).toBe(0);
    expect(nonceStore.records.size).toBe(1);
  });

  it('should reject a POST whose CSRF cookie and body differ', async () => {
    const credential = await credentialWith();

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential, g_csrf_token: 'other' },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        keyProvider,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.CsrfTokenMismatch, 400);
  });

  it('should reject a POST without credential', async () => {
    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        keyProvider,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.MissingCredential, 400);
  });

  // 署名検証を通さないトークンでは nonce を消費しない（ログイン試行の妨害を防ぐ）
  it('should reject a credential with an invalid signature without consuming the nonce', async () => {
    const credential = await credentialWith({}, otherKey);

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        keyProvider,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidSignature, 401);
    expect(nonceStore.records.size).toBe(1);
  });

  it('should reject a credential issued to another client', async () => {
    const credential = await credentialWith({ aud: 'attacker.apps.googleusercontent.com' });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        keyProvider,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidAudience, 401);
  });

  it('should reject an expired credential', async () => {
    const credential = await credentialWith({ iat: 1_600_000_000, exp: 1_600_003_600 });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        keyProvider,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.IdTokenExpired, 401);
  });

  it('should reject a credential without a nonce claim', async () => {
    const credential = await credentialWith({ nonce: undefined });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        keyProvider,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidNonce, 400);
  });

  it('should reject a credential whose nonce was not issued by this provider', async () => {
    const credential = await credentialWith({ nonce: 'forged-nonce' });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        keyProvider,
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
    const credential = await credentialWith({ nonce: expiringNonce });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        keyProvider,
        nonceStore,
        now: new Date(Date.now() + 2_000),
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.LoginNonceExpired, 400);
  });

  it('should enforce the hosted domain restriction', async () => {
    const credential = await credentialWith({ hd: 'other.example' });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        keyProvider,
        nonceStore,
        hostedDomain: 'example.com',
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidHostedDomain, 403);
  });

  it('should require a verified email when requested', async () => {
    const credential = await credentialWith({ email_verified: false });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        keyProvider,
        nonceStore,
        requireVerifiedEmail: true,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.EmailNotVerified, 403);
  });

  it('should surface a failure to fetch Google public keys as signing_key_unavailable', async () => {
    const credential = await credentialWith();
    const failing = createGoogleCertsKeyProvider({
      fetch: async () => createJwksResponse([], { status: 502 }),
    });

    const error = await captureRejection(
      handleGoogleLoginRedirect({
        params: { credential, g_csrf_token: CSRF },
        cookieHeader: `g_csrf_token=${CSRF}`,
        clientId: TEST_CLIENT_ID,
        keyProvider: failing,
        nonceStore,
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.SigningKeyUnavailable, 503);
  });
});
