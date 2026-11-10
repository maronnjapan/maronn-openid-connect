import { describe, it, expect, beforeAll, vi } from 'vitest';
import { parseRequestObject, RequestObjectError } from './request-object.js';
import { ClientJwksUriError } from './client-jwks-uri.js';
import { exportPublicJwk } from './jwks.js';
import type { Jwk, JwkSet } from './jwks.js';
import { sign, arrayBufferToBase64Url, stringToArrayBuffer } from './crypto-utils.js';

function encodeSegment(value: unknown): string {
  return arrayBufferToBase64Url(stringToArrayBuffer(JSON.stringify(value)));
}

async function generateRsaKeyPair(
  hash: 'SHA-256' | 'SHA-384' = 'SHA-256',
  modulusLength = 2048,
): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

async function generateEcKeyPair(namedCurve: 'P-256' | 'P-384'): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve }, true, ['sign', 'verify'])) as CryptoKeyPair;
}

/** The public JWK as a JWK Set may publish it: kty and the key members, plus the given members. */
async function publicJwkOf(key: CryptoKey, members: Record<string, unknown>): Promise<Jwk> {
  const exported = await crypto.subtle.exportKey('jwk', key);
  const keyMembers =
    exported.kty === 'RSA'
      ? { kty: 'RSA', n: exported.n, e: exported.e }
      : { kty: 'EC', crv: exported.crv, x: exported.x, y: exported.y };
  return { ...keyMembers, ...members } as unknown as Jwk;
}

/** A loadJwks that answers with the keys the client registered. */
function keysOf(jwks: JwkSet): () => Promise<JwkSet> {
  return async () => jwks;
}

async function buildSigned(
  claims: Record<string, unknown>,
  privateKey: CryptoKey,
  kid?: string,
  alg = 'RS256',
): Promise<string> {
  const header: Record<string, unknown> = { alg, typ: 'oauth-authz-req+jwt' };
  if (kid !== undefined) header.kid = kid;
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const signature = await sign(signingInput, privateKey);
  return `${signingInput}.${signature}`;
}

describe('parseRequestObject', () => {
  let rsaKeyPair: CryptoKeyPair;
  let otherKeyPair: CryptoKeyPair;
  let jwks: JwkSet;
  const kid = 'req-key';

  beforeAll(async () => {
    rsaKeyPair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    otherKeyPair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    jwks = { keys: [await exportPublicJwk(rsaKeyPair.publicKey, kid)] };
  });

  describe('signed request objects (RS256)', () => {
    it('should return the payload claims when the signature is valid', async () => {
      const request = await buildSigned(
        { response_type: 'code', scope: 'openid', state: 'abc' },
        rsaKeyPair.privateKey,
        kid,
      );

      const claims = await parseRequestObject(request, {
        loadJwks: keysOf(jwks),
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: false,
      });

      expect(claims).toEqual({
        response_type: 'code',
        scope: 'openid',
        state: 'abc',
      });
    });

    it('should throw RequestObjectError when the signature does not verify', async () => {
      const request = await buildSigned(
        { scope: 'openid' },
        otherKeyPair.privateKey,
        kid,
      );

      await expect(
        parseRequestObject(request, {
          loadJwks: keysOf(jwks),
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: false,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });

    it('should throw RequestObjectError when no JWK matches the kid', async () => {
      const request = await buildSigned(
        { scope: 'openid' },
        rsaKeyPair.privateKey,
        'no-such-kid',
      );

      await expect(
        parseRequestObject(request, {
          loadJwks: keysOf(jwks),
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: false,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });

    it('should throw RequestObjectError when the alg is not supported', async () => {
      const request = await buildSigned(
        { scope: 'openid' },
        rsaKeyPair.privateKey,
        kid,
        'RS512',
      );

      await expect(
        parseRequestObject(request, {
          loadJwks: keysOf(jwks),
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: false,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });

    it.each([undefined, 'req-key'])('should reject a missing loader with the expected error (kid=%s)', async (headerKid) => {
      const request = await buildSigned(
        { scope: 'openid' },
        rsaKeyPair.privateKey,
        headerKid,
      );

      const parsing = parseRequestObject(request, {
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: false,
      });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('no JWKS registered to verify the request object signature'));
    });

    it.each([undefined, 'req-key'])('should reject an empty key set with the expected error (kid=%s)', async (headerKid) => {
      const request = await buildSigned({ scope: 'openid' }, rsaKeyPair.privateKey, headerKid);
      const parsing = parseRequestObject(request, {
        loadJwks: keysOf({ keys: [] }),
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: false,
      });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('no JWKS registered to verify the request object signature'));
    });

    it('should preserve the explicit rejection when a JavaScript loader returns undefined', async () => {
      const request = await buildSigned({ scope: 'openid' }, rsaKeyPair.privateKey);
      const parsing = parseRequestObject(request, {
        // A JavaScript caller can violate the TypeScript return contract.
        loadJwks: async () => undefined as unknown as JwkSet,
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: false,
      });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('no JWKS registered to verify the request object signature'));
    });
  });

  // RFC 8725 §3.1: the alg of the header must be the one algorithm the key is
  // used with, and each key is used with exactly one algorithm.
  describe('key and alg pinning (RFC 8725 §3.1)', () => {
    // UC-21: verify() hashes by the curve of an EC key, so without the pinning a
    // P-256 key would verify an ES256 signature under an ES384 header.
    it('should reject an ES384 header that names a P-256 key', async () => {
      const ecKeyPair = await generateEcKeyPair('P-256');
      const request = await buildSigned({ scope: 'openid' }, ecKeyPair.privateKey, 'ec-key', 'ES384');

      const parsing = parseRequestObject(request, {
        loadJwks: keysOf({ keys: [await publicJwkOf(ecKeyPair.publicKey, { kid: 'ec-key' })] }),
        supportedSigningAlgs: ['ES256', 'ES384'],
        allowUnsigned: false,
      });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('no signing JWK matched the request object header (alg)'));
    });

    it('should verify an ES256 request object with a P-256 key without alg', async () => {
      const ecKeyPair = await generateEcKeyPair('P-256');
      const request = await buildSigned({ scope: 'openid' }, ecKeyPair.privateKey, 'ec-key', 'ES256');

      const claims = await parseRequestObject(request, {
        loadJwks: keysOf({ keys: [await publicJwkOf(ecKeyPair.publicKey, { kid: 'ec-key' })] }),
        supportedSigningAlgs: ['ES256', 'ES384'],
        allowUnsigned: false,
      });

      expect(claims).toEqual({ scope: 'openid' });
    });

    // D-13: an RSA key without alg is pinned to RS256 (it used to fail to import).
    it('should verify an RS256 request object with an RSA key without alg', async () => {
      const request = await buildSigned({ scope: 'openid' }, rsaKeyPair.privateKey, kid);

      const claims = await parseRequestObject(request, {
        loadJwks: keysOf({ keys: [await publicJwkOf(rsaKeyPair.publicKey, { kid })] }),
        supportedSigningAlgs: ['RS256', 'RS384'],
        allowUnsigned: false,
      });

      expect(claims).toEqual({ scope: 'openid' });
    });

    it('should reject an RS384 request object for an RSA key without alg', async () => {
      const rs384KeyPair = await generateRsaKeyPair('SHA-384');
      const request = await buildSigned({ scope: 'openid' }, rs384KeyPair.privateKey, 'rs384-key', 'RS384');

      const parsing = parseRequestObject(request, {
        loadJwks: keysOf({ keys: [await publicJwkOf(rs384KeyPair.publicKey, { kid: 'rs384-key' })] }),
        supportedSigningAlgs: ['RS256', 'RS384'],
        allowUnsigned: false,
      });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('no signing JWK matched the request object header (alg)'));
    });

    it('should verify an RS384 request object with an RSA key whose alg is RS384', async () => {
      const rs384KeyPair = await generateRsaKeyPair('SHA-384');
      const request = await buildSigned({ scope: 'openid' }, rs384KeyPair.privateKey, 'rs384-key', 'RS384');

      const claims = await parseRequestObject(request, {
        loadJwks: keysOf({ keys: [await publicJwkOf(rs384KeyPair.publicKey, { kid: 'rs384-key', alg: 'RS384' })] }),
        supportedSigningAlgs: ['RS256', 'RS384'],
        allowUnsigned: false,
      });

      expect(claims).toEqual({ scope: 'openid' });
    });

    // RFC 7517 §4.2: a key published for encryption does not verify signatures.
    it('should not verify with a key whose use is enc', async () => {
      const request = await buildSigned({ scope: 'openid' }, rsaKeyPair.privateKey, kid);

      const parsing = parseRequestObject(request, {
        loadJwks: keysOf({ keys: [await publicJwkOf(rsaKeyPair.publicKey, { kid, use: 'enc' })] }),
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: false,
      });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('no signing JWK matched the request object header (alg)'));
    });

    // RFC 7518 §3.3: RS256 needs a key of 2048 bits or larger.
    it('should reject a request object verified only by an RSA key shorter than 2048 bits', async () => {
      const shortKeyPair = await generateRsaKeyPair('SHA-256', 1024);
      const request = await buildSigned({ scope: 'openid' }, shortKeyPair.privateKey, 'short-key');

      const parsing = parseRequestObject(request, {
        loadJwks: keysOf({ keys: [await publicJwkOf(shortKeyPair.publicKey, { kid: 'short-key', alg: 'RS256' })] }),
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: false,
      });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('request object signature verification failed'));
    });

    it('should try the keys of the alg when the header has no kid', async () => {
      const ecKeyPair = await generateEcKeyPair('P-256');
      const request = await buildSigned({ scope: 'openid' }, ecKeyPair.privateKey, undefined, 'ES256');

      const keys = {
        keys: [
          await publicJwkOf(rsaKeyPair.publicKey, { kid }),
          await publicJwkOf(ecKeyPair.publicKey, { kid: 'ec-key' }),
        ],
      };

      const claims = await parseRequestObject(request, {
        loadJwks: keysOf(keys),
        supportedSigningAlgs: ['RS256', 'ES256'],
        allowUnsigned: false,
      });

      expect(claims).toEqual({ scope: 'openid' });
    });
  });

  // OIDC Core 1.0 §6.3.2 / OIDC Dynamic Client Registration 1.0 §2: a client that
  // registered request_object_signing_alg has every Request Object signed with it.
  describe('requiredSigningAlg', () => {
    it('should accept a request object signed with the registered alg', async () => {
      const ecKeyPair = await generateEcKeyPair('P-256');
      const request = await buildSigned({ scope: 'openid' }, ecKeyPair.privateKey, 'ec-key', 'ES256');

      const claims = await parseRequestObject(request, {
        loadJwks: keysOf({ keys: [await publicJwkOf(ecKeyPair.publicKey, { kid: 'ec-key' })] }),
        supportedSigningAlgs: ['RS256', 'ES256'],
        allowUnsigned: false,
        requiredSigningAlg: 'ES256',
      });

      expect(claims).toEqual({ scope: 'openid' });
    });

    // UC-14
    it('should reject a request object signed with another alg than the registered one', async () => {
      const request = await buildSigned({ scope: 'openid' }, rsaKeyPair.privateKey, kid);

      const parsing = parseRequestObject(request, {
        loadJwks: keysOf(jwks),
        supportedSigningAlgs: ['RS256', 'ES256'],
        allowUnsigned: false,
        requiredSigningAlg: 'ES256',
      });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('request object alg does not match the registered request_object_signing_alg'));
    });

    // UC-15
    it('should reject an unsigned request object of a client that registered a signing alg even when unsigned ones are allowed', async () => {
      const request = `${encodeSegment({ alg: 'none' })}.${encodeSegment({ scope: 'openid' })}.`;

      const parsing = parseRequestObject(request, {
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: true,
        requiredSigningAlg: 'RS256',
      });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('request object alg does not match the registered request_object_signing_alg'));
    });

    it('should accept an unsigned request object of a client that registered none when unsigned ones are allowed', async () => {
      const request = `${encodeSegment({ alg: 'none' })}.${encodeSegment({ scope: 'openid' })}.`;

      const claims = await parseRequestObject(request, {
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: true,
        requiredSigningAlg: 'none',
      });

      expect(claims).toEqual({ scope: 'openid' });
    });

    it('should reject an unsigned request object of a client that registered none when unsigned ones are not allowed', async () => {
      const request = `${encodeSegment({ alg: 'none' })}.${encodeSegment({ scope: 'openid' })}.`;

      const parsing = parseRequestObject(request, {
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: false,
        requiredSigningAlg: 'none',
      });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('unsigned request object (alg=none) is not supported'));
    });

    // D-24: a registered alg the OP does not accept never verifies.
    it('should reject a request object signed with a registered alg the OP does not accept', async () => {
      const rs384KeyPair = await generateRsaKeyPair('SHA-384');
      const request = await buildSigned({ scope: 'openid' }, rs384KeyPair.privateKey, 'rs384-key', 'RS384');

      const parsing = parseRequestObject(request, {
        loadJwks: keysOf({ keys: [await publicJwkOf(rs384KeyPair.publicKey, { kid: 'rs384-key', alg: 'RS384' })] }),
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: false,
        requiredSigningAlg: 'RS384',
      });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('unsupported request object signing alg: RS384'));
    });
  });

  // The keys are read after the JOSE header passed every check, so a Request
  // Object that is rejected anyway never makes the OP fetch a jwks_uri.
  describe('loadJwks', () => {
    it('should verify with the keys loadJwks returns for the alg and kid of the header', async () => {
      const request = await buildSigned({ scope: 'openid' }, rsaKeyPair.privateKey, kid);
      const loadJwks = vi.fn(async () => jwks);

      const claims = await parseRequestObject(request, {
        loadJwks,
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: false,
      });

      expect(claims).toEqual({ scope: 'openid' });
      expect(loadJwks).toHaveBeenCalledTimes(1);
      expect(loadJwks).toHaveBeenCalledWith({ alg: 'RS256', kid });
    });

    it('should call loadJwks without kid when the header has none', async () => {
      const request = await buildSigned({ scope: 'openid' }, rsaKeyPair.privateKey);
      const loadJwks = vi.fn(async () => jwks);

      await parseRequestObject(request, { loadJwks, supportedSigningAlgs: ['RS256'], allowUnsigned: false });

      expect(loadJwks.mock.calls).toEqual([[{ alg: 'RS256' }]]);
    });

    it('should not call loadJwks for an unsigned request object', async () => {
      const loadJwks = vi.fn(async () => jwks);
      const request = `${encodeSegment({ alg: 'none' })}.${encodeSegment({ scope: 'openid' })}.`;

      const parsing = parseRequestObject(request, { loadJwks, supportedSigningAlgs: ['RS256'], allowUnsigned: false });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('unsigned request object (alg=none) is not supported'));
      expect(loadJwks).not.toHaveBeenCalled();
    });

    it('should not call loadJwks for an alg the OP does not accept', async () => {
      const loadJwks = vi.fn(async () => jwks);
      const request = await buildSigned({ scope: 'openid' }, rsaKeyPair.privateKey, kid, 'RS512');

      const parsing = parseRequestObject(request, { loadJwks, supportedSigningAlgs: ['RS256'], allowUnsigned: false });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('unsupported request object signing alg: RS512'));
      expect(loadJwks).not.toHaveBeenCalled();
    });

    it('should not call loadJwks for an alg other than the registered one', async () => {
      const loadJwks = vi.fn(async () => jwks);
      const request = await buildSigned({ scope: 'openid' }, rsaKeyPair.privateKey, kid);

      const parsing = parseRequestObject(request, {
        loadJwks,
        supportedSigningAlgs: ['RS256', 'ES256'],
        allowUnsigned: false,
        requiredSigningAlg: 'ES256',
      });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('request object alg does not match the registered request_object_signing_alg'));
      expect(loadJwks).not.toHaveBeenCalled();
    });

    it('should not call loadJwks for a header that is not JSON', async () => {
      const loadJwks = vi.fn(async () => jwks);

      const parsing = parseRequestObject('bm90LWpzb24.e30.AAAA', { loadJwks, supportedSigningAlgs: ['RS256'], allowUnsigned: false });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('request object header is not valid base64url JSON'));
      expect(loadJwks).not.toHaveBeenCalled();
    });

    // D-14: the reason (a host, a status, a timeout) stays in the OP's logs.
    it('should reject with a fixed message when the jwks_uri cannot be retrieved', async () => {
      const request = await buildSigned({ scope: 'openid' }, rsaKeyPair.privateKey, kid);
      const loadJwks = vi.fn(async (): Promise<JwkSet> => {
        throw new ClientJwksUriError('GET https://10.0.0.5/jwks answered 404');
      });

      const parsing = parseRequestObject(request, { loadJwks, supportedSigningAlgs: ['RS256'], allowUnsigned: false });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('the client jwks_uri could not be retrieved'));
    });

    it('should reject with the fixed message for a ClientJwksUriError of another copy of core', async () => {
      const request = await buildSigned({ scope: 'openid' }, rsaKeyPair.privateKey, kid);

      const parsing = parseRequestObject(request, {
          loadJwks: async () => {
            throw Object.assign(new Error('the jwks_uri answered HTTP 404'), { name: 'ClientJwksUriError' });
          },
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: false,
        });
      await expect(parsing).rejects.toBeInstanceOf(RequestObjectError);
      await expect(parsing).rejects.toThrow(new RequestObjectError('the client jwks_uri could not be retrieved'));
    });

    it('should let another error of loadJwks through', async () => {
      const request = await buildSigned({ scope: 'openid' }, rsaKeyPair.privateKey, kid);
      const failure = new Error('the client store is unavailable');

      await expect(
        parseRequestObject(request, {
          loadJwks: async () => {
            throw failure;
          },
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: false,
        }),
      ).rejects.toBe(failure);
    });
  });

  describe('unsigned request objects (alg=none)', () => {
    it('should return the payload claims when allowUnsigned is enabled', async () => {
      const request = `${encodeSegment({ alg: 'none' })}.${encodeSegment({
        scope: 'openid',
        nonce: 'n1',
      })}.`;

      const claims = await parseRequestObject(request, {
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: true,
      });

      expect(claims).toEqual({ scope: 'openid', nonce: 'n1' });
    });

    it('should throw RequestObjectError when allowUnsigned is disabled', async () => {
      const request = `${encodeSegment({ alg: 'none' })}.${encodeSegment({
        scope: 'openid',
      })}.`;

      await expect(
        parseRequestObject(request, {
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: false,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });

    it('should throw RequestObjectError when an alg=none object carries a signature', async () => {
      const request = `${encodeSegment({ alg: 'none' })}.${encodeSegment({
        scope: 'openid',
      })}.AAAA`;

      await expect(
        parseRequestObject(request, {
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: true,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });
  });

  describe('malformed request objects', () => {
    it('should throw RequestObjectError for a non-JWS string', async () => {
      await expect(
        parseRequestObject('not-a-jwt', {
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: true,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });

    it('should throw RequestObjectError for a JWE (5-segment) serialization', async () => {
      await expect(
        parseRequestObject('a.b.c.d.e', {
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: true,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });

    it('should throw RequestObjectError when the payload is not a JSON object', async () => {
      const request = `${encodeSegment({ alg: 'none' })}.${encodeSegment([
        'not',
        'an',
        'object',
      ])}.`;

      await expect(
        parseRequestObject(request, {
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: true,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });
  });
});
