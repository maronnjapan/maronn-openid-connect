import { describe, expect, it } from 'vitest';

import { DpopError } from './errors.js';
import { computeJwkThumbprint, validateDpopProofJwk, SUPPORTED_DPOP_SIGNING_ALGS } from './jwk.js';
import {
  computeDpopAccessTokenHash,
  consumeDpopProofJti,
  decodeDpopProof,
  readDpopProofHeader,
  validateDpopProofAccessTokenHash,
  validateDpopProofAlg,
  validateDpopProofClaims,
  verifyDpopProofSignature,
  type DpopProofJtiStore,
} from './proof.js';
import { generateDpopKey, signDpopProof } from './test-helpers.js';

const NOW = 1_767_225_600;
const TOKEN_URI = 'https://op.example.com/token';

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

describe('readDpopProofHeader', () => {
  it('should return undefined when the request has no DPoP header', () => {
    expect([readDpopProofHeader(null), readDpopProofHeader(undefined)]).toEqual([undefined, undefined]);
  });

  it('should return the single JWT of the header', () => {
    expect(readDpopProofHeader('a.b.c')).toBe('a.b.c');
  });

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
  it('should split a DPoP proof into its header, claims, alg, jwk and signing input', async () => {
    const key = await generateDpopKey('ES256');
    const proof = await signDpopProof(key, claimsAt(NOW));

    const decoded = decodeDpopProof(proof);

    expect(decoded.header).toEqual({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk });
    expect(decoded.claims).toEqual(claimsAt(NOW));
    expect(decoded.alg).toBe('ES256');
    expect(decoded.jwk).toEqual(key.publicJwk);
    expect(decoded.signingInput).toBe(proof.split('.').slice(0, 2).join('.'));
    expect(decoded.signature).toBe(proof.split('.')[2]);
  });

  it('should accept the typ in any letter case, as a media type', async () => {
    const key = await generateDpopKey('ES256');
    const proof = await signDpopProof(key, claimsAt(NOW), { typ: 'DPoP+JWT' });

    expect(decodeDpopProof(proof).alg).toBe('ES256');
  });

  it.each([
    ['a JWE (five segments)', 'a.b.c.d.e', 'The DPoP proof is not a JWS in the compact serialization'],
    ['a JWT without a signature', 'eyJ0eXAiOiJkcG9wK2p3dCJ9.eyJqdGkiOiIxIn0.', 'The DPoP proof is not a JWS in the compact serialization'],
    ['a header that is not JSON', 'bm90LWpzb24.eyJqdGkiOiIxIn0.c2ln', 'The DPoP proof is not a JWS in the compact serialization'],
  ])('should reject %s', (_name, proof, description) => {
    const error = errorOf(() => decodeDpopProof(proof));

    expect(error?.error).toBe('invalid_dpop_proof');
    expect(error?.errorDescription).toBe(description);
  });

  it.each([
    ['without typ', { typ: undefined }, 'The DPoP proof typ header must be dpop+jwt'],
    ['of another typ', { typ: 'JWT' }, 'The DPoP proof typ header must be dpop+jwt'],
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
    const validated = validateDpopProofClaims(claimsAt(NOW - 5), { method: 'POST', uri: TOKEN_URI, now: NOW });

    expect(validated).toEqual({ jti: 'jti-1', iat: NOW - 5, replayWindowEndsAt: NOW - 5 + 60 + 60 });
  });

  it('should compare htu without the query and the fragment, after normalizing the URI', () => {
    const claims = claimsAt(NOW, { htu: 'HTTPS://OP.Example.COM:443/%74oken?x=1#frag' });

    expect(validateDpopProofClaims(claims, { method: 'POST', uri: `${TOKEN_URI}?a=b`, now: NOW }).jti).toBe('jti-1');
  });

  it.each([
    ['no jti', { jti: undefined }, 'The DPoP proof has no jti claim'],
    ['an empty jti', { jti: '' }, 'The DPoP proof has no jti claim'],
    ['another method', { htm: 'GET' }, 'The DPoP proof htm claim does not match the request method'],
    ['a lower-case method', { htm: 'post' }, 'The DPoP proof htm claim does not match the request method'],
    ['another URI', { htu: 'https://op.example.com/userinfo' }, 'The DPoP proof htu claim does not match the request URI'],
    ['another host', { htu: 'https://rs.example.com/token' }, 'The DPoP proof htu claim does not match the request URI'],
    ['a htu that is not a URI', { htu: 'token' }, 'The DPoP proof htu claim does not match the request URI'],
    ['no iat', { iat: undefined }, 'The DPoP proof has no iat claim'],
    ['an iat that is a string', { iat: String(NOW) }, 'The DPoP proof has no iat claim'],
  ])('should reject a proof with %s', (_name, overrides, description) => {
    const error = errorOf(() => validateDpopProofClaims(claimsAt(NOW, overrides), { method: 'POST', uri: TOKEN_URI, now: NOW }));

    expect(error?.error).toBe('invalid_dpop_proof');
    expect(error?.errorDescription).toBe(description);
  });

  it.each([
    ['older than the window', NOW - 121],
    ['issued after the leeway', NOW + 61],
  ])('should reject a proof %s', (_name, iat) => {
    const error = errorOf(() => validateDpopProofClaims(claimsAt(iat), { method: 'POST', uri: TOKEN_URI, now: NOW }));

    expect(error?.errorDescription).toBe('The DPoP proof iat claim is not within the acceptable window');
  });

  it.each([NOW - 120, NOW + 60])('should accept a proof issued at the edge of the window (iat %i)', (iat) => {
    expect(validateDpopProofClaims(claimsAt(iat), { method: 'POST', uri: TOKEN_URI, now: NOW }).iat).toBe(iat);
  });

  it('should use the window the OP configures', () => {
    const policy = { method: 'POST', uri: TOKEN_URI, now: NOW, maxAgeSeconds: 10, leewaySeconds: 5 };

    expect(errorOf(() => validateDpopProofClaims(claimsAt(NOW - 16), policy))?.error).toBe('invalid_dpop_proof');
    expect(validateDpopProofClaims(claimsAt(NOW - 15), policy).replayWindowEndsAt).toBe(NOW);
  });
});

describe('computeDpopAccessTokenHash', () => {
  it('should hash the access token of the example of RFC 9449 to its ath', async () => {
    await expect(computeDpopAccessTokenHash('Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU')).resolves.toBe(
      'fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo',
    );
  });
});

describe('validateDpopProofAccessTokenHash', () => {
  it('should accept the ath of the access token', async () => {
    const claims = { ath: await computeDpopAccessTokenHash('token-1') };

    await expect(validateDpopProofAccessTokenHash(claims, 'token-1')).resolves.toBeUndefined();
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
  it('should remember the jti of the key until the end of the replay window', async () => {
    const store = memoryJtiStore();

    await consumeDpopProofJti(store, { jkt: 'jkt-1', jti: 'jti-1', replayWindowEndsAt: NOW + 120 });

    expect([...store.keys]).toEqual([['["dpop","jkt-1","jti-1"]', NOW + 120]]);
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

describe('a DPoP proof checked from end to end', () => {
  it('should give the JWK Thumbprint of the key that signed it', async () => {
    const key = await generateDpopKey('PS256');
    const decoded = decodeDpopProof(await signDpopProof(key, claimsAt(NOW)));
    validateDpopProofAlg(decoded.alg, ['PS256']);
    const jwk = validateDpopProofJwk(decoded.jwk, decoded.alg);
    await verifyDpopProofSignature(decoded, jwk);

    await expect(computeJwkThumbprint(jwk)).resolves.toBe(await computeJwkThumbprint(key.publicJwk));
  });
});
