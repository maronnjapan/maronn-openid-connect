import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerContext } from '../../../test-support/context.js';
import { dpopKey, dpopProof, generateDpopKey, signDpopProof } from '../../../test-support/dpop.js';

import { dpopConfigDefaults } from './config.js';
import { DpopError } from './errors.js';
import { computeJwkThumbprint, validateDpopProofJwk, SUPPORTED_DPOP_SIGNING_ALGS } from './jwk.js';
import { dpopNonceKeyOf, issueDpopNonce } from './nonce.js';
import {
  computeDpopAccessTokenHash,
  consumeDpopProofJti,
  decodeDpopProof,
  readDpopProofHeader,
  validateDpopProofAccessTokenHash,
  validateDpopProofAlg,
  validateDpopProofClaims,
  validateDpopProofNonce,
  verifyDpopProofSignature,
  verifyDpopRequestProof,
  type DpopProofJtiStore,
} from './proof.js';

const NOW = 1_767_225_600;
const TOKEN_URI = 'https://op.example.com/token';
const POLICY = { method: 'POST', uris: [TOKEN_URI], now: NOW, maxAgeSeconds: 60, leewaySeconds: 60 };

/** The message of the Error thrown for an iat window that is not a non-negative finite number of seconds. */
const INVALID_WINDOW_MESSAGE =
  'The iat window of the DPoP proof checks (dpopProofMaxAgeSeconds, dpopProofLeewaySeconds) must be non-negative finite numbers';

/** The DPoP proof of RFC 9449 §4.1 (Figure 2): ES256, htm POST, htu https://server.example.com/token. */
const RFC9449_PROOF =
  'eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwieCI6Imw4dEZyaHgtMzR0VjNoUklDUkRZOXpDa0RscEJoRjQyVVFVZldWQVdCRnMiLCJ5IjoiOVZFNGpmX09rX282NHpiVFRsY3VOSmFqSG10NnY5VERWclUwQ2R2R1JEQSIsImNydiI6IlAtMjU2In19' +
  '.eyJqdGkiOiItQndDM0VTYzZhY2MybFRjIiwiaHRtIjoiUE9TVCIsImh0dSI6Imh0dHBzOi8vc2VydmVyLmV4YW1wbGUuY29tL3Rva2VuIiwiaWF0IjoxNTYyMjYyNjE2fQ' +
  '.2-GxA6T8lP4vfrg8v-FdWP0A0zdrj8igiMLvqRMUvwnQg4PtFLbdLXiOSsX0x7NVY-FNyJK70nfbV37xRZT3Lg';

/** The iat of RFC9449_PROOF. */
const RFC9449_IAT = 1_562_262_616;

/** The secret of the DPoP nonces of the tests (41 bytes). */
const NONCE_SECRET = 'dpop-nonce-secret-for-the-unit-tests-0001';

// The nonces below were computed apart from the code under test, with the HMAC
// of node:crypto and NONCE_SECRET, for the issuer https://op.example.com and
// the random bytes 0x00 to 0x0b (see nonce.test.ts).

/** The nonce the authorization server issues at NOW. */
const AUTHORIZATION_SERVER_NONCE_AT_NOW = 'AAAAAGlVuQAAAQIDBAUGBwgJCgs.qlRn_qjLCd4ScDSkutyR475dsXalwZpCxni6jPVshAI';
/** The nonce the resource server issues at NOW. */
const RESOURCE_SERVER_NONCE_AT_NOW = 'AAAAAGlVuQAAAQIDBAUGBwgJCgs.qMJbK4hF-YMMuV93-YOisKgT890kG1mcLWrlBS0Hgvc';
/** The nonce the authorization server issues at RFC9449_IAT. */
const AUTHORIZATION_SERVER_NONCE = 'AAAAAF0ePFgAAQIDBAUGBwgJCgs.oX681jrJpG-doHAfZ89Wt772ISEHiijMP6KmwtBVYCo';
/** The nonce the resource server issues at RFC9449_IAT. */
const RESOURCE_SERVER_NONCE = 'AAAAAF0ePFgAAQIDBAUGBwgJCgs.U9tLcI-I6_c1xgq7OnOa_aVQMg2KBBGM4yLSmZSb_NU';

/** The message of the Error thrown for a secret of the DPoP nonces shorter than 32 bytes. */
const SHORT_SECRET_MESSAGE = 'The secret of the DPoP nonces must be at least 32 bytes long';

function claimsAt(iat: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { jti: 'jti-1', htm: 'POST', htu: TOKEN_URI, iat, ...overrides };
}

function memoryJtiStore(): DpopProofJtiStore & { keys: Map<string, number> } {
  const keys = new Map<string, number>();
  return {
    keys,
    consume(key, expiresAt) {
      if (keys.has(key)) return false;
      keys.set(key, expiresAt);
      return true;
    },
  };
}

function errorOf(run: () => unknown): DpopError | undefined {
  try {
    run();
  } catch (error) {
    return error as DpopError;
  }
  return undefined;
}

/** A provider context whose config has the DPoP settings, laid over their defaults, with the other options given. */
function dpopContext(config: Record<string, unknown> = {}, options: { dpopNonceSecret?: string } = {}) {
  return providerContext({ options: { ...options, config: { ...dpopConfigDefaults, ...config } } });
}

describe('readDpopProofHeader', () => {
  it('should return undefined when the request has no DPoP header', () => {
    expect([readDpopProofHeader(null), readDpopProofHeader(undefined)]).toEqual([undefined, undefined]);
  });

  it('should return the single JWT of the header', () => {
    expect(readDpopProofHeader('a.b.c')).toBe('a.b.c');
  });

  // RFC 9449 §4.3: not more than one DPoP header.
  it('should reject two DPoP headers, which Fetch joins with a comma', () => {
    const error = errorOf(() => readDpopProofHeader('a.b.c, d.e.f'));

    expect(error).toBeInstanceOf(DpopError);
    expect(error?.error).toBe('invalid_dpop_proof');
    expect(error?.errorDescription).toBe('More than one DPoP header is not allowed');
  });

  it.each(['', 'a.b. c'])('should reject a header that is not one JWT: %j', (value) => {
    expect(errorOf(() => readDpopProofHeader(value))?.errorDescription).toBe('The DPoP header is not a single JWT');
  });
});

describe('decodeDpopProof', () => {
  it('should split the DPoP proof of RFC 9449 §4.1 into its header, claims, alg, jwk and signing input', () => {
    const decoded = decodeDpopProof(RFC9449_PROOF);

    expect(decoded).toEqual({
      header: {
        typ: 'dpop+jwt',
        alg: 'ES256',
        jwk: {
          kty: 'EC',
          x: 'l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs',
          y: '9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA',
          crv: 'P-256',
        },
      },
      claims: { jti: '-BwC3ESc6acc2lTc', htm: 'POST', htu: 'https://server.example.com/token', iat: 1562262616 },
      alg: 'ES256',
      jwk: {
        kty: 'EC',
        x: 'l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs',
        y: '9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA',
        crv: 'P-256',
      },
      signingInput: RFC9449_PROOF.split('.').slice(0, 2).join('.'),
      signature: '2-GxA6T8lP4vfrg8v-FdWP0A0zdrj8igiMLvqRMUvwnQg4PtFLbdLXiOSsX0x7NVY-FNyJK70nfbV37xRZT3Lg',
    });
  });

  // RFC 7515 §4.1.9: typ is a media type, so its case does not matter and
  // application/ may be prepended to a value without a slash.
  it.each(['DPoP+JWT', 'application/dpop+jwt', 'Application/DPoP+JWT'])('should accept the typ %s', async (typ) => {
    const key = await generateDpopKey('ES256');
    const proof = await signDpopProof(key, claimsAt(NOW), { typ });

    expect(decodeDpopProof(proof).header.typ).toBe(typ);
  });

  it.each([
    ['a JWE (five segments)', 'a.b.c.d.e'],
    ['a JWT without a signature', 'eyJ0eXAiOiJkcG9wK2p3dCJ9.eyJqdGkiOiIxIn0.'],
    ['a header that is not JSON', 'bm90LWpzb24.eyJqdGkiOiIxIn0.c2ln'],
    ['a header that is a JSON array', 'W10.eyJqdGkiOiIxIn0.c2ln'],
    ['a signature that is not base64url', 'eyJ0eXAiOiJkcG9wK2p3dCJ9.eyJqdGkiOiIxIn0.c2ln+'],
  ])('should reject %s', (_name, proof) => {
    const error = errorOf(() => decodeDpopProof(proof));

    expect(error?.error).toBe('invalid_dpop_proof');
    expect(error?.errorDescription).toBe('The DPoP proof is not a JWS in the compact serialization');
  });

  it.each([
    ['without typ', { typ: undefined }, 'The DPoP proof typ header must be dpop+jwt'],
    ['of another typ', { typ: 'JWT' }, 'The DPoP proof typ header must be dpop+jwt'],
    ['of another media type', { typ: 'application/jwt' }, 'The DPoP proof typ header must be dpop+jwt'],
    ['of another top-level type', { typ: 'text/dpop+jwt' }, 'The DPoP proof typ header must be dpop+jwt'],
    ['whose typ is not a string', { typ: 1 }, 'The DPoP proof typ header must be dpop+jwt'],
    ['without alg', { alg: undefined }, 'The DPoP proof has no alg header'],
    ['without jwk', { jwk: undefined }, 'The DPoP proof has no jwk header'],
    ['with crit', { crit: ['exp'] }, 'The DPoP proof has a crit header this server does not understand'],
  ])('should reject a proof %s', async (_name, header, description) => {
    const key = await generateDpopKey('ES256');
    const proof = await signDpopProof(key, claimsAt(NOW), header);

    expect(errorOf(() => decodeDpopProof(proof))?.errorDescription).toBe(description);
  });
});

describe('validateDpopProofAlg', () => {
  it('should accept an asymmetric alg the OP lists', () => {
    expect(() => validateDpopProofAlg('ES256', ['ES256', 'PS256'])).not.toThrow();
  });

  // RFC 9449 §4.3: never none or a MAC, and only an alg the application supports.
  it.each([
    ['none', ['none']],
    ['HS256', ['HS256']],
    ['RS256', ['ES256']],
    ['ES256K', ['ES256K']],
  ])('should reject %s when the OP accepts %j', (alg, accepted) => {
    const error = errorOf(() => validateDpopProofAlg(alg, accepted));

    expect(error?.error).toBe('invalid_dpop_proof');
    expect(error?.errorDescription).toBe('The DPoP proof alg is not supported');
  });
});

describe('verifyDpopProofSignature', () => {
  it.each([...SUPPORTED_DPOP_SIGNING_ALGS])('should verify a proof signed with %s', async (alg) => {
    const key = await generateDpopKey(alg);
    const decoded = decodeDpopProof(await signDpopProof(key, claimsAt(NOW)));

    await expect(verifyDpopProofSignature(decoded, validateDpopProofJwk(decoded.jwk, decoded.alg))).resolves.toBeUndefined();
  });

  it('should reject a proof whose claims were changed after signing', async () => {
    const key = await generateDpopKey('ES256');
    const [header, , signature] = (await signDpopProof(key, claimsAt(NOW))).split('.');
    const forged = (await signDpopProof(key, claimsAt(NOW, { htu: 'https://evil.example/token' }))).split('.')[1];
    const decoded = decodeDpopProof(`${header}.${forged}.${signature}`);

    await expect(verifyDpopProofSignature(decoded, validateDpopProofJwk(decoded.jwk, decoded.alg))).rejects.toMatchObject({
      error: 'invalid_dpop_proof',
      errorDescription: 'The DPoP proof signature is invalid',
    });
  });

  it('should reject a proof signed with another key than its jwk header', async () => {
    const signer = await generateDpopKey('ES256');
    const other = await generateDpopKey('ES256');
    const decoded = decodeDpopProof(await signDpopProof(signer, claimsAt(NOW), { jwk: other.publicJwk }));

    await expect(verifyDpopProofSignature(decoded, validateDpopProofJwk(decoded.jwk, decoded.alg))).rejects.toMatchObject({
      errorDescription: 'The DPoP proof signature is invalid',
    });
  });

  it('should reject an ECDSA signature of the wrong length for the curve', async () => {
    const key = await generateDpopKey('ES256');
    const decoded = decodeDpopProof(await signDpopProof(key, claimsAt(NOW)));

    await expect(
      verifyDpopProofSignature({ ...decoded, signature: `${decoded.signature}AAAA` }, validateDpopProofJwk(decoded.jwk, decoded.alg)),
    ).rejects.toMatchObject({ errorDescription: 'The DPoP proof signature is invalid' });
  });
});

describe('validateDpopProofClaims', () => {
  it('should return the jti, the iat and the end of the replay window', () => {
    const validated = validateDpopProofClaims(claimsAt(NOW - 5), POLICY);

    expect(validated).toEqual({ jti: 'jti-1', iat: NOW - 5, replayWindowEndsAt: NOW - 5 + 60 + 60 + 1 });
  });

  // RFC 9449 §4.3: htu is compared without the query and the fragment, after
  // syntax-based and scheme-based normalization.
  it('should compare htu without the query and the fragment, after normalizing the URI', () => {
    const claims = claimsAt(NOW, { htu: 'HTTPS://OP.Example.COM:443/%74oken?x=1#frag' });

    expect(validateDpopProofClaims(claims, { ...POLICY, uris: [`${TOKEN_URI}?a=b`] }).jti).toBe('jti-1');
  });

  it('should accept a htu that matches any of the URIs of the endpoint', () => {
    const claims = claimsAt(NOW, { htu: 'https://op.example.com/token' });

    expect(validateDpopProofClaims(claims, { ...POLICY, uris: ['https://op.example.com//token', TOKEN_URI] }).jti).toBe('jti-1');
  });

  // RFC 9449 §11.1: a jti of 256 characters is the longest one accepted.
  it('should accept a jti of 256 characters', () => {
    expect(validateDpopProofClaims(claimsAt(NOW, { jti: 'a'.repeat(256) }), POLICY).jti).toBe('a'.repeat(256));
  });

  it.each([
    ['no jti', { jti: undefined }, 'The DPoP proof has no jti claim'],
    ['an empty jti', { jti: '' }, 'The DPoP proof has no jti claim'],
    ['a jti that is a number', { jti: 1 }, 'The DPoP proof has no jti claim'],
    ['a jti of 257 characters', { jti: 'a'.repeat(257) }, 'The DPoP proof jti claim is too long'],
    ['another method', { htm: 'GET' }, 'The DPoP proof htm claim does not match the request method'],
    ['a lower-case method', { htm: 'post' }, 'The DPoP proof htm claim does not match the request method'],
    ['another URI', { htu: 'https://op.example.com/userinfo' }, 'The DPoP proof htu claim does not match the request URI'],
    ['another host', { htu: 'https://rs.example.com/token' }, 'The DPoP proof htu claim does not match the request URI'],
    ['a htu that is not a URI', { htu: 'token' }, 'The DPoP proof htu claim does not match the request URI'],
    ['no htu', { htu: undefined }, 'The DPoP proof htu claim does not match the request URI'],
    ['no iat', { iat: undefined }, 'The DPoP proof has no iat claim'],
    ['an iat that is a string', { iat: String(NOW) }, 'The DPoP proof has no iat claim'],
  ])('should reject a proof with %s', (_name, overrides, description) => {
    const error = errorOf(() => validateDpopProofClaims(claimsAt(NOW, overrides), POLICY));

    expect(error?.error).toBe('invalid_dpop_proof');
    expect(error?.errorDescription).toBe(description);
  });

  it.each([
    ['older than the window', NOW - 121],
    ['issued after the leeway', NOW + 61],
  ])('should reject a proof %s', (_name, iat) => {
    const error = errorOf(() => validateDpopProofClaims(claimsAt(iat), POLICY));

    expect(error?.errorDescription).toBe('The DPoP proof iat claim is not within the acceptable window');
  });

  it.each([NOW - 120, NOW + 60])('should accept a proof issued at the edge of the window (iat %i)', (iat) => {
    expect(validateDpopProofClaims(claimsAt(iat), POLICY).iat).toBe(iat);
  });

  it('should use the window of the policy', () => {
    const policy = { ...POLICY, maxAgeSeconds: 10, leewaySeconds: 5 };

    expect(errorOf(() => validateDpopProofClaims(claimsAt(NOW - 16), policy))?.error).toBe('invalid_dpop_proof');
    expect(validateDpopProofClaims(claimsAt(NOW - 15), policy).replayWindowEndsAt).toBe(NOW + 1);
  });

  // RFC 9449 §11.1: the jti is remembered through the last second the proof is accepted.
  it('should end the replay window after the last second the proof is accepted', () => {
    const policy = { ...POLICY, maxAgeSeconds: 0, leewaySeconds: 0 };

    const { replayWindowEndsAt } = validateDpopProofClaims(claimsAt(NOW), policy);

    expect(replayWindowEndsAt).toBe(NOW + 1);
    expect(errorOf(() => validateDpopProofClaims(claimsAt(NOW), { ...policy, now: replayWindowEndsAt }))?.error).toBe('invalid_dpop_proof');
  });

  // A window that is not a non-negative number (undefined or NaN) would accept
  // every iat and remember no jti, so it fails closed, as a server error.
  it.each([
    ['maxAgeSeconds', undefined],
    ['maxAgeSeconds', Number.NaN],
    ['maxAgeSeconds', -1],
    ['leewaySeconds', Number.NaN],
    ['leewaySeconds', Number.POSITIVE_INFINITY],
  ])('should throw an Error that is not a DpopError when %s is %s', (member, seconds) => {
    const error = errorOf(() => validateDpopProofClaims(claimsAt(NOW - 1_000_000), { ...POLICY, [member]: seconds }));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DpopError);
    expect(error?.message).toBe(INVALID_WINDOW_MESSAGE);
  });
});

describe('validateDpopProofNonce', () => {
  const scope = { server: 'authorization-server', issuer: 'https://op.example.com' } as const;
  const policy = { now: NOW, lifetimeSeconds: 120 };

  it('should accept the nonce the server recently issued', async () => {
    const key = await dpopNonceKeyOf(NONCE_SECRET);

    await expect(validateDpopProofNonce(claimsAt(NOW, { nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW }), key, scope, policy)).resolves.toBeUndefined();
  });

  // RFC 9449 §8 Figure 20 / §9 Figure 24, §11.3: no proof without a nonce once the server requires one.
  it.each([
    ['authorization-server', 'Authorization server requires nonce in DPoP proof'],
    ['resource-server', 'Resource server requires nonce in DPoP proof'],
  ] as const)('should ask the client for a nonce of the %s when the proof has none', async (server, errorDescription) => {
    const key = await dpopNonceKeyOf(NONCE_SECRET);

    await expect(validateDpopProofNonce(claimsAt(NOW), key, { ...scope, server }, policy)).rejects.toMatchObject({
      error: 'use_dpop_nonce',
      errorDescription,
    });
  });

  // RFC 9449 §8 / §9: a nonce that is not one the server recently supplied is rejected with use_dpop_nonce too.
  it.each([
    [
      'the nonce of the resource server at the authorization server',
      'authorization-server',
      RESOURCE_SERVER_NONCE_AT_NOW,
      'The DPoP proof nonce is not a nonce the authorization server recently provided',
    ],
    [
      'the nonce of the authorization server at the resource server',
      'resource-server',
      AUTHORIZATION_SERVER_NONCE_AT_NOW,
      'The DPoP proof nonce is not a nonce the resource server recently provided',
    ],
    ['a nonce that is not a string', 'authorization-server', 1_767_225_600, 'The DPoP proof nonce is not a nonce the authorization server recently provided'],
  ] as const)('should reject %s', async (_name, server, nonce, errorDescription) => {
    const key = await dpopNonceKeyOf(NONCE_SECRET);

    await expect(validateDpopProofNonce(claimsAt(NOW, { nonce }), key, { ...scope, server }, policy)).rejects.toMatchObject({
      error: 'use_dpop_nonce',
      errorDescription,
    });
  });

  it('should accept the nonce of the resource server at the resource server', async () => {
    const key = await dpopNonceKeyOf(NONCE_SECRET);

    await expect(
      validateDpopProofNonce(claimsAt(NOW, { nonce: RESOURCE_SERVER_NONCE_AT_NOW }), key, { ...scope, server: 'resource-server' }, policy),
    ).resolves.toBeUndefined();
  });

  it('should reject a nonce older than the lifetime', async () => {
    const key = await dpopNonceKeyOf(NONCE_SECRET);

    await expect(
      validateDpopProofNonce(claimsAt(NOW, { nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW }), key, scope, { now: NOW + 121, lifetimeSeconds: 120 }),
    ).rejects.toMatchObject({
      error: 'use_dpop_nonce',
      errorDescription: 'The DPoP proof nonce is not a nonce the authorization server recently provided',
    });
  });
});

describe('computeDpopAccessTokenHash', () => {
  it('should hash the access token of the example of RFC 9449 §7.1 to its ath', async () => {
    await expect(computeDpopAccessTokenHash('Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU')).resolves.toBe(
      'fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo',
    );
  });
});

describe('validateDpopProofAccessTokenHash', () => {
  it('should accept the ath of the access token', async () => {
    const claims = { ath: 'fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo' };

    await expect(validateDpopProofAccessTokenHash(claims, 'Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU')).resolves.toBeUndefined();
  });

  it.each([
    ['no ath', {}],
    ['the ath of another token', { ath: 'fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo' }],
  ])('should reject a proof with %s', async (_name, claims) => {
    await expect(validateDpopProofAccessTokenHash(claims, 'token-1')).rejects.toMatchObject({
      error: 'invalid_dpop_proof',
      errorDescription: 'The DPoP proof ath claim does not match the access token',
    });
  });
});

describe('consumeDpopProofJti', () => {
  // RFC 9449 §11.1: the store keeps a hash of the jti, not the jti itself.
  it('should remember the SHA-256 of the jti of the key until the end of the replay window', async () => {
    const store = memoryJtiStore();

    await consumeDpopProofJti(store, { jkt: 'jkt-1', jti: 'jti-1', replayWindowEndsAt: NOW + 120 });

    expect([...store.keys]).toEqual([['["dpop","jkt-1","WWTaBVrjHPjrcjDhkKUEiZxvYPB_nxzTyt6fvyJujCg"]', NOW + 120]]);
  });

  it('should keep a key of the same length for a long jti', async () => {
    const store = memoryJtiStore();

    await consumeDpopProofJti(store, { jkt: 'jkt-1', jti: 'a'.repeat(256), replayWindowEndsAt: NOW + 120 });

    expect([...store.keys.keys()]).toEqual(['["dpop","jkt-1","AtcWDXfhjGRHvoDC41XH7UOIVFJxcCxQJTsJFMZc5f4"]']);
  });

  it('should reject the same proof sent again', async () => {
    const store = memoryJtiStore();
    await consumeDpopProofJti(store, { jkt: 'jkt-1', jti: 'jti-1', replayWindowEndsAt: NOW + 120 });

    await expect(consumeDpopProofJti(store, { jkt: 'jkt-1', jti: 'jti-1', replayWindowEndsAt: NOW + 120 })).rejects.toMatchObject({
      error: 'invalid_dpop_proof',
      errorDescription: 'The DPoP proof has already been used',
    });
  });

  it('should keep the jti of each key apart', async () => {
    const store = memoryJtiStore();
    await consumeDpopProofJti(store, { jkt: 'jkt-1', jti: 'jti-1', replayWindowEndsAt: NOW + 120 });

    await expect(consumeDpopProofJti(store, { jkt: 'jkt-2', jti: 'jti-1', replayWindowEndsAt: NOW + 120 })).resolves.toBeUndefined();
  });
});

describe('verifyDpopRequestProof', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(RFC9449_IAT * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return the JWK Thumbprint of the key of the DPoP proof of RFC 9449 §4.1 and remember its jti', async () => {
    const { c, db } = await dpopContext({ issuer: 'https://server.example.com' });

    const jkt = await verifyDpopRequestProof(c, RFC9449_PROOF, { method: 'POST', path: '/token' });

    expect(jkt).toBe('0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I');
    expect([...db.clientAssertionJtis]).toEqual([
      ['["dpop","0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I","6gdsmDuMRXiFyz6lOi9YiulId6ZPDwT9qEDzRPpWHWU"]', 1562262737],
    ]);
  });

  // RFC 9449 §11.1: the same proof is not accepted twice.
  it('should reject the same DPoP proof sent again', async () => {
    const { c } = await dpopContext({ issuer: 'https://server.example.com' });
    await verifyDpopRequestProof(c, RFC9449_PROOF, { method: 'POST', path: '/token' });

    await expect(verifyDpopRequestProof(c, RFC9449_PROOF, { method: 'POST', path: '/token' })).rejects.toMatchObject({
      error: 'invalid_dpop_proof',
      errorDescription: 'The DPoP proof has already been used',
    });
  });

  it.each([
    ['the URI of the path', 'https://op.example.com/token'],
    ['the URI the metadata builds from the issuer', 'https://op.example.com//token'],
  ])('should accept, for an issuer that ends with a slash, a htu of %s', async (_name, htu) => {
    const key = await dpopKey();
    const { c } = await dpopContext({ issuer: 'https://op.example.com/' });

    await expect(verifyDpopRequestProof(c, await dpopProof(key, { htm: 'POST', htu }), { method: 'POST', path: '/token' })).resolves.toBe(
      key.jkt,
    );
  });

  it('should check the ath of the access token sent with the proof', async () => {
    const key = await dpopKey();
    const { c } = await dpopContext();
    const target = { method: 'GET', path: '/userinfo', accessToken: 'token-1' };
    const forToken1 = await dpopProof(key, { htm: 'GET', htu: 'https://op.example.com/userinfo', accessToken: 'token-1' });
    const forToken2 = await dpopProof(key, { htm: 'GET', htu: 'https://op.example.com/userinfo', accessToken: 'token-2' });

    await expect(verifyDpopRequestProof(c, forToken1, target)).resolves.toBe(key.jkt);
    await expect(verifyDpopRequestProof(c, forToken2, target)).rejects.toMatchObject({
      errorDescription: 'The DPoP proof ath claim does not match the access token',
    });
  });

  it('should reject a DPoP proof for another endpoint', async () => {
    const key = await dpopKey();
    const { c } = await dpopContext();
    const proof = await dpopProof(key, { htm: 'POST', htu: 'https://op.example.com/token' });

    await expect(verifyDpopRequestProof(c, proof, { method: 'POST', path: '/par' })).rejects.toMatchObject({
      errorDescription: 'The DPoP proof htu claim does not match the request URI',
    });
  });

  // RFC 9449 §4.3: only an alg the OP accepts; a rejected proof does not use up its jti.
  it('should reject an alg the config leaves out, without remembering the jti', async () => {
    const { c, db } = await dpopContext({ issuer: 'https://server.example.com', dpopSigningAlgValuesSupported: ['PS256'] });

    await expect(verifyDpopRequestProof(c, RFC9449_PROOF, { method: 'POST', path: '/token' })).rejects.toMatchObject({
      errorDescription: 'The DPoP proof alg is not supported',
    });
    expect(db.clientAssertionJtis.size).toBe(0);
  });

  // RFC 9449 §11.1: a proof that names the jwk of a client but is signed with
  // another key does not use up the jti, so the client's own proof with that
  // jti is still accepted.
  it('should not remember the jti of a proof whose signature does not verify with its jwk', async () => {
    const client = await dpopKey();
    const attacker = await generateDpopKey('ES256');
    const { c, db } = await dpopContext();
    const claims = { jti: 'jti-of-the-client', htm: 'POST', htu: 'https://op.example.com/token', iat: RFC9449_IAT };
    const forged = await signDpopProof(attacker, claims, { jwk: client.publicJwk });

    await expect(verifyDpopRequestProof(c, forged, { method: 'POST', path: '/token' })).rejects.toMatchObject({
      errorDescription: 'The DPoP proof signature is invalid',
    });
    expect(db.clientAssertionJtis.size).toBe(0);
    await expect(verifyDpopRequestProof(c, await signDpopProof(client, claims), { method: 'POST', path: '/token' })).resolves.toBe(
      client.jkt,
    );
  });

  it('should not remember the jti of a proof whose ath is not the hash of the access token', async () => {
    const key = await dpopKey();
    const { c, db } = await dpopContext();
    const proof = await dpopProof(key, { htm: 'GET', htu: 'https://op.example.com/userinfo', accessToken: 'token-2' });

    await expect(verifyDpopRequestProof(c, proof, { method: 'GET', path: '/userinfo', accessToken: 'token-1' })).rejects.toMatchObject({
      errorDescription: 'The DPoP proof ath claim does not match the access token',
    });
    expect(db.clientAssertionJtis.size).toBe(0);
  });

  it.each([
    ['no dpopProofMaxAgeSeconds', { dpopProofMaxAgeSeconds: undefined }],
    ['a dpopProofLeewaySeconds that is NaN', { dpopProofLeewaySeconds: Number.NaN }],
  ])('should throw, without remembering the jti, when the config has %s', async (_name, settings) => {
    const key = await dpopKey();
    const { c, db } = await dpopContext(settings);
    const proof = await dpopProof(key, { htm: 'POST', htu: 'https://op.example.com/token' }, { iat: RFC9449_IAT - 1_000_000 });

    await expect(verifyDpopRequestProof(c, proof, { method: 'POST', path: '/token' })).rejects.toThrow(INVALID_WINDOW_MESSAGE);
    expect(db.clientAssertionJtis.size).toBe(0);
  });

  it('should accept a DPoP proof within the window of the config', async () => {
    const key = await dpopKey();
    const { c } = await dpopContext({ dpopProofMaxAgeSeconds: 10, dpopProofLeewaySeconds: 5 });
    const proof = await dpopProof(key, { htm: 'POST', htu: 'https://op.example.com/token' }, { iat: RFC9449_IAT - 15 });

    await expect(verifyDpopRequestProof(c, proof, { method: 'POST', path: '/token' })).resolves.toBe(key.jkt);
  });

  it('should reject a DPoP proof older than the window of the config', async () => {
    const key = await dpopKey();
    const { c } = await dpopContext({ dpopProofMaxAgeSeconds: 10, dpopProofLeewaySeconds: 5 });
    const proof = await dpopProof(key, { htm: 'POST', htu: 'https://op.example.com/token' }, { iat: RFC9449_IAT - 16 });

    await expect(verifyDpopRequestProof(c, proof, { method: 'POST', path: '/token' })).rejects.toMatchObject({
      errorDescription: 'The DPoP proof iat claim is not within the acceptable window',
    });
  });

  it('should give the JWK Thumbprint of the key that signed a PS256 proof', async () => {
    const key = await generateDpopKey('PS256');
    const { c } = await dpopContext();
    const proof = await signDpopProof(key, { jti: 'jti-ps256', htm: 'POST', htu: 'https://op.example.com/token', iat: RFC9449_IAT });

    await expect(verifyDpopRequestProof(c, proof, { method: 'POST', path: '/token' })).resolves.toBe(await computeJwkThumbprint(key.publicJwk));
  });

  // RFC 9449 §8 / §11.3: where the authorization server requires a nonce, a proof without one is rejected, and its jti is not used up.
  it('should require a nonce of the authorization server, without remembering the jti of a proof that has none', async () => {
    const key = await dpopKey();
    const { c, db } = await dpopContext({}, { dpopNonceSecret: NONCE_SECRET });
    const proof = await dpopProof(key, { htm: 'POST', htu: 'https://op.example.com/token' });

    await expect(verifyDpopRequestProof(c, proof, { method: 'POST', path: '/token', nonceServer: 'authorization-server' })).rejects.toMatchObject({
      error: 'use_dpop_nonce',
      errorDescription: 'Authorization server requires nonce in DPoP proof',
    });
    expect(db.clientAssertionJtis.size).toBe(0);
  });

  it('should accept a nonce of the authorization server made with the secret of the options, and remember the jti', async () => {
    const key = await dpopKey();
    const { c, db } = await dpopContext({}, { dpopNonceSecret: NONCE_SECRET });
    const proof = await dpopProof(key, { htm: 'POST', htu: 'https://op.example.com/token' }, { nonce: AUTHORIZATION_SERVER_NONCE });

    await expect(verifyDpopRequestProof(c, proof, { method: 'POST', path: '/token', nonceServer: 'authorization-server' })).resolves.toBe(key.jkt);
    expect(db.clientAssertionJtis.size).toBe(1);
  });

  it('should reject a nonce made with another secret than the one of the options', async () => {
    const key = await dpopKey();
    const { c } = await dpopContext({}, { dpopNonceSecret: 'another-dpop-nonce-secret-of-the-tests' });
    const proof = await dpopProof(key, { htm: 'POST', htu: 'https://op.example.com/token' }, { nonce: AUTHORIZATION_SERVER_NONCE });

    await expect(verifyDpopRequestProof(c, proof, { method: 'POST', path: '/token', nonceServer: 'authorization-server' })).rejects.toMatchObject({
      error: 'use_dpop_nonce',
      errorDescription: 'The DPoP proof nonce is not a nonce the authorization server recently provided',
    });
  });

  // RFC 9449 §9: a nonce is accepted only by the server that issued it.
  it('should reject the nonce of the resource server at the authorization server', async () => {
    const key = await dpopKey();
    const { c } = await dpopContext({}, { dpopNonceSecret: NONCE_SECRET });
    const proof = await dpopProof(key, { htm: 'POST', htu: 'https://op.example.com/token' }, { nonce: RESOURCE_SERVER_NONCE });

    await expect(verifyDpopRequestProof(c, proof, { method: 'POST', path: '/token', nonceServer: 'authorization-server' })).rejects.toMatchObject({
      error: 'use_dpop_nonce',
      errorDescription: 'The DPoP proof nonce is not a nonce the authorization server recently provided',
    });
  });

  // RFC 9449 §9: a protected resource asks for a nonce of its own.
  it.each([
    ['no nonce', {}, 'Resource server requires nonce in DPoP proof'],
    ['the nonce of the authorization server', { nonce: AUTHORIZATION_SERVER_NONCE }, 'The DPoP proof nonce is not a nonce the resource server recently provided'],
  ])('should reject a proof with %s where the resource server requires a nonce', async (_name, overrides, errorDescription) => {
    const key = await dpopKey();
    const { c } = await dpopContext({}, { dpopNonceSecret: NONCE_SECRET });
    const proof = await dpopProof(key, { htm: 'GET', htu: 'https://op.example.com/userinfo', accessToken: 'token-1' }, overrides);

    await expect(
      verifyDpopRequestProof(c, proof, { method: 'GET', path: '/userinfo', accessToken: 'token-1', nonceServer: 'resource-server' }),
    ).rejects.toMatchObject({ error: 'use_dpop_nonce', errorDescription });
  });

  it('should accept the nonce of the resource server at a protected resource', async () => {
    const key = await dpopKey();
    const { c } = await dpopContext({}, { dpopNonceSecret: NONCE_SECRET });
    const proof = await dpopProof(
      key,
      { htm: 'GET', htu: 'https://op.example.com/userinfo', accessToken: 'token-1' },
      { nonce: RESOURCE_SERVER_NONCE },
    );

    await expect(
      verifyDpopRequestProof(c, proof, { method: 'GET', path: '/userinfo', accessToken: 'token-1', nonceServer: 'resource-server' }),
    ).resolves.toBe(key.jkt);
  });

  it.each([
    [10, 'accept', RFC9449_IAT + 10],
    [10, 'reject', RFC9449_IAT + 11],
  ])('should, with a dpopNonceLifetimeSeconds of %i, %s a nonce at %i', async (lifetime, outcome, now) => {
    vi.setSystemTime(now * 1000);
    const key = await dpopKey();
    const { c } = await dpopContext({ dpopNonceLifetimeSeconds: lifetime }, { dpopNonceSecret: NONCE_SECRET });
    const proof = await dpopProof(key, { htm: 'POST', htu: 'https://op.example.com/token' }, { nonce: AUTHORIZATION_SERVER_NONCE });

    const verified = verifyDpopRequestProof(c, proof, { method: 'POST', path: '/token', nonceServer: 'authorization-server' });

    await (outcome === 'accept'
      ? expect(verified).resolves.toBe(key.jkt)
      : expect(verified).rejects.toMatchObject({
          error: 'use_dpop_nonce',
          errorDescription: 'The DPoP proof nonce is not a nonce the authorization server recently provided',
        }));
  });

  // RFC 9449 §8: the client retries with the nonce; the jti of the rejected proof was not used up.
  it('should accept a proof made again with a nonce and the jti of a proof rejected for having none', async () => {
    const key = await dpopKey();
    const { c, db } = await dpopContext({}, { dpopNonceSecret: NONCE_SECRET });
    const claims = { jti: 'jti-retried-with-a-nonce', htm: 'POST', htu: 'https://op.example.com/token', iat: RFC9449_IAT };
    const target = { method: 'POST', path: '/token', nonceServer: 'authorization-server' } as const;

    await expect(verifyDpopRequestProof(c, await signDpopProof(key, claims), target)).rejects.toMatchObject({ error: 'use_dpop_nonce' });
    await expect(verifyDpopRequestProof(c, await signDpopProof(key, { ...claims, nonce: AUTHORIZATION_SERVER_NONCE }), target)).resolves.toBe(
      key.jkt,
    );
    expect(db.clientAssertionJtis.size).toBe(1);
  });

  // Without a secret, the nonces are made with a key of this process.
  it('should check the nonce with the key of the process when the options have no secret', async () => {
    const key = await dpopKey();
    const { c } = await dpopContext();
    const target = { method: 'POST', path: '/token', nonceServer: 'authorization-server' } as const;
    const processNonce = await issueDpopNonce(
      await dpopNonceKeyOf(undefined),
      { server: 'authorization-server', issuer: 'https://op.example.com' },
      RFC9449_IAT,
    );

    await expect(
      verifyDpopRequestProof(c, await dpopProof(key, { htm: 'POST', htu: 'https://op.example.com/token' }, { nonce: AUTHORIZATION_SERVER_NONCE }), target),
    ).rejects.toMatchObject({ error: 'use_dpop_nonce' });
    await expect(
      verifyDpopRequestProof(c, await dpopProof(key, { htm: 'POST', htu: 'https://op.example.com/token' }, { nonce: processNonce }), target),
    ).resolves.toBe(key.jkt);
  });

  it('should leave the nonce claim unchecked where the endpoint requires no nonce', async () => {
    const key = await dpopKey();
    const { c } = await dpopContext({}, { dpopNonceSecret: NONCE_SECRET });
    const proof = await dpopProof(key, { htm: 'POST', htu: 'https://op.example.com/token' }, { nonce: 'not-a-nonce-of-this-server' });

    await expect(verifyDpopRequestProof(c, proof, { method: 'POST', path: '/token' })).resolves.toBe(key.jkt);
  });

  it.each([
    ['a secret shorter than 32 bytes', {}, { dpopNonceSecret: 'a'.repeat(31) }, SHORT_SECRET_MESSAGE],
    [
      'a dpopNonceLifetimeSeconds that is NaN',
      { dpopNonceLifetimeSeconds: Number.NaN },
      { dpopNonceSecret: NONCE_SECRET },
      'The lifetime of the DPoP nonces (dpopNonceLifetimeSeconds) must be a non-negative finite number',
    ],
  ])('should throw, without remembering the jti, when a nonce is required with %s', async (_name, config, options, message) => {
    const key = await dpopKey();
    const { c, db } = await dpopContext(config, options);
    const proof = await dpopProof(key, { htm: 'POST', htu: 'https://op.example.com/token' }, { nonce: AUTHORIZATION_SERVER_NONCE });

    await expect(verifyDpopRequestProof(c, proof, { method: 'POST', path: '/token', nonceServer: 'authorization-server' })).rejects.toThrow(message);
    expect(db.clientAssertionJtis.size).toBe(0);
  });
});
