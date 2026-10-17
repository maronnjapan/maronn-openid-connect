/**
 * private_key_jwt のクライアントアサーション検証のテスト。
 * OIDC Core 1.0 §9 / RFC 7523 §3 / RFC 7521 §4.2
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  CLIENT_ASSERTION_TYPE_JWT_BEARER,
  DEFAULT_CLIENT_ASSERTION_SIGNING_ALGS,
  decodeClientAssertion,
  readClientAssertionSubject,
  rejectReplayedClientAssertion,
  validateClientAssertionAudience,
  validateClientAssertionHeader,
  verifyClientAssertion,
  type ClientAssertionJtiStore,
  type VerifyClientAssertionOptions,
} from './client-assertion.js';
import { arrayBufferToBase64Url, stringToArrayBuffer } from './crypto-utils.js';
import type { Jwk } from './jwks.js';
import { signJwt } from './jwt.js';
import { TokenError, TokenErrorCode } from './token-error.js';

const CLIENT_ID = 'client-pkjwt';
const ISSUER = 'https://op.example.com';
const TOKEN_ENDPOINT = 'https://op.example.com/token';
const NOW = 1_800_000_000;

interface KeyPair {
  privateKey: CryptoKey;
  publicJwk: Jwk;
}

let rs256: KeyPair;
let rs256Other: KeyPair;
let rs384: KeyPair;
let rs1024: KeyPair;
let es256: KeyPair;
let es384: KeyPair;

async function generateRsaKeyPair(
  kid: string,
  alg: string,
  hash: 'SHA-256' | 'SHA-384',
  modulusLength = 2048,
): Promise<KeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash },
    true,
    ['sign', 'verify'],
  );
  const exported = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicJwk: { kty: 'RSA', n: exported.n, e: exported.e, kid, alg, use: 'sig' },
  };
}

async function generateEcKeyPair(
  kid: string,
  alg: string,
  namedCurve: 'P-256' | 'P-384',
): Promise<KeyPair> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve }, true, [
    'sign',
    'verify',
  ]);
  const exported = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicJwk: { kty: 'EC', crv: exported.crv, x: exported.x, y: exported.y, kid, alg, use: 'sig' },
  };
}

beforeAll(async () => {
  [rs256, rs256Other, rs384, rs1024, es256, es384] = await Promise.all([
    generateRsaKeyPair('rs256-key', 'RS256', 'SHA-256'),
    generateRsaKeyPair('rs256-other', 'RS256', 'SHA-256'),
    generateRsaKeyPair('rs384-key', 'RS384', 'SHA-384'),
    generateRsaKeyPair('rs1024-key', 'RS256', 'SHA-256', 1024),
    generateEcKeyPair('es256-key', 'ES256', 'P-256'),
    generateEcKeyPair('es384-key', 'ES384', 'P-384'),
  ]);
});

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: CLIENT_ID,
    sub: CLIENT_ID,
    aud: TOKEN_ENDPOINT,
    jti: 'jti-1',
    exp: NOW + 60,
    iat: NOW,
    ...overrides,
  };
}

function header(keyPair: KeyPair, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { alg: keyPair.publicJwk.alg, kid: keyPair.publicJwk.kid, ...overrides };
}

async function sign(
  keyPair: KeyPair,
  payload: Record<string, unknown> = claims(),
  joseHeader: Record<string, unknown> = header(keyPair),
): Promise<string> {
  return signJwt(joseHeader, payload, keyPair.privateKey);
}

function encodeSegment(value: unknown): string {
  return arrayBufferToBase64Url(stringToArrayBuffer(JSON.stringify(value)));
}

function options(overrides: Partial<VerifyClientAssertionOptions> = {}): VerifyClientAssertionOptions {
  return {
    clientId: CLIENT_ID,
    jwks: { keys: [rs256.publicJwk] },
    audiences: [ISSUER, TOKEN_ENDPOINT],
    now: NOW,
    ...overrides,
  };
}

/** Returns the TokenError rejected by an asynchronous step, or undefined when it resolves. */
async function captureAsyncError(fn: () => Promise<unknown>): Promise<TokenError | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as TokenError;
  }
}

/** Returns the TokenError thrown by a synchronous step, or undefined when it does not throw. */
function captureError(fn: () => unknown): TokenError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as TokenError;
  }
}

async function expectInvalidClient(
  promise: () => Promise<unknown>,
  description: string,
): Promise<void> {
  const error = await captureAsyncError(promise);
  expect(error).toBeInstanceOf(TokenError);
  expect(error?.error).toBe(TokenErrorCode.InvalidClient);
  expect(error?.errorDescription).toBe(description);
}

describe('CLIENT_ASSERTION_TYPE_JWT_BEARER', () => {
  // RFC 7523 §2.2
  it('should be the jwt-bearer client assertion type URN', () => {
    expect(CLIENT_ASSERTION_TYPE_JWT_BEARER).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
  });
});

describe('DEFAULT_CLIENT_ASSERTION_SIGNING_ALGS', () => {
  // OIDC Core 1.0 §9: private_key_jwt uses asymmetric algorithms only. none and
  // the HMAC algorithms of client_secret_jwt are not listed.
  it('should list the RSASSA-PKCS1-v1_5 and ECDSA algorithms core can verify', () => {
    expect(DEFAULT_CLIENT_ASSERTION_SIGNING_ALGS).toEqual([
      'RS256',
      'RS384',
      'RS512',
      'ES256',
      'ES384',
      'ES512',
    ]);
  });
});

describe('verifyClientAssertion', () => {
  describe('Accepted assertions', () => {
    // The jti has to be remembered for as long as the assertion verifies: its exp
    // plus the clock skew tolerance (60 seconds by default).
    it('should return the jti and the end of the acceptance window of an RS256 assertion', async () => {
      const verified = await verifyClientAssertion(await sign(rs256), options());

      expect(verified).toEqual({ jti: 'jti-1', expiresAt: NOW + 120 });
    });

    it('should accept an ES256 assertion signed by a registered P-256 key', async () => {
      const verified = await verifyClientAssertion(
        await sign(es256),
        options({ jwks: { keys: [es256.publicJwk] } }),
      );

      expect(verified).toEqual({ jti: 'jti-1', expiresAt: NOW + 120 });
    });

    it('should accept an RS384 assertion signed by a registered SHA-384 key', async () => {
      const verified = await verifyClientAssertion(
        await sign(rs384),
        options({ jwks: { keys: [rs384.publicJwk] } }),
      );

      expect(verified).toEqual({ jti: 'jti-1', expiresAt: NOW + 120 });
    });

    // Rotation: the client registers several keys and names the signing one in kid.
    it('should verify with the registered key the kid header names among several keys', async () => {
      const verified = await verifyClientAssertion(
        await sign(rs256Other),
        options({ jwks: { keys: [rs256.publicJwk, rs256Other.publicJwk, es256.publicJwk] } }),
      );

      expect(verified).toEqual({ jti: 'jti-1', expiresAt: NOW + 120 });
    });

    it('should try every compatible registered key when the header has no kid', async () => {
      const verified = await verifyClientAssertion(
        await sign(rs256Other, claims(), { alg: 'RS256' }),
        options({ jwks: { keys: [rs256.publicJwk, rs256Other.publicJwk] } }),
      );

      expect(verified).toEqual({ jti: 'jti-1', expiresAt: NOW + 120 });
    });

    // RFC 7517 §4.2 / §4.4: use and alg are OPTIONAL members of a JWK.
    it('should accept a registered key that carries neither alg nor use', async () => {
      const bareJwk = { kty: 'RSA', n: rs256.publicJwk.n, e: rs256.publicJwk.e, kid: 'bare' } as Jwk;

      const verified = await verifyClientAssertion(
        await sign(rs256, claims(), { alg: 'RS256', kid: 'bare' }),
        options({ jwks: { keys: [bareJwk] } }),
      );

      expect(verified).toEqual({ jti: 'jti-1', expiresAt: NOW + 120 });
    });

    // draft-ietf-oauth-rfc7523bis: client authentication JWTs SHOULD be typed
    // client-authentication+jwt; a JWT typ or no typ is still a JWT (RFC 7519 §5.1).
    it.each(['client-authentication+jwt', 'application/client-authentication+jwt', 'JWT'])(
      'should accept typ %s',
      async (typ) => {
        const verified = await verifyClientAssertion(
          await sign(rs256, claims(), header(rs256, { typ })),
          options(),
        );

        expect(verified).toEqual({ jti: 'jti-1', expiresAt: NOW + 120 });
      },
    );

    it('should accept an exp that passed within the clock skew tolerance', async () => {
      const verified = await verifyClientAssertion(
        await sign(rs256, claims({ exp: NOW - 30 })),
        options({ clockSkewToleranceSec: 60 }),
      );

      expect(verified).toEqual({ jti: 'jti-1', expiresAt: NOW + 30 });
    });
  });

  describe('Registered keys', () => {
    it('should reject when the client has no registered keys', async () => {
      await expectInvalidClient(
        async () => verifyClientAssertion(await sign(rs256), options({ jwks: undefined })),
        'The client has no registered keys for private_key_jwt',
      );
    });

    it('should reject when the registered key set is empty', async () => {
      await expectInvalidClient(
        async () => verifyClientAssertion(await sign(rs256), options({ jwks: { keys: [] } })),
        'The client has no registered keys for private_key_jwt',
      );
    });

    it('should reject an assertion signed by a key the client did not register', async () => {
      await expectInvalidClient(
        async () =>
          verifyClientAssertion(
            await sign(rs256Other, claims(), header(rs256)),
            options(),
          ),
        'Client assertion signature verification failed',
      );
    });

    // RFC 7515 §4.1.4: kid is a hint. A key registered without a kid still
    // verifies an assertion whose header carries one.
    it('should fall back to registered keys without a kid when no key has the header kid', async () => {
      const withoutKid = { kty: 'RSA', n: rs256.publicJwk.n, e: rs256.publicJwk.e, alg: 'RS256' } as Jwk;

      const verified = await verifyClientAssertion(
        await sign(rs256, claims(), header(rs256, { kid: 'thumbprint-like-kid' })),
        options({ jwks: { keys: [rs256Other.publicJwk, withoutKid] } }),
      );

      expect(verified).toEqual({ jti: 'jti-1', expiresAt: NOW + 120 });
    });

    it('should reject when the kid header names no registered key', async () => {
      await expectInvalidClient(
        async () =>
          verifyClientAssertion(await sign(rs256, claims(), header(rs256, { kid: 'unknown' })), options()),
        'No registered key of the client matches the client assertion header',
      );
    });

    // RFC 7515 §4.1.1: a key pins its alg when the JWK carries one.
    it('should reject a registered key whose alg differs from the header alg', async () => {
      const pinnedToRs384 = { ...rs256.publicJwk, alg: 'RS384' };

      await expectInvalidClient(
        async () =>
          verifyClientAssertion(await sign(rs256), options({ jwks: { keys: [pinnedToRs384] } })),
        'Client assertion signature verification failed',
      );
    });

    // RFC 7517 §4.2: a key published for encryption must not verify signatures.
    it('should reject a registered key whose use is enc', async () => {
      const encryptionKey = { ...rs256.publicJwk, use: 'enc' };

      await expectInvalidClient(
        async () =>
          verifyClientAssertion(await sign(rs256), options({ jwks: { keys: [encryptionKey] } })),
        'Client assertion signature verification failed',
      );
    });

    // RFC 7518 §3.3: a key of size 2048 bits or larger MUST be used with RS256.
    it('should reject an RSA key shorter than 2048 bits', async () => {
      await expectInvalidClient(
        async () =>
          verifyClientAssertion(
            await sign(rs1024),
            options({ jwks: { keys: [rs1024.publicJwk] } }),
          ),
        'Client assertion signature verification failed',
      );
    });

    // RFC 7518 §3.4: ES256 is ECDSA over P-256; a P-384 key cannot verify it.
    it('should reject an EC key whose curve does not match the alg', async () => {
      const p384WithoutAlg = { ...es384.publicJwk, alg: undefined, kid: 'es256-key' } as unknown as Jwk;

      await expectInvalidClient(
        async () =>
          verifyClientAssertion(await sign(es256), options({ jwks: { keys: [p384WithoutAlg] } })),
        'Client assertion signature verification failed',
      );
    });

    it('should reject an RSA key presented for an ES256 header', async () => {
      const rsaNamedLikeTheEcKey = { ...rs256.publicJwk, alg: undefined, kid: 'es256-key' } as unknown as Jwk;

      await expectInvalidClient(
        async () =>
          verifyClientAssertion(await sign(es256), options({ jwks: { keys: [rsaNamedLikeTheEcKey] } })),
        'Client assertion signature verification failed',
      );
    });
  });

  describe('JOSE Header', () => {
    it('should reject alg none', async () => {
      const unsigned = `${encodeSegment({ alg: 'none' })}.${encodeSegment(claims())}.`;

      await expectInvalidClient(
        () => verifyClientAssertion(unsigned, options()),
        'Client assertion alg is not supported',
      );
    });

    // HS256 is client_secret_jwt, a method this OP does not offer.
    it('should reject an HMAC alg', async () => {
      const hmac = `${encodeSegment({ alg: 'HS256' })}.${encodeSegment(claims())}.c2lnbmF0dXJl`;

      await expectInvalidClient(
        () => verifyClientAssertion(hmac, options()),
        'Client assertion alg is not supported',
      );
    });

    it('should reject an alg outside supportedSigningAlgs', async () => {
      await expectInvalidClient(
        async () => verifyClientAssertion(await sign(rs256), options({ supportedSigningAlgs: ['ES256'] })),
        'Client assertion alg is not supported',
      );
    });

    it('should reject a header without alg', async () => {
      const withoutAlg = `${encodeSegment({ kid: 'rs256-key' })}.${encodeSegment(claims())}.c2ln`;

      await expectInvalidClient(
        () => verifyClientAssertion(withoutAlg, options()),
        'Client assertion alg is not supported',
      );
    });

    // RFC 8725 §3.1: the key comes from the client's registration, never from the JWT.
    it.each(['jku', 'jwk', 'x5u', 'x5c'])(
      'should reject a header carrying %s',
      async (field) => {
        await expectInvalidClient(
          async () =>
            verifyClientAssertion(
              await sign(rs256, claims(), header(rs256, { [field]: 'value' })),
              options(),
            ),
          `Client assertion JOSE header contains unsupported field: ${field}`,
        );
      },
    );

    // RFC 7515 §4.1.11: no extension is understood here, so any crit is rejected.
    it('should reject a header carrying crit', async () => {
      await expectInvalidClient(
        async () =>
          verifyClientAssertion(
            await sign(rs256, claims(), header(rs256, { crit: ['exp'] })),
            options(),
          ),
        'Client assertion JOSE header contains unsupported field: crit',
      );
    });

    // Cross-JWT confusion (RFC 8725 §3.11): a Request Object signed with the same
    // key (RFC 9101, typ oauth-authz-req+jwt) must not authenticate the client.
    it('should reject a Request Object typ', async () => {
      await expectInvalidClient(
        async () =>
          verifyClientAssertion(
            await sign(rs256, claims(), header(rs256, { typ: 'oauth-authz-req+jwt' })),
            options(),
          ),
        'Client assertion typ is not supported',
      );
    });
  });

  describe('Required Claims', () => {
    // OIDC Core 1.0 §9: iss and sub MUST both be the client_id.
    it('should reject an iss other than the client_id', async () => {
      await expectInvalidClient(
        async () => verifyClientAssertion(await sign(rs256, claims({ iss: 'other' })), options()),
        'Client assertion iss must be the client_id',
      );
    });

    it('should reject a missing iss', async () => {
      await expectInvalidClient(
        async () => verifyClientAssertion(await sign(rs256, claims({ iss: undefined })), options()),
        'Client assertion iss must be the client_id',
      );
    });

    it('should reject a sub other than the client_id', async () => {
      await expectInvalidClient(
        async () => verifyClientAssertion(await sign(rs256, claims({ sub: 'other' })), options()),
        'Client assertion sub must be the client_id',
      );
    });

    it('should reject a missing jti', async () => {
      await expectInvalidClient(
        async () => verifyClientAssertion(await sign(rs256, claims({ jti: undefined })), options()),
        'Client assertion jti is missing',
      );
    });

    it('should reject an empty jti', async () => {
      await expectInvalidClient(
        async () => verifyClientAssertion(await sign(rs256, claims({ jti: '' })), options()),
        'Client assertion jti is missing',
      );
    });

    it('should reject a non-string jti', async () => {
      await expectInvalidClient(
        async () => verifyClientAssertion(await sign(rs256, claims({ jti: 42 })), options()),
        'Client assertion jti is missing',
      );
    });
  });

  describe('Time Claims', () => {
    it('should reject a missing exp', async () => {
      await expectInvalidClient(
        async () => verifyClientAssertion(await sign(rs256, claims({ exp: undefined })), options()),
        'Client assertion exp is missing',
      );
    });

    it('should reject a non-numeric exp', async () => {
      await expectInvalidClient(
        async () => verifyClientAssertion(await sign(rs256, claims({ exp: `${NOW + 60}` })), options()),
        'Client assertion exp is missing',
      );
    });

    it('should reject an exp beyond the clock skew tolerance', async () => {
      await expectInvalidClient(
        async () =>
          verifyClientAssertion(
            await sign(rs256, claims({ exp: NOW - 61 })),
            options({ clockSkewToleranceSec: 60 }),
          ),
        'Client assertion has expired',
      );
    });

    it('should reject an nbf later than now beyond the clock skew tolerance', async () => {
      await expectInvalidClient(
        async () =>
          verifyClientAssertion(
            await sign(rs256, claims({ nbf: NOW + 61 })),
            options({ clockSkewToleranceSec: 60 }),
          ),
        'Client assertion is not yet valid',
      );
    });

    it('should reject an iat later than now beyond the clock skew tolerance', async () => {
      await expectInvalidClient(
        async () =>
          verifyClientAssertion(
            await sign(rs256, claims({ iat: NOW + 61 })),
            options({ clockSkewToleranceSec: 60 }),
          ),
        'Client assertion iat is in the future',
      );
    });
  });

  describe('Audience', () => {
    // OIDC Core 1.0 §9: the token endpoint URL SHOULD be the audience.
    it('should accept the token endpoint URL', async () => {
      const verified = await verifyClientAssertion(
        await sign(rs256, claims({ aud: TOKEN_ENDPOINT })),
        options(),
      );

      expect(verified).toEqual({ jti: 'jti-1', expiresAt: NOW + 120 });
    });

    // draft-ietf-oauth-rfc7523bis: the issuer identifier as the sole audience.
    it('should accept the issuer identifier', async () => {
      const verified = await verifyClientAssertion(await sign(rs256, claims({ aud: ISSUER })), options());

      expect(verified).toEqual({ jti: 'jti-1', expiresAt: NOW + 120 });
    });

    it('should accept an array of the issuer and the token endpoint URL', async () => {
      const verified = await verifyClientAssertion(
        await sign(rs256, claims({ aud: [TOKEN_ENDPOINT, ISSUER] })),
        options(),
      );

      expect(verified).toEqual({ jti: 'jti-1', expiresAt: NOW + 120 });
    });

    // CVE-2025-27370: a value naming another server means the assertion was also
    // made for that server, so it is not accepted here.
    it('should reject an array that also names another server', async () => {
      await expectInvalidClient(
        async () =>
          verifyClientAssertion(
            await sign(rs256, claims({ aud: [ISSUER, 'https://other.example.com/token'] })),
            options(),
          ),
        'Client assertion aud does not identify this authorization server',
      );
    });

    it('should reject the token endpoint URL when only the issuer is accepted', async () => {
      await expectInvalidClient(
        async () =>
          verifyClientAssertion(
            await sign(rs256, claims({ aud: TOKEN_ENDPOINT })),
            options({ audiences: [ISSUER] }),
          ),
        'Client assertion aud does not identify this authorization server',
      );
    });

    it('should reject a missing aud', async () => {
      await expectInvalidClient(
        async () => verifyClientAssertion(await sign(rs256, claims({ aud: undefined })), options()),
        'Client assertion aud does not identify this authorization server',
      );
    });
  });

  describe('Malformed assertions', () => {
    it('should reject a value that is not three segments', async () => {
      await expectInvalidClient(
        () => verifyClientAssertion('a.b', options()),
        'Client assertion is not a valid JWS compact serialization',
      );
    });

    it('should reject segments that are not base64url JSON', async () => {
      await expectInvalidClient(
        () => verifyClientAssertion('not+base64.e30.c2ln', options()),
        'Client assertion header or payload is not valid base64url JSON',
      );
    });

    it('should reject a payload that is not a JSON object', async () => {
      const arrayPayload = `${encodeSegment({ alg: 'RS256' })}.${encodeSegment([1, 2])}.c2ln`;

      await expectInvalidClient(
        () => verifyClientAssertion(arrayPayload, options()),
        'Client assertion header or payload is not valid base64url JSON',
      );
    });
  });

  describe('Verification order', () => {
    // The claims are read only after the signature verifies, so an unsigned
    // forgery learns nothing about which claim would have failed.
    it('should check the signature before the claims', async () => {
      await expectInvalidClient(
        async () =>
          verifyClientAssertion(
            await sign(rs256Other, claims({ iss: 'other' }), header(rs256)),
            options(),
          ),
        'Client assertion signature verification failed',
      );
    });
  });
});

describe('decodeClientAssertion', () => {
  it('should return the header, payload, signing input and signature', async () => {
    const assertion = await sign(rs256);
    const [headerB64, payloadB64, signature] = assertion.split('.');

    const decoded = decodeClientAssertion(assertion);

    expect(decoded).toEqual({
      header: { alg: 'RS256', kid: 'rs256-key' },
      payload: claims(),
      signingInput: `${headerB64}.${payloadB64}`,
      signature,
    });
  });
});

describe('readClientAssertionSubject', () => {
  // RFC 7521 §4.2: the client is identified by the subject of the assertion.
  it('should return the sub claim without verifying the signature', async () => {
    const subject = readClientAssertionSubject(await sign(rs256Other, claims({ sub: 'someone' })));

    expect(subject).toBe('someone');
  });

  it('should reject an assertion without a string sub', async () => {
    const assertion = await sign(rs256, claims({ sub: 7 }));

    const error = captureError(() => readClientAssertionSubject(assertion));

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client assertion sub is missing');
  });

  it('should reject a malformed assertion', () => {
    const error = captureError(() => readClientAssertionSubject('malformed'));

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client assertion is not a valid JWS compact serialization');
  });
});

describe('validateClientAssertionHeader', () => {
  it('should return the alg and kid', () => {
    const result = validateClientAssertionHeader(
      { alg: 'ES256', kid: 'key-1', typ: 'JWT' },
      DEFAULT_CLIENT_ASSERTION_SIGNING_ALGS,
    );

    expect(result).toEqual({ algorithm: 'ES256', keyId: 'key-1' });
  });

  it('should return an undefined kid when the header has none', () => {
    const result = validateClientAssertionHeader({ alg: 'RS256' }, DEFAULT_CLIENT_ASSERTION_SIGNING_ALGS);

    expect(result).toEqual({ algorithm: 'RS256', keyId: undefined });
  });
});

describe('validateClientAssertionAudience', () => {
  it('should accept a string audience that is one of the accepted values', () => {
    const error = captureError(() => validateClientAssertionAudience(ISSUER, [ISSUER]));

    expect(error).toBeUndefined();
  });

  it('should reject an empty array', () => {
    const error = captureError(() => validateClientAssertionAudience([], [ISSUER]));

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.errorDescription).toBe(
      'Client assertion aud does not identify this authorization server',
    );
  });

  it('should reject an array holding a non-string value', () => {
    const error = captureError(() => validateClientAssertionAudience([ISSUER, 1], [ISSUER]));

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.errorDescription).toBe(
      'Client assertion aud does not identify this authorization server',
    );
  });
});

describe('rejectReplayedClientAssertion', () => {
  interface RecordingStore extends ClientAssertionJtiStore {
    entries: Array<{ clientId: string; jti: string; expiresAt: number }>;
  }

  function createStore(alreadyUsed: boolean): RecordingStore {
    const entries: RecordingStore['entries'] = [];
    return {
      entries,
      async markUsed(entry) {
        entries.push(entry);
        return !alreadyUsed;
      },
    };
  }

  it('should pass the client_id, jti and exp to the store', async () => {
    const store = createStore(false);

    await rejectReplayedClientAssertion(store, { clientId: CLIENT_ID, jti: 'jti-1', expiresAt: NOW + 60 });

    expect(store.entries).toEqual([{ clientId: CLIENT_ID, jti: 'jti-1', expiresAt: NOW + 60 }]);
  });

  // OIDC Core 1.0 §9: client assertions MUST only be used once.
  it('should reject a jti the store already recorded for the client', async () => {
    const store = createStore(true);

    await expectInvalidClient(
      () => rejectReplayedClientAssertion(store, { clientId: CLIENT_ID, jti: 'jti-1', expiresAt: NOW + 60 }),
      'Client assertion has already been used',
    );
  });
});
