/**
 * private_key_jwt のクライアントアサーション（OIDC Core 1.0 §9 / RFC 7523 §3）の検証のテスト。
 */
import { describe, expect, it } from 'vitest';
import {
  CLIENT_ASSERTION_TYPE_JWT_BEARER,
  SUPPORTED_CLIENT_ASSERTION_SIGNING_ALGS,
  consumeClientAssertionJti,
  decodeClientAssertion,
  loadClientAssertionKeys,
  requireClientAssertionJti,
  validateClientAssertionAlg,
  validateClientAssertionAudience,
  validateClientAssertionClaims,
  validateClientAssertionSubject,
  validateClientAssertionTimes,
  verifyClientAssertionSignature,
  type ClientAssertionJtiStore,
} from './client-assertion.js';
import { ClientJwksUriError } from './client-jwks-uri.js';
import { arrayBufferToBase64Url, stringToArrayBuffer } from './crypto-utils.js';
import type { Jwk } from './jwks.js';
import { signJwt } from './jwt.js';
import { TokenError } from './token-error.js';

const CLIENT_ID = 'pkjwt-client';
const TOKEN_ENDPOINT = 'https://op.example.com/token';
const ISSUER = 'https://op.example.com';
const NOW = 1_700_000_000;

/** RS256 の鍵の組を作り、`kid` を付けた公開鍵の JWK と秘密鍵を返す。 */
async function rsaKey(kid: string): Promise<{ publicJwk: Jwk; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Jwk;
  return { publicJwk: { kty: publicJwk.kty, n: publicJwk.n, e: publicJwk.e, kid }, privateKey: pair.privateKey };
}

/** ES256 の鍵の組を作り、`kid` を付けた公開鍵の JWK と秘密鍵を返す。 */
async function ecKey(kid: string): Promise<{ publicJwk: Jwk; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Jwk;
  return {
    publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y, kid },
    privateKey: pair.privateKey,
  };
}

/** JSON を base64url にしたセグメントを返す。 */
function segment(value: unknown): string {
  return arrayBufferToBase64Url(stringToArrayBuffer(JSON.stringify(value)));
}

const CLAIMS = {
  iss: CLIENT_ID,
  sub: CLIENT_ID,
  aud: TOKEN_ENDPOINT,
  exp: NOW + 60,
  iat: NOW,
  jti: 'jti-1',
};

/** `consume()` を Map で受け持つ `jti` のストアを返す。 */
function memoryJtiStore(): ClientAssertionJtiStore & { keys: Map<string, number> } {
  const keys = new Map<string, number>();
  return {
    keys,
    async consume(key, expiresAt) {
      if (keys.has(key)) return false;
      keys.set(key, expiresAt);
      return true;
    },
  };
}

describe('CLIENT_ASSERTION_TYPE_JWT_BEARER', () => {
  // RFC 7523 §2.2
  it('should be the JWT bearer client assertion type URN', () => {
    expect(CLIENT_ASSERTION_TYPE_JWT_BEARER).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  });
});

describe('decodeClientAssertion', () => {
  it('should return the header, claims, alg, kid, signing input and signature of a JWS', async () => {
    const key = await rsaKey('k1');
    const assertion = await signJwt({ alg: 'RS256', kid: 'k1' }, CLAIMS, key.privateKey);
    const [header, payload, signature] = assertion.split('.');

    expect(decodeClientAssertion(assertion)).toEqual({
      header: { alg: 'RS256', kid: 'k1' },
      claims: CLAIMS,
      alg: 'RS256',
      kid: 'k1',
      signingInput: `${header}.${payload}`,
      signature,
    });
  });

  it('should leave out kid when the header has none', async () => {
    const key = await rsaKey('k1');
    const decoded = decodeClientAssertion(await signJwt({ alg: 'RS256' }, CLAIMS, key.privateKey));

    expect('kid' in decoded).toBe(false);
  });

  it('should reject a value that is not three segments with invalid_client', () => {
    expect(() => decodeClientAssertion('a.b.c.d.e')).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion is not a JWS compact serialization' }),
    );
  });

  it('should reject a header without alg', () => {
    expect(() => decodeClientAssertion(`${segment({ typ: 'JWT' })}.${segment(CLAIMS)}.sig`)).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion header is missing alg' }),
    );
  });

  // RFC 7515 §4.1.11
  it('should reject a header with crit', () => {
    expect(() => decodeClientAssertion(`${segment({ alg: 'RS256', crit: ['exp'] })}.${segment(CLAIMS)}.sig`)).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion header carries unsupported crit parameters' }),
    );
  });

  it('should reject an unsigned JWT', () => {
    expect(() => decodeClientAssertion(`${segment({ alg: 'none' })}.${segment(CLAIMS)}.`)).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion is not signed' }),
    );
  });

  it('should reject a payload that is not a JSON object', () => {
    expect(() => decodeClientAssertion(`${segment({ alg: 'RS256' })}.${segment(['a'])}.sig`)).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion payload is not valid base64url JSON' }),
    );
  });
});

describe('validateClientAssertionAlg', () => {
  const supportedAlgs = [...SUPPORTED_CLIENT_ASSERTION_SIGNING_ALGS];

  it('should accept an alg the OP supports', () => {
    expect(validateClientAssertionAlg('ES256', { supportedAlgs })).toBeUndefined();
  });

  // OIDC Core 1.0 §9: private_key_jwt is an asymmetric signature.
  it('should reject none even when it is listed', () => {
    expect(() => validateClientAssertionAlg('none', { supportedAlgs: ['none'] })).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion alg none is not accepted for private_key_jwt' }),
    );
  });

  it('should reject HS256 even when it is listed', () => {
    expect(() => validateClientAssertionAlg('HS256', { supportedAlgs: ['HS256'] })).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion alg HS256 is not accepted for private_key_jwt' }),
    );
  });

  // OIDC Dynamic Client Registration 1.0 §2: token_endpoint_auth_signing_alg.
  it('should reject an alg other than the registered token_endpoint_auth_signing_alg', () => {
    expect(() => validateClientAssertionAlg('RS256', { supportedAlgs, registeredAlg: 'ES256' })).toThrowError(
      expect.objectContaining({
        error: 'invalid_client',
        errorDescription: 'client_assertion alg does not match the registered token_endpoint_auth_signing_alg',
      }),
    );
  });

  it('should reject an alg the OP does not support', () => {
    expect(() => validateClientAssertionAlg('PS256', { supportedAlgs })).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'unsupported client_assertion signing alg: PS256' }),
    );
  });
});

describe('validateClientAssertionSubject', () => {
  it('should accept iss and sub equal to the client_id', () => {
    expect(validateClientAssertionSubject(CLAIMS, CLIENT_ID)).toBeUndefined();
  });

  it('should reject an iss other than the client_id', () => {
    expect(() => validateClientAssertionSubject({ ...CLAIMS, iss: 'other' }, CLIENT_ID)).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion iss must be the client_id' }),
    );
  });

  it('should reject a sub other than the client_id', () => {
    expect(() => validateClientAssertionSubject({ ...CLAIMS, sub: 'other' }, CLIENT_ID)).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion sub must be the client_id' }),
    );
  });
});

describe('validateClientAssertionAudience', () => {
  it('should accept the token endpoint URL', () => {
    expect(validateClientAssertionAudience(CLAIMS, [TOKEN_ENDPOINT, ISSUER])).toBeUndefined();
  });

  // RFC 7523 §3: the issuer identifies the authorization server too.
  it('should accept the issuer in an array', () => {
    expect(validateClientAssertionAudience({ ...CLAIMS, aud: ['https://other.example.com', ISSUER] }, [TOKEN_ENDPOINT, ISSUER])).toBeUndefined();
  });

  it('should reject an aud naming another server', () => {
    expect(() => validateClientAssertionAudience({ ...CLAIMS, aud: 'https://other.example.com' }, [TOKEN_ENDPOINT, ISSUER])).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion aud does not identify this authorization server' }),
    );
  });

  it('should reject an empty aud array', () => {
    expect(() => validateClientAssertionAudience({ ...CLAIMS, aud: [] }, [TOKEN_ENDPOINT])).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion aud must be a string or an array of strings' }),
    );
  });
});

describe('validateClientAssertionTimes', () => {
  it('should return exp of a current assertion', () => {
    expect(validateClientAssertionTimes(CLAIMS, NOW, 60)).toBe(NOW + 60);
  });

  it('should accept an exp within the leeway in the past', () => {
    expect(validateClientAssertionTimes({ ...CLAIMS, exp: NOW - 30 }, NOW, 60)).toBe(NOW - 30);
  });

  it('should reject a missing exp', () => {
    const { exp: _exp, ...withoutExp } = CLAIMS;

    expect(() => validateClientAssertionTimes(withoutExp, NOW, 60)).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion exp is required' }),
    );
  });

  it('should reject an exp beyond the leeway in the past', () => {
    expect(() => validateClientAssertionTimes({ ...CLAIMS, exp: NOW - 60 }, NOW, 60)).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion has expired' }),
    );
  });

  it('should reject an iat beyond the leeway in the future', () => {
    expect(() => validateClientAssertionTimes({ ...CLAIMS, iat: NOW + 61 }, NOW, 60)).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion iat is in the future' }),
    );
  });

  it('should reject an nbf that is not a number', () => {
    expect(() => validateClientAssertionTimes({ ...CLAIMS, nbf: 'soon' }, NOW, 60)).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion nbf must be a number' }),
    );
  });
});

describe('requireClientAssertionJti', () => {
  it('should return the jti', () => {
    expect(requireClientAssertionJti(CLAIMS)).toBe('jti-1');
  });

  // OIDC Core 1.0 §9: jti is REQUIRED.
  it('should reject a missing jti', () => {
    const { jti: _jti, ...withoutJti } = CLAIMS;

    expect(() => requireClientAssertionJti(withoutJti)).toThrowError(
      expect.objectContaining({ error: 'invalid_client', errorDescription: 'client_assertion jti is required' }),
    );
  });
});

describe('validateClientAssertionClaims', () => {
  it('should return the jti and the end of the replay window (exp plus leeway)', () => {
    expect(validateClientAssertionClaims(CLAIMS, { clientId: CLIENT_ID, audiences: [TOKEN_ENDPOINT, ISSUER], now: NOW })).toEqual({
      jti: 'jti-1',
      replayWindowEndsAt: NOW + 120,
    });
  });

  it('should use the given leeway', () => {
    expect(
      validateClientAssertionClaims(CLAIMS, { clientId: CLIENT_ID, audiences: [TOKEN_ENDPOINT], now: NOW, leewaySeconds: 5 }),
    ).toEqual({ jti: 'jti-1', replayWindowEndsAt: NOW + 65 });
  });
});

describe('loadClientAssertionKeys', () => {
  it('should ask the resolver for the private_key_jwt keys with the kid', async () => {
    const calls: unknown[] = [];
    const jwks = await loadClientAssertionKeys(
      {
        async findClientKeys(clientId, purpose, hint) {
          calls.push([clientId, purpose, hint]);
          return { keys: [] };
        },
      },
      CLIENT_ID,
      'k1',
    );

    expect(jwks).toEqual({ keys: [] });
    expect(calls).toEqual([[CLIENT_ID, 'private_key_jwt', { kid: 'k1' }]]);
  });

  // The reason of a jwks_uri failure is not disclosed.
  it('should turn a jwks_uri failure into invalid_client with a fixed message', async () => {
    const loading = loadClientAssertionKeys(
      {
        async findClientKeys() {
          throw new ClientJwksUriError('the jwks_uri answered HTTP 500');
        },
      },
      CLIENT_ID,
      undefined,
    );

    await expect(loading).rejects.toBeInstanceOf(TokenError);
    await expect(loading).rejects.toMatchObject({ error: 'invalid_client', errorDescription: 'the client jwks_uri could not be retrieved' });
  });
});

describe('verifyClientAssertionSignature', () => {
  it('should accept an RS256 assertion signed with the key of its kid', async () => {
    const key = await rsaKey('k1');
    const other = await rsaKey('k2');
    const decoded = decodeClientAssertion(await signJwt({ alg: 'RS256', kid: 'k1' }, CLAIMS, key.privateKey));

    await expect(verifyClientAssertionSignature(decoded, { keys: [other.publicJwk, key.publicJwk] })).resolves.toBeUndefined();
  });

  it('should accept an ES256 assertion without kid by trying every key', async () => {
    const rsa = await rsaKey('k1');
    const ec = await ecKey('k2');
    const decoded = decodeClientAssertion(await signJwt({ alg: 'ES256' }, CLAIMS, ec.privateKey));

    await expect(verifyClientAssertionSignature(decoded, { keys: [rsa.publicJwk, ec.publicJwk] })).resolves.toBeUndefined();
  });

  it('should reject when the client registered no keys', async () => {
    const key = await rsaKey('k1');
    const decoded = decodeClientAssertion(await signJwt({ alg: 'RS256', kid: 'k1' }, CLAIMS, key.privateKey));

    await expect(verifyClientAssertionSignature(decoded, { keys: [] })).rejects.toMatchObject({
      error: 'invalid_client',
      errorDescription: 'no keys registered to verify the client_assertion',
    });
  });

  it('should reject a kid the client did not register', async () => {
    const key = await rsaKey('k1');
    const decoded = decodeClientAssertion(await signJwt({ alg: 'RS256', kid: 'k9' }, CLAIMS, key.privateKey));

    await expect(verifyClientAssertionSignature(decoded, { keys: [key.publicJwk] })).rejects.toMatchObject({
      error: 'invalid_client',
      errorDescription: 'no registered key matches the client_assertion header',
    });
  });

  it('should reject a signature made with another key', async () => {
    const key = await rsaKey('k1');
    const attacker = await rsaKey('k1');
    const decoded = decodeClientAssertion(await signJwt({ alg: 'RS256', kid: 'k1' }, CLAIMS, attacker.privateKey));

    await expect(verifyClientAssertionSignature(decoded, { keys: [key.publicJwk] })).rejects.toMatchObject({
      error: 'invalid_client',
      errorDescription: 'client_assertion signature verification failed',
    });
  });
});

describe('consumeClientAssertionJti', () => {
  it('should remember the client_id and jti until the end of the replay window', async () => {
    const store = memoryJtiStore();

    await consumeClientAssertionJti(store, { clientId: CLIENT_ID, jti: 'jti-1', replayWindowEndsAt: NOW + 120 });

    expect([...store.keys]).toEqual([[JSON.stringify([CLIENT_ID, 'jti-1']), NOW + 120]]);
  });

  // RFC 7523 §3: a replayed assertion is rejected.
  it('should reject a jti the client already used', async () => {
    const store = memoryJtiStore();
    await consumeClientAssertionJti(store, { clientId: CLIENT_ID, jti: 'jti-1', replayWindowEndsAt: NOW + 120 });

    await expect(
      consumeClientAssertionJti(store, { clientId: CLIENT_ID, jti: 'jti-1', replayWindowEndsAt: NOW + 120 }),
    ).rejects.toMatchObject({ error: 'invalid_client', errorDescription: 'client_assertion has already been used' });
  });

  it('should accept the same jti from another client', async () => {
    const store = memoryJtiStore();
    await consumeClientAssertionJti(store, { clientId: CLIENT_ID, jti: 'jti-1', replayWindowEndsAt: NOW + 120 });

    await expect(
      consumeClientAssertionJti(store, { clientId: 'another-client', jti: 'jti-1', replayWindowEndsAt: NOW + 120 }),
    ).resolves.toBeUndefined();
  });
});
