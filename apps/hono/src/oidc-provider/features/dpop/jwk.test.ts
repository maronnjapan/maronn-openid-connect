import { describe, expect, it } from 'vitest';
import { generateDpopKey, signDpopProof } from '../../../test-support/dpop.js';

import { decodeBase64Url } from './base64url.js';
import { DpopError } from './errors.js';
import {
  computeJwkThumbprint,
  isSupportedDpopSigningAlg,
  SUPPORTED_DPOP_SIGNING_ALGS,
  validateDpopProofJwk,
  verifyJwsSignature,
  type DpopPublicJwk,
} from './jwk.js';

/** The RSA key (2048 bits) of the example of RFC 7638 §3.1. */
const RFC7638_KEY: DpopPublicJwk = {
  kty: 'RSA',
  n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
  e: 'AQAB',
  alg: 'RS256',
  kid: '2011-04-29',
};

/** The P-256 key of the DPoP proof of RFC 9449 §4.1 (Figure 2) and §4.2 (Figure 4). */
const RFC9449_KEY: DpopPublicJwk = {
  kty: 'EC',
  x: 'l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs',
  y: '9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA',
  crv: 'P-256',
};

/** The DPoP proof of RFC 9449 §4.1 (Figure 2), signed with RFC9449_KEY. */
const RFC9449_PROOF =
  'eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwieCI6Imw4dEZyaHgtMzR0VjNoUklDUkRZOXpDa0RscEJoRjQyVVFVZldWQVdCRnMiLCJ5IjoiOVZFNGpmX09rX282NHpiVFRsY3VOSmFqSG10NnY5VERWclUwQ2R2R1JEQSIsImNydiI6IlAtMjU2In19' +
  '.eyJqdGkiOiItQndDM0VTYzZhY2MybFRjIiwiaHRtIjoiUE9TVCIsImh0dSI6Imh0dHBzOi8vc2VydmVyLmV4YW1wbGUuY29tL3Rva2VuIiwiaWF0IjoxNTYyMjYyNjE2fQ' +
  '.2-GxA6T8lP4vfrg8v-FdWP0A0zdrj8igiMLvqRMUvwnQg4PtFLbdLXiOSsX0x7NVY-FNyJK70nfbV37xRZT3Lg';

/** The Ed25519 public key of RFC 8037 §A.2. */
const RFC8037_KEY: DpopPublicJwk = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };

/** The JWS of RFC 8037 §A.4, signed with the private key of RFC8037_KEY. */
const RFC8037_JWS =
  'eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc.hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg';

function errorOf(run: () => unknown): DpopError | undefined {
  try {
    run();
  } catch (error) {
    return error as DpopError;
  }
  return undefined;
}

/** The signing input and the signature of a compact JWS. */
function partsOf(jws: string): { signingInput: string; signature: Uint8Array<ArrayBuffer> } {
  const [header, payload, signature] = jws.split('.');
  return { signingInput: `${header}.${payload}`, signature: decodeBase64Url(signature ?? '') ?? new Uint8Array() };
}

describe('isSupportedDpopSigningAlg', () => {
  // RFC 9449 §4.2 / §11.6: asymmetric algs only, never none or a MAC.
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
  it('should return the public key of the DPoP proof of RFC 9449 §4.2', () => {
    expect(validateDpopProofJwk(RFC9449_KEY, 'ES256')).toEqual({
      kty: 'EC',
      x: 'l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs',
      y: '9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA',
      crv: 'P-256',
    });
  });

  it('should accept an RSA key of 2048 bits', () => {
    expect(validateDpopProofJwk(RFC7638_KEY, 'PS256')).toBe(RFC7638_KEY);
  });

  it.each(SUPPORTED_DPOP_SIGNING_ALGS)('should accept a public key generated for %s', async (alg) => {
    const key = await generateDpopKey(alg);

    expect(validateDpopProofJwk(key.publicJwk, alg)).toBe(key.publicJwk);
  });

  // RFC 9449 §4.2 / §4.3: the jwk must not contain a private key.
  it('should reject a jwk that carries the private key', () => {
    const error = errorOf(() => validateDpopProofJwk({ ...RFC9449_KEY, d: 'c2VjcmV0' }, 'ES256'));

    expect(error).toBeInstanceOf(DpopError);
    expect(error?.error).toBe('invalid_dpop_proof');
    expect(error?.errorDescription).toBe('The DPoP proof jwk header must not contain a private key');
  });

  it.each([
    ['a symmetric key', { kty: 'oct', k: 'c2VjcmV0' }, 'HS256', 'The DPoP proof jwk header must not contain a private key'],
    ['a value that is not an object', 'jwk', 'ES256', 'The DPoP proof jwk header is not a JSON object'],
    ['null', null, 'ES256', 'The DPoP proof jwk header is not a JSON object'],
    ['an array', [], 'ES256', 'The DPoP proof jwk header is not a JSON object'],
    ['an RSA key for an ECDSA alg', RFC7638_KEY, 'ES256', 'The DPoP proof jwk header does not match the alg'],
    ['an EC key of another curve', { ...RFC9449_KEY, crv: 'P-384' }, 'ES256', 'The DPoP proof jwk header does not match the alg'],
    ['an Ed448 key', { kty: 'OKP', crv: 'Ed448', x: RFC8037_KEY.x }, 'EdDSA', 'The DPoP proof jwk header does not match the alg'],
    ['a key for an alg this implementation does not verify', RFC9449_KEY, 'ES256K', 'The DPoP proof jwk header does not match the alg'],
    ['an EC key without y', { kty: 'EC', crv: 'P-256', x: RFC9449_KEY.x }, 'ES256', 'The DPoP proof jwk header is not a valid public key'],
    ['an EC key whose x is empty', { ...RFC9449_KEY, x: '' }, 'ES256', 'The DPoP proof jwk header is not a valid public key'],
    ['an EC key whose x is a number', { ...RFC9449_KEY, x: 1 }, 'ES256', 'The DPoP proof jwk header is not a valid public key'],
    ['an EC key whose x is not base64url', { ...RFC9449_KEY, x: 'l8tFrhx+34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs' }, 'ES256', 'The DPoP proof jwk header is not a valid public key'],
    ['an RSA key without e', { kty: 'RSA', n: RFC7638_KEY.n }, 'RS256', 'The DPoP proof jwk header is not a valid public key'],
  ])('should reject %s', (_name, jwk, alg, description) => {
    expect(errorOf(() => validateDpopProofJwk(jwk, alg))?.errorDescription).toBe(description);
  });

  // RFC 4648 §3.5 / RFC 7518 §2, §6.2.1.2, §6.3.1 / RFC 8037 §2: one encoding
  // per public key, so that a key has one JWK Thumbprint.
  it.each([
    ['an EC x with non-zero pad bits', { ...RFC9449_KEY, x: 'l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFt' }, 'ES256'],
    ['a P-256 x of 31 bytes', { ...RFC9449_KEY, x: 'y0WuHH7fi1XeFEgJENj3MKQOWkGEXjZRBR9ZUBYEWw' }, 'ES256'],
    ['a P-256 x of 33 bytes that starts with a zero byte', { ...RFC9449_KEY, x: 'AJfLRa4cft-LVd4USAkQ2PcwpA5aQYReNlEFH1lQFgRb' }, 'ES256'],
    ['a P-384 key with the 32 byte coordinates of P-256', { ...RFC9449_KEY, crv: 'P-384' }, 'ES384'],
    ['an Ed25519 x of 31 bytes', { ...RFC8037_KEY, x: 'WpgBgrEKt9VL_tPJZAc6DuFy89qmIyWvAhpo9wdRGg' }, 'EdDSA'],
    ['an Ed25519 x of 33 bytes', { ...RFC8037_KEY, x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURoA' }, 'EdDSA'],
    [
      'an RSA n that starts with a zero byte',
      {
        ...RFC7638_KEY,
        n: 'ANL8e2oKHmxnEErrj4iyV2abTfZ53a0Jm1xKbNmogBW1oTO_C4VseHG23wALVU_Os8LtUSu2jxRcboQ0dS-rUqHPwSRAj3m1ikV4wWQohVeJ96JJ44TLLZ-uLWf9lvuSbBmOB3OZ_cgVwK8Jfd5are_0TecOgn9IeEMkOb_uuWBo0EdPxQ1tkL86mN-vEEDInALWkqs7PCiWYJ2G_XO3dM4HQGR87uqjEL0S-YWo659Z_dQmzqWyEg9PKjS8q3ZLfmxU1oQCOLzEBYelnmbtHzOJRXdjXEcK91z5LCDR2kPhv8QZ4iKm8NC7NYxeOPnLBQrq_pBIFPGsGqScyp6gyoM',
      },
      'RS256',
    ],
    ['an RSA e that starts with a zero byte', { ...RFC7638_KEY, e: 'AAEAAQ' }, 'RS256'],
  ])('should reject %s', (_name, jwk, alg) => {
    expect(errorOf(() => validateDpopProofJwk(jwk, alg))?.errorDescription).toBe('The DPoP proof jwk header is not a valid public key');
  });

  // RFC 7518 §3.3 / §3.5: a key of 2048 bits or larger MUST be used.
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

  // RFC 9449 §6.1: the jkt of Figure 9 is the thumbprint of the key of the proofs of §5.
  it('should compute the jkt of the example of RFC 9449 §6.1', async () => {
    await expect(computeJwkThumbprint(RFC9449_KEY)).resolves.toBe('0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I');
  });

  it('should compute the thumbprint of the Ed25519 key of RFC 8037 §A.3', async () => {
    await expect(computeJwkThumbprint(RFC8037_KEY)).resolves.toBe('kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
  });

  // RFC 7638 §3.3: the required members in lexicographic order, whatever the order of the jwk.
  it('should give the same thumbprint whatever the order of the members', async () => {
    const reordered: DpopPublicJwk = {
      y: '9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA',
      crv: 'P-256',
      kid: 'client-key',
      x: 'l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs',
      kty: 'EC',
    };

    await expect(computeJwkThumbprint(reordered)).resolves.toBe('0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I');
  });
});

describe('verifyJwsSignature', () => {
  it('should verify the DPoP proof of RFC 9449 §4.1 with the key of its jwk header', async () => {
    const { signingInput, signature } = partsOf(RFC9449_PROOF);

    await expect(verifyJwsSignature(RFC9449_KEY, 'ES256', signingInput, signature)).resolves.toBe(true);
  });

  it('should verify the Ed25519 JWS of RFC 8037 §A.4', async () => {
    const { signingInput, signature } = partsOf(RFC8037_JWS);

    await expect(verifyJwsSignature(RFC8037_KEY, 'EdDSA', signingInput, signature)).resolves.toBe(true);
  });

  it.each(SUPPORTED_DPOP_SIGNING_ALGS)('should verify a JWS signed with a key of %s', async (alg) => {
    const key = await generateDpopKey(alg);
    const { signingInput, signature } = partsOf(await signDpopProof(key, { jti: 'proof-1' }));

    await expect(verifyJwsSignature(key.publicJwk, alg, signingInput, signature)).resolves.toBe(true);
  });

  it('should return false for a signing input that is not the one signed', async () => {
    const { signingInput, signature } = partsOf(RFC9449_PROOF);

    await expect(verifyJwsSignature(RFC9449_KEY, 'ES256', `${signingInput}A`, signature)).resolves.toBe(false);
  });

  it('should return false for the signature of another key', async () => {
    const other = await generateDpopKey('ES256');
    const { signingInput, signature } = partsOf(RFC9449_PROOF);

    await expect(verifyJwsSignature(other.publicJwk, 'ES256', signingInput, signature)).resolves.toBe(false);
  });

  // RFC 7518 §3.4: an ES256 signature is the 64 bytes of R || S, never DER.
  it('should return false for an ECDSA signature whose length does not match the curve', async () => {
    const { signingInput, signature } = partsOf(RFC9449_PROOF);

    await expect(verifyJwsSignature(RFC9449_KEY, 'ES256', signingInput, new Uint8Array([...signature, 0]))).resolves.toBe(false);
  });

  it('should return false for an alg this implementation does not verify', async () => {
    await expect(verifyJwsSignature(RFC9449_KEY, 'HS256', 'a.b', new Uint8Array(32))).resolves.toBe(false);
  });

  it('should return false for a key Web Crypto does not import', async () => {
    const notOnTheCurve: DpopPublicJwk = {
      kty: 'EC',
      crv: 'P-256',
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      y: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };

    await expect(verifyJwsSignature(notOnTheCurve, 'ES256', 'a.b', new Uint8Array(64))).resolves.toBe(false);
  });
});
