import { beforeAll, describe, expect, it } from 'vitest';

import { createStaticGoogleSigningKeyProvider, type GoogleSigningKeyProvider } from './certs.js';
import { GoogleLoginErrorCode } from './errors.js';
import {
  DEFAULT_GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS,
  decodeGoogleIdToken,
  resolveGoogleSigningKey,
  validateGoogleEmailVerified,
  validateGoogleHostedDomain,
  validateGoogleIdTokenAudience,
  validateGoogleIdTokenExpiration,
  validateGoogleIdTokenIssuer,
  validateGoogleIdTokenNonce,
  verifyGoogleIdToken,
  verifyGoogleIdTokenSignature,
  type GoogleIdTokenPayload,
} from './id-token.js';
import {
  base64UrlEncodeJson,
  captureRejection,
  captureThrow,
  createGoogleIdTokenPayload,
  expectGoogleLoginError,
  generateGoogleTestKey,
  nowSeconds,
  signGoogleIdToken,
  TEST_CLIENT_ID,
  type GoogleTestKey,
} from './test-helpers.js';

let key: GoogleTestKey;
let otherKey: GoogleTestKey;
let keyProvider: GoogleSigningKeyProvider;

beforeAll(async () => {
  key = await generateGoogleTestKey('google-kid-1');
  otherKey = await generateGoogleTestKey('google-kid-2');
  keyProvider = createStaticGoogleSigningKeyProvider([key.jwk]);
});

function payloadOf(overrides: Record<string, unknown> = {}): GoogleIdTokenPayload {
  return createGoogleIdTokenPayload(overrides) as unknown as GoogleIdTokenPayload;
}

describe('decodeGoogleIdToken', () => {
  it('should return the header and payload of a well-formed token', async () => {
    const payload = createGoogleIdTokenPayload();
    const token = await signGoogleIdToken({ key, payload });

    const decoded = decodeGoogleIdToken(token);

    expect(decoded.header).toEqual({ alg: 'RS256', kid: 'google-kid-1', typ: 'JWT' });
    expect(decoded.payload).toEqual(payload);
    expect(decoded.signingInput).toBe(token.split('.').slice(0, 2).join('.'));
    expect(decoded.signature.byteLength).toBe(256);
  });

  it('should reject an empty string', () => {
    const error = captureThrow(() => decodeGoogleIdToken(''));

    expectGoogleLoginError(error, GoogleLoginErrorCode.MalformedIdToken, 401);
  });

  // RFC 8725 §3.1 / §3.2: alg none や HMAC 系へのすり替えは鍵に触れる前に拒否する
  it('should reject alg none', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload(), header: { alg: 'none' } });

    const error = captureThrow(() => decodeGoogleIdToken(token));

    expectGoogleLoginError(error, GoogleLoginErrorCode.UnsupportedAlgorithm, 401);
  });

  it('should reject alg HS256', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload(), header: { alg: 'HS256' } });

    const error = captureThrow(() => decodeGoogleIdToken(token));

    expectGoogleLoginError(error, GoogleLoginErrorCode.UnsupportedAlgorithm, 401);
  });

  it('should reject a header without kid', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload(), header: { kid: undefined } });

    const error = captureThrow(() => decodeGoogleIdToken(token));

    expectGoogleLoginError(error, GoogleLoginErrorCode.MalformedIdToken, 401);
  });

  it('should reject a typ other than JWT', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload(), header: { typ: 'at+jwt' } });

    const error = captureThrow(() => decodeGoogleIdToken(token));

    expectGoogleLoginError(error, GoogleLoginErrorCode.MalformedIdToken, 401);
  });

  it('should accept a token without typ', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload(), header: { typ: undefined } });

    expect(decodeGoogleIdToken(token).header).toEqual({ alg: 'RS256', kid: 'google-kid-1' });
  });

  it('should accept typ in any letter case', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload(), header: { typ: 'jwt' } });

    expect(decodeGoogleIdToken(token).header.typ).toBe('jwt');
  });

  it.each([
    ['iss', { iss: undefined }],
    ['sub', { sub: '' }],
    ['aud', { aud: [] }],
    ['exp', { exp: '1700000000' }],
    ['iat', { iat: undefined }],
  ])('should reject a payload with a missing or malformed %s claim', async (_claim, overrides) => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload(overrides) });

    const error = captureThrow(() => decodeGoogleIdToken(token));

    expectGoogleLoginError(error, GoogleLoginErrorCode.MalformedIdToken, 401);
  });

  it('should accept aud as an array of client IDs', async () => {
    const token = await signGoogleIdToken({
      key,
      payload: createGoogleIdTokenPayload({ aud: [TEST_CLIENT_ID, 'other-client'] }),
    });

    expect(decodeGoogleIdToken(token).payload.aud).toEqual([TEST_CLIENT_ID, 'other-client']);
  });
});

describe('resolveGoogleSigningKey', () => {
  it('should return the key matching the header kid', async () => {
    expect(await resolveGoogleSigningKey({ alg: 'RS256', kid: 'google-kid-1' }, keyProvider)).toEqual(key.jwk);
  });

  it('should throw unknown_signing_key when no key matches', async () => {
    const error = await captureRejection(
      resolveGoogleSigningKey({ alg: 'RS256', kid: 'rotated-away' }, keyProvider),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.UnknownSigningKey, 401);
  });
});

describe('verifyGoogleIdTokenSignature', () => {
  it('should accept a token signed with the matching key', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload() });

    await expect(verifyGoogleIdTokenSignature(decodeGoogleIdToken(token), key.jwk)).resolves.toBeUndefined();
  });

  it('should reject a token whose payload was altered after signing', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload() });
    const [header, , signature] = token.split('.');
    const tampered = `${header}.${base64UrlEncodeJson(createGoogleIdTokenPayload({ sub: 'attacker' }))}.${signature}`;

    const error = await captureRejection(verifyGoogleIdTokenSignature(decodeGoogleIdToken(tampered), key.jwk));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidSignature, 401);
  });

  it('should reject a token signed with a different key that reuses the kid', async () => {
    const token = await signGoogleIdToken({
      key: otherKey,
      payload: createGoogleIdTokenPayload(),
      header: { kid: key.kid },
    });

    const error = await captureRejection(verifyGoogleIdTokenSignature(decodeGoogleIdToken(token), key.jwk));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidSignature, 401);
  });

  it('should reject a public key that is not RSA', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload() });

    const error = await captureRejection(
      verifyGoogleIdTokenSignature(decodeGoogleIdToken(token), { kid: key.kid, kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.UnsupportedAlgorithm, 401);
  });

  it('should reject a public key that declares an alg other than RS256', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload() });

    const error = await captureRejection(
      verifyGoogleIdTokenSignature(decodeGoogleIdToken(token), { ...key.jwk, alg: 'RS512' }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.UnsupportedAlgorithm, 401);
  });
});

describe('validateGoogleIdTokenAudience', () => {
  it('should accept aud equal to the client ID', () => {
    expect(() => validateGoogleIdTokenAudience(payloadOf(), TEST_CLIENT_ID)).not.toThrow();
  });

  it('should accept aud matching one of several client IDs', () => {
    expect(() =>
      validateGoogleIdTokenAudience(payloadOf(), ['android-client', TEST_CLIENT_ID]),
    ).not.toThrow();
  });

  it('should accept an aud array that contains the client ID', () => {
    expect(() =>
      validateGoogleIdTokenAudience(payloadOf({ aud: ['other', TEST_CLIENT_ID] }), TEST_CLIENT_ID),
    ).not.toThrow();
  });

  // 攻撃者のアプリに発行された ID トークンで同じユーザーのデータへアクセスされるのを防ぐ
  it('should reject aud issued to another application', () => {
    const error = captureThrow(() =>
      validateGoogleIdTokenAudience(payloadOf({ aud: 'attacker.apps.googleusercontent.com' }), TEST_CLIENT_ID),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidAudience, 401);
  });

  it('should throw a TypeError when no client ID is configured', () => {
    expect(() => validateGoogleIdTokenAudience(payloadOf(), [])).toThrow(TypeError);
  });

  it('should throw a TypeError when the client ID is an empty string', () => {
    expect(() => validateGoogleIdTokenAudience(payloadOf(), '')).toThrow(TypeError);
  });
});

describe('validateGoogleIdTokenIssuer', () => {
  it('should accept https://accounts.google.com', () => {
    expect(() => validateGoogleIdTokenIssuer(payloadOf({ iss: 'https://accounts.google.com' }))).not.toThrow();
  });

  it('should accept accounts.google.com without a scheme', () => {
    expect(() => validateGoogleIdTokenIssuer(payloadOf({ iss: 'accounts.google.com' }))).not.toThrow();
  });

  it('should reject an issuer with a trailing slash', () => {
    const error = captureThrow(() => validateGoogleIdTokenIssuer(payloadOf({ iss: 'https://accounts.google.com/' })));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidIssuer, 401);
  });

  it('should reject another issuer', () => {
    const error = captureThrow(() => validateGoogleIdTokenIssuer(payloadOf({ iss: 'https://accounts.example.com' })));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidIssuer, 401);
  });
});

describe('validateGoogleIdTokenExpiration', () => {
  const now = new Date(1_700_000_000_000);
  const nowSec = 1_700_000_000;

  it('should accept a token that expires in the future', () => {
    expect(() =>
      validateGoogleIdTokenExpiration(payloadOf({ iat: nowSec - 10, exp: nowSec + 3600 }), { now }),
    ).not.toThrow();
  });

  it('should reject a token whose exp has passed by more than the clock skew', () => {
    const error = captureThrow(() =>
      validateGoogleIdTokenExpiration(
        payloadOf({ iat: nowSec - 7200, exp: nowSec - DEFAULT_GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS }),
        { now },
      ),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.IdTokenExpired, 401);
  });

  it('should accept a token that expired within the clock skew', () => {
    expect(() =>
      validateGoogleIdTokenExpiration(
        payloadOf({ iat: nowSec - 7200, exp: nowSec - DEFAULT_GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS + 1 }),
        { now },
      ),
    ).not.toThrow();
  });

  it('should honor a custom clock skew', () => {
    const error = captureThrow(() =>
      validateGoogleIdTokenExpiration(payloadOf({ iat: nowSec - 10, exp: nowSec }), { now, clockSkewSeconds: 0 }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.IdTokenExpired, 401);
  });

  it('should reject a token whose nbf is in the future beyond the clock skew', () => {
    const error = captureThrow(() =>
      validateGoogleIdTokenExpiration(
        payloadOf({ iat: nowSec, exp: nowSec + 3600, nbf: nowSec + DEFAULT_GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS + 1 }),
        { now },
      ),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.IdTokenNotYetValid, 401);
  });

  it('should accept a token whose nbf is within the clock skew', () => {
    expect(() =>
      validateGoogleIdTokenExpiration(
        payloadOf({ iat: nowSec, exp: nowSec + 3600, nbf: nowSec + DEFAULT_GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS }),
        { now },
      ),
    ).not.toThrow();
  });

  // google-auth-library の "Token used too early" と同じ判定
  it('should reject a token issued in the future beyond the clock skew', () => {
    const error = captureThrow(() =>
      validateGoogleIdTokenExpiration(
        payloadOf({ iat: nowSec + DEFAULT_GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS + 1, exp: nowSec + 3600 }),
        { now },
      ),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.IdTokenNotYetValid, 401);
  });

  it('should use the current time when now is omitted', () => {
    expect(() =>
      validateGoogleIdTokenExpiration(payloadOf({ iat: nowSeconds(), exp: nowSeconds() + 60 })),
    ).not.toThrow();
  });
});

describe('validateGoogleHostedDomain', () => {
  it('should not check hd when no hosted domain is configured', () => {
    expect(() => validateGoogleHostedDomain(payloadOf({ hd: undefined }))).not.toThrow();
  });

  it('should accept hd equal to the configured domain', () => {
    expect(() => validateGoogleHostedDomain(payloadOf({ hd: 'example.com' }), 'example.com')).not.toThrow();
  });

  it('should accept hd matching one of several domains', () => {
    expect(() =>
      validateGoogleHostedDomain(payloadOf({ hd: 'example.org' }), ['example.com', 'example.org']),
    ).not.toThrow();
  });

  it('should reject hd of another domain', () => {
    const error = captureThrow(() => validateGoogleHostedDomain(payloadOf({ hd: 'evil.example' }), 'example.com'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidHostedDomain, 403);
  });

  it('should reject a token without hd when a domain is required', () => {
    const error = captureThrow(() => validateGoogleHostedDomain(payloadOf({ hd: undefined }), 'example.com'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidHostedDomain, 403);
  });
});

describe('validateGoogleEmailVerified', () => {
  it('should accept email_verified true', () => {
    expect(() => validateGoogleEmailVerified(payloadOf({ email_verified: true }))).not.toThrow();
  });

  it('should reject email_verified false', () => {
    const error = captureThrow(() => validateGoogleEmailVerified(payloadOf({ email_verified: false })));

    expectGoogleLoginError(error, GoogleLoginErrorCode.EmailNotVerified, 403);
  });

  it('should reject a token without email_verified', () => {
    const error = captureThrow(() => validateGoogleEmailVerified(payloadOf({ email_verified: undefined })));

    expectGoogleLoginError(error, GoogleLoginErrorCode.EmailNotVerified, 403);
  });

  it('should reject the string "true"', () => {
    const error = captureThrow(() => validateGoogleEmailVerified(payloadOf({ email_verified: 'true' })));

    expectGoogleLoginError(error, GoogleLoginErrorCode.EmailNotVerified, 403);
  });
});

describe('validateGoogleIdTokenNonce', () => {
  it('should not check nonce when no expected value is given', () => {
    expect(() => validateGoogleIdTokenNonce(payloadOf({ nonce: undefined }))).not.toThrow();
  });

  it('should accept a nonce equal to the expected value', () => {
    expect(() => validateGoogleIdTokenNonce(payloadOf({ nonce: 'n-1' }), 'n-1')).not.toThrow();
  });

  it('should reject a nonce that differs from the expected value', () => {
    const error = captureThrow(() => validateGoogleIdTokenNonce(payloadOf({ nonce: 'n-2' }), 'n-1'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidNonce, 400);
  });

  it('should reject a token without nonce when a value is expected', () => {
    const error = captureThrow(() => validateGoogleIdTokenNonce(payloadOf({ nonce: undefined }), 'n-1'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidNonce, 400);
  });
});

describe('verifyGoogleIdToken', () => {
  it('should return the verified header and payload', async () => {
    const payload = createGoogleIdTokenPayload({ nonce: 'n-1', hd: 'example.com' });
    const token = await signGoogleIdToken({ key, payload });

    const verified = await verifyGoogleIdToken(token, {
      clientId: TEST_CLIENT_ID,
      keyProvider,
      hostedDomain: 'example.com',
      requireVerifiedEmail: true,
      expectedNonce: 'n-1',
    });

    expect(verified).toEqual({
      header: { alg: 'RS256', kid: 'google-kid-1', typ: 'JWT' },
      payload,
    });
  });

  // Google のドキュメントの順序: 署名 → aud → iss → exp → hd
  it('should verify the signature before reading any claim', async () => {
    const token = await signGoogleIdToken({
      key: otherKey,
      payload: createGoogleIdTokenPayload({ aud: 'wrong', iss: 'wrong', exp: 1 }),
      header: { kid: key.kid },
    });

    const error = await captureRejection(verifyGoogleIdToken(token, { clientId: TEST_CLIENT_ID, keyProvider }));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidSignature, 401);
  });

  it('should check aud before iss', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload({ aud: 'wrong', iss: 'wrong' }) });

    const error = await captureRejection(verifyGoogleIdToken(token, { clientId: TEST_CLIENT_ID, keyProvider }));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidAudience, 401);
  });

  it('should check iss before exp', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload({ iss: 'wrong', exp: 1 }) });

    const error = await captureRejection(verifyGoogleIdToken(token, { clientId: TEST_CLIENT_ID, keyProvider }));

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidIssuer, 401);
  });

  it('should check exp before hd', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload({ exp: 1, hd: 'wrong' }) });

    const error = await captureRejection(
      verifyGoogleIdToken(token, { clientId: TEST_CLIENT_ID, keyProvider, hostedDomain: 'example.com' }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.IdTokenExpired, 401);
  });

  it('should reject a token signed by an unknown key', async () => {
    const token = await signGoogleIdToken({ key: otherKey, payload: createGoogleIdTokenPayload() });

    const error = await captureRejection(verifyGoogleIdToken(token, { clientId: TEST_CLIENT_ID, keyProvider }));

    expectGoogleLoginError(error, GoogleLoginErrorCode.UnknownSigningKey, 401);
  });

  it('should apply the hosted domain restriction', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload({ hd: 'other.example' }) });

    const error = await captureRejection(
      verifyGoogleIdToken(token, { clientId: TEST_CLIENT_ID, keyProvider, hostedDomain: 'example.com' }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidHostedDomain, 403);
  });

  it('should not require a verified email by default', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload({ email_verified: false }) });

    await expect(verifyGoogleIdToken(token, { clientId: TEST_CLIENT_ID, keyProvider })).resolves.toBeDefined();
  });

  it('should require a verified email when requested', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload({ email_verified: false }) });

    const error = await captureRejection(
      verifyGoogleIdToken(token, { clientId: TEST_CLIENT_ID, keyProvider, requireVerifiedEmail: true }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.EmailNotVerified, 403);
  });

  it('should apply the expected nonce', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload({ nonce: 'n-2' }) });

    const error = await captureRejection(
      verifyGoogleIdToken(token, { clientId: TEST_CLIENT_ID, keyProvider, expectedNonce: 'n-1' }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.InvalidNonce, 400);
  });

  it('should evaluate expiration against the given now', async () => {
    const token = await signGoogleIdToken({ key, payload: createGoogleIdTokenPayload() });

    const error = await captureRejection(
      verifyGoogleIdToken(token, {
        clientId: TEST_CLIENT_ID,
        keyProvider,
        now: new Date(Date.now() + 2 * 3600 * 1000),
      }),
    );

    expectGoogleLoginError(error, GoogleLoginErrorCode.IdTokenExpired, 401);
  });
});
