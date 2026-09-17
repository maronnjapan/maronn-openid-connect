import { OAuth2Client } from 'google-auth-library';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GoogleLoginErrorCode } from './errors.js';
import {
  createGoogleIdTokenVerifier,
  getDefaultGoogleIdTokenVerifier,
  validateGoogleEmailVerified,
  validateGoogleHostedDomain,
  validateGoogleIdTokenNonce,
  verifyGoogleIdToken,
  type GoogleIdTokenVerifier,
} from './id-token.js';
import {
  captureRejection,
  captureThrow,
  createFakeVerifier,
  createGoogleIdTokenPayload,
  expectGoogleLoginError,
  generateGoogleTestKey,
  nowSeconds,
  signGoogleIdToken,
  startCertsServer,
  TEST_CLIENT_ID,
  type CertsServer,
  type GoogleTestKey,
} from './test-helpers.js';

let key: GoogleTestKey;
let otherKey: GoogleTestKey;
let certs: CertsServer;
let verifier: GoogleIdTokenVerifier;

beforeAll(async () => {
  key = generateGoogleTestKey('google-kid-1');
  otherKey = generateGoogleTestKey('google-kid-2');
  certs = await startCertsServer([key]);
  verifier = createGoogleIdTokenVerifier({ clientOptions: certs.clientOptions });
});

afterAll(async () => {
  await certs.close();
});

// google-auth-library の verifyIdToken を、公開鍵の取得先だけローカルサーバーに向けて実行する。
// 検証ルール（署名 → aud → iss → exp）はライブラリのものなので、ここではライブラリの拒否が
// GoogleLoginError に写ることと、検証を通ったペイロードがそのまま返ることを確認する。
describe('createGoogleIdTokenVerifier', () => {
  it('should return the payload of a token signed with a Google key', async () => {
    const payload = createGoogleIdTokenPayload();
    const idToken = signGoogleIdToken({ key, payload });

    expect(await verifier.verify(idToken, TEST_CLIENT_ID)).toEqual(payload);
  });

  it('should fetch the certificates from the configured endpoint', async () => {
    const server = await startCertsServer([key]);
    try {
      const local = createGoogleIdTokenVerifier({ clientOptions: server.clientOptions });

      await local.verify(signGoogleIdToken({ key, payload: createGoogleIdTokenPayload() }), TEST_CLIENT_ID);

      expect(server.hits).toEqual(['/oauth2/v1/certs']);
    } finally {
      await server.close();
    }
  });

  // Google のドキュメント: 鍵はローテーションされるので Cache-Control を見て再取得する。
  // その追随はライブラリ側の責務で、ここでは max-age の間は取り直さないことだけを確認する。
  it('should reuse the cached certificates while max-age has not elapsed', async () => {
    const server = await startCertsServer([key], { maxAge: 3600 });
    try {
      const local = createGoogleIdTokenVerifier({ clientOptions: server.clientOptions });

      await local.verify(signGoogleIdToken({ key, payload: createGoogleIdTokenPayload() }), TEST_CLIENT_ID);
      await local.verify(signGoogleIdToken({ key, payload: createGoogleIdTokenPayload() }), TEST_CLIENT_ID);

      expect(server.hits.length).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('should use a provided OAuth2Client', async () => {
    const server = await startCertsServer([key]);
    try {
      const client = new OAuth2Client(server.clientOptions);
      const local = createGoogleIdTokenVerifier({ client });

      await local.verify(signGoogleIdToken({ key, payload: createGoogleIdTokenPayload() }), TEST_CLIENT_ID);

      expect(server.hits.length).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('should accept a token whose aud matches one of several client IDs', async () => {
    const idToken = signGoogleIdToken({ key, payload: createGoogleIdTokenPayload() });

    const payload = await verifier.verify(idToken, ['android-client', TEST_CLIENT_ID]);

    expect(payload.aud).toBe(TEST_CLIENT_ID);
  });

  // 攻撃者のアプリに発行された ID トークンで同じユーザーのデータへアクセスされるのを防ぐ
  it('should reject a token issued to another application', async () => {
    const idToken = signGoogleIdToken({
      key,
      payload: createGoogleIdTokenPayload({ aud: 'attacker.apps.googleusercontent.com' }),
    });

    const error = await captureRejection(verifier.verify(idToken, TEST_CLIENT_ID));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidIdToken, 401);
    expect((error as Error).message).toContain('Wrong recipient');
  });

  it('should reject a token from another issuer', async () => {
    const idToken = signGoogleIdToken({ key, payload: createGoogleIdTokenPayload({ iss: 'https://accounts.example.com' }) });

    const error = await captureRejection(verifier.verify(idToken, TEST_CLIENT_ID));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidIdToken, 401);
    expect((error as Error).message).toContain('Invalid issuer');
  });

  it('should accept accounts.google.com without a scheme as issuer', async () => {
    const idToken = signGoogleIdToken({ key, payload: createGoogleIdTokenPayload({ iss: 'accounts.google.com' }) });

    expect((await verifier.verify(idToken, TEST_CLIENT_ID)).iss).toBe('accounts.google.com');
  });

  it('should reject an expired token', async () => {
    const idToken = signGoogleIdToken({
      key,
      payload: createGoogleIdTokenPayload({ iat: nowSeconds() - 7200, exp: nowSeconds() - 3600 }),
    });

    const error = await captureRejection(verifier.verify(idToken, TEST_CLIENT_ID));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidIdToken, 401);
    expect((error as Error).message).toContain('Token used too late');
  });

  it('should reject a token issued in the future', async () => {
    const idToken = signGoogleIdToken({
      key,
      payload: createGoogleIdTokenPayload({ iat: nowSeconds() + 3600, exp: nowSeconds() + 7200 }),
    });

    const error = await captureRejection(verifier.verify(idToken, TEST_CLIENT_ID));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidIdToken, 401);
    expect((error as Error).message).toContain('Token used too early');
  });

  it('should reject a token signed with a different key that reuses the kid', async () => {
    const idToken = signGoogleIdToken({ key: otherKey, payload: createGoogleIdTokenPayload(), header: { kid: key.kid } });

    const error = await captureRejection(verifier.verify(idToken, TEST_CLIENT_ID));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidIdToken, 401);
    expect((error as Error).message).toContain('Invalid token signature');
  });

  it('should reject a token signed with an unknown key', async () => {
    const idToken = signGoogleIdToken({ key: otherKey, payload: createGoogleIdTokenPayload() });

    const error = await captureRejection(verifier.verify(idToken, TEST_CLIENT_ID));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidIdToken, 401);
    expect((error as Error).message).toContain('No pem found for envelope');
  });

  it('should reject a token that is not a JWS', async () => {
    const error = await captureRejection(verifier.verify('not-a-jwt', TEST_CLIENT_ID));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidIdToken, 401);
    expect((error as Error).message).toContain('Wrong number of segments');
  });

  it('should reject an empty token without calling the library', async () => {
    const server = await startCertsServer([key]);
    try {
      const local = createGoogleIdTokenVerifier({ clientOptions: server.clientOptions });

      const error = await captureRejection(local.verify('', TEST_CLIENT_ID));

      expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidIdToken, 401);
      expect(server.hits).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('should keep the library error as cause', async () => {
    const idToken = signGoogleIdToken({ key, payload: createGoogleIdTokenPayload({ aud: 'wrong' }) });

    const error = (await captureRejection(verifier.verify(idToken, TEST_CLIENT_ID))) as Error;

    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe(error.message);
  });

  it('should throw a TypeError when no client ID is configured', async () => {
    const idToken = signGoogleIdToken({ key, payload: createGoogleIdTokenPayload() });

    await expect(verifier.verify(idToken, [])).rejects.toThrow(TypeError);
  });

  it('should report signing_key_unavailable when the certificates cannot be fetched', async () => {
    // 404 は gaxios がリトライしないステータスなので、待ち時間なしで失敗する
    const server = await startCertsServer([key], { status: 404 });
    try {
      const local = createGoogleIdTokenVerifier({ clientOptions: server.clientOptions });
      const idToken = signGoogleIdToken({ key, payload: createGoogleIdTokenPayload() });

      const error = await captureRejection(local.verify(idToken, TEST_CLIENT_ID));

      expectGoogleLoginError(error, GoogleLoginErrorCode.SigningKeyUnavailable, 503);
      expect((error as Error).message).toContain('Failed to retrieve verification certificates');
      expect((error as Error).cause).toBeInstanceOf(Error);
    } finally {
      await server.close();
    }
  });
});

describe('getDefaultGoogleIdTokenVerifier', () => {
  it('should return the same instance on every call', () => {
    expect(getDefaultGoogleIdTokenVerifier()).toBe(getDefaultGoogleIdTokenVerifier());
  });
});

describe('validateGoogleHostedDomain', () => {
  it('should not check hd when no hosted domain is configured', () => {
    expect(() => validateGoogleHostedDomain(createGoogleIdTokenPayload({ hd: undefined }))).not.toThrow();
  });

  it('should accept hd equal to the configured domain', () => {
    expect(() => validateGoogleHostedDomain(createGoogleIdTokenPayload({ hd: 'example.com' }), 'example.com')).not.toThrow();
  });

  it('should accept hd matching one of several domains', () => {
    expect(() =>
      validateGoogleHostedDomain(createGoogleIdTokenPayload({ hd: 'example.org' }), ['example.com', 'example.org']),
    ).not.toThrow();
  });

  it('should reject hd of another domain', () => {
    const error = captureThrow(() =>
      validateGoogleHostedDomain(createGoogleIdTokenPayload({ hd: 'evil.example' }), 'example.com'),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidHostedDomain, 403);
  });

  it('should reject a token without hd when a domain is required', () => {
    const error = captureThrow(() =>
      validateGoogleHostedDomain(createGoogleIdTokenPayload({ hd: undefined }), 'example.com'),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidHostedDomain, 403);
  });

  it('should throw a TypeError when the hosted domain list is empty', () => {
    expect(() => validateGoogleHostedDomain(createGoogleIdTokenPayload({ hd: 'example.com' }), [])).toThrow(TypeError);
  });
});

describe('validateGoogleEmailVerified', () => {
  it('should accept email_verified true', () => {
    expect(() => validateGoogleEmailVerified(createGoogleIdTokenPayload({ email_verified: true }))).not.toThrow();
  });

  it('should reject email_verified false', () => {
    const error = captureThrow(() => validateGoogleEmailVerified(createGoogleIdTokenPayload({ email_verified: false })));

    expectGoogleLoginError(error, GoogleLoginErrorCode.EmailNotVerified, 403);
  });

  it('should reject a token without email_verified', () => {
    const error = captureThrow(() =>
      validateGoogleEmailVerified(createGoogleIdTokenPayload({ email_verified: undefined })),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.EmailNotVerified, 403);
  });

  it('should reject the string "true"', () => {
    const error = captureThrow(() => validateGoogleEmailVerified(createGoogleIdTokenPayload({ email_verified: 'true' })));

    expectGoogleLoginError(error, GoogleLoginErrorCode.EmailNotVerified, 403);
  });
});

describe('validateGoogleIdTokenNonce', () => {
  it('should not check nonce when no expected value is given', () => {
    expect(() => validateGoogleIdTokenNonce(createGoogleIdTokenPayload({ nonce: undefined }))).not.toThrow();
  });

  it('should accept a nonce equal to the expected value', () => {
    expect(() => validateGoogleIdTokenNonce(createGoogleIdTokenPayload({ nonce: 'n-1' }), 'n-1')).not.toThrow();
  });

  it('should reject a nonce that differs from the expected value', () => {
    const error = captureThrow(() => validateGoogleIdTokenNonce(createGoogleIdTokenPayload({ nonce: 'n-2' }), 'n-1'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidNonce, 400);
  });

  it('should reject a token without nonce when a value is expected', () => {
    const error = captureThrow(() => validateGoogleIdTokenNonce(createGoogleIdTokenPayload({ nonce: undefined }), 'n-1'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidNonce, 400);
  });
});

describe('verifyGoogleIdToken', () => {
  it('should return the payload verified by google-auth-library', async () => {
    const payload = createGoogleIdTokenPayload({ nonce: 'n-1', hd: 'example.com' });
    const idToken = signGoogleIdToken({ key, payload });

    const verified = await verifyGoogleIdToken(idToken, {
      clientId: TEST_CLIENT_ID,
      verifier,
      hostedDomain: 'example.com',
      requireVerifiedEmail: true,
      expectedNonce: 'n-1',
    });

    expect(verified).toEqual(payload);
  });

  it('should pass the token and the client IDs to the verifier', async () => {
    const fake = createFakeVerifier(() => createGoogleIdTokenPayload());

    await verifyGoogleIdToken('id-token', { clientId: ['a', 'b'], verifier: fake });

    expect(fake.calls).toEqual([{ idToken: 'id-token', clientId: ['a', 'b'] }]);
  });

  it('should propagate the verifier rejection before the optional checks', async () => {
    const fake = createFakeVerifier(() => {
      throw new TypeError('verifier failed');
    });

    await expect(
      verifyGoogleIdToken('id-token', { clientId: TEST_CLIENT_ID, verifier: fake, hostedDomain: 'example.com' }),
    ).rejects.toThrow('verifier failed');
  });

  it('should apply the hosted domain restriction', async () => {
    const fake = createFakeVerifier(() => createGoogleIdTokenPayload({ hd: 'other.example' }));

    const error = await captureRejection(
      verifyGoogleIdToken('id-token', { clientId: TEST_CLIENT_ID, verifier: fake, hostedDomain: 'example.com' }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidHostedDomain, 403);
  });

  it('should not require a verified email by default', async () => {
    const fake = createFakeVerifier(() => createGoogleIdTokenPayload({ email_verified: false }));

    await expect(verifyGoogleIdToken('id-token', { clientId: TEST_CLIENT_ID, verifier: fake })).resolves.toBeDefined();
  });

  it('should require a verified email when requested', async () => {
    const fake = createFakeVerifier(() => createGoogleIdTokenPayload({ email_verified: false }));

    const error = await captureRejection(
      verifyGoogleIdToken('id-token', { clientId: TEST_CLIENT_ID, verifier: fake, requireVerifiedEmail: true }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.EmailNotVerified, 403);
  });

  it('should apply the expected nonce', async () => {
    const fake = createFakeVerifier(() => createGoogleIdTokenPayload({ nonce: 'n-2' }));

    const error = await captureRejection(
      verifyGoogleIdToken('id-token', { clientId: TEST_CLIENT_ID, verifier: fake, expectedNonce: 'n-1' }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidNonce, 400);
  });
});
