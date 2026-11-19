import { describe, expect, it } from 'vitest';
import { generateDpopKey } from '../../../../test-support/dpop';

import { DpopError } from './errors';
import { computeJwkThumbprint, isSupportedDpopSigningAlg, validateDpopProofJwk, verifyJwsSignature, type DpopPublicJwk } from './jwk';

/** The RSA key of the example of RFC 7638 §3.1. */
const RFC7638_KEY: DpopPublicJwk = {
  kty: 'RSA',
  n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
  e: 'AQAB',
  alg: 'RS256',
  kid: '2011-04-29',
};

function errorOf(run: () => unknown): DpopError | undefined {
  try {
    run();
  } catch (error) {
    return error as DpopError;
  }
  return undefined;
}

describe('isSupportedDpopSigningAlg', () => {
  it('should accept the asymmetric algs this implementation verifies and nothing else', () => {
    expect(['ES256', 'PS384', 'RS512', 'EdDSA', 'HS256', 'none', 'ES256K'].map(isSupportedDpopSigningAlg)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('validateDpopProofJwk', () => {
  it('should return a public key that matches the alg', async () => {
    const key = await generateDpopKey('ES256');

    expect(validateDpopProofJwk(key.publicJwk, 'ES256')).toEqual(key.publicJwk);
  });

  it('should reject a jwk that carries the private key', async () => {
    const key = await generateDpopKey('ES256');
    const error = errorOf(() => validateDpopProofJwk({ ...key.publicJwk, d: 'c2VjcmV0' }, 'ES256'));

    expect(error?.error).toBe('invalid_dpop_proof');
    expect(error?.errorDescription).toBe('The DPoP proof jwk header must not contain a private key');
  });

  it.each([
    ['a symmetric key', { kty: 'oct', k: 'c2VjcmV0' }, 'HS256', 'The DPoP proof jwk header must not contain a private key'],
    ['a value that is not an object', 'jwk', 'ES256', 'The DPoP proof jwk header is not a JSON object'],
    ['an array', [], 'ES256', 'The DPoP proof jwk header is not a JSON object'],
    ['an RSA key for an ECDSA alg', RFC7638_KEY, 'ES256', 'The DPoP proof jwk header does not match the alg'],
    ['an EC key of another curve', { kty: 'EC', crv: 'P-384', x: 'AA', y: 'AA' }, 'ES256', 'The DPoP proof jwk header does not match the alg'],
    ['an Ed448 key', { kty: 'OKP', crv: 'Ed448', x: 'AA' }, 'EdDSA', 'The DPoP proof jwk header does not match the alg'],
    ['an EC key without y', { kty: 'EC', crv: 'P-256', x: 'AA' }, 'ES256', 'The DPoP proof jwk header is not a valid public key'],
    ['an EC key whose x is not base64url', { kty: 'EC', crv: 'P-256', x: 'A+A', y: 'AA' }, 'ES256', 'The DPoP proof jwk header is not a valid public key'],
  ])('should reject %s', (_name, jwk, alg, description) => {
    expect(errorOf(() => validateDpopProofJwk(jwk, alg))?.errorDescription).toBe(description);
  });

  it('should reject an RSA key shorter than 2048 bits', async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const { n, e } = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { n: string; e: string };

    expect(errorOf(() => validateDpopProofJwk({ kty: 'RSA', n, e }, 'RS256'))?.errorDescription).toBe(
      'RSA keys shorter than 2048 bits are not accepted',
    );
  });
});

describe('computeJwkThumbprint', () => {
  it('should compute the thumbprint of the example of RFC 7638 §3.1, ignoring the members that are not required', async () => {
    await expect(computeJwkThumbprint(RFC7638_KEY)).resolves.toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  it('should give the same thumbprint whatever the order of the members', async () => {
    const key = await generateDpopKey('ES256');
    const reordered = { y: key.publicJwk.y, x: key.publicJwk.x, kty: 'EC', crv: 'P-256' } as DpopPublicJwk;

    await expect(computeJwkThumbprint(reordered)).resolves.toBe(await computeJwkThumbprint(key.publicJwk));
  });

  it('should give a 43 character base64url value for an Ed25519 key', async () => {
    const key = await generateDpopKey('EdDSA');

    await expect(computeJwkThumbprint(key.publicJwk)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('verifyJwsSignature', () => {
  it('should return false for an alg this implementation does not verify', async () => {
    const key = await generateDpopKey('ES256');

    await expect(verifyJwsSignature(key.publicJwk, 'HS256', 'a.b', new Uint8Array(32))).resolves.toBe(false);
  });

  it('should return false for a key Web Crypto does not import', async () => {
    const key = { kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' } as DpopPublicJwk;

    await expect(verifyJwsSignature(key, 'ES256', 'a.b', new Uint8Array(64))).resolves.toBe(false);
  });
});
