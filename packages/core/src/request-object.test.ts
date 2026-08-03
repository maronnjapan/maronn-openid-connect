import { describe, it, expect, beforeAll } from 'vitest';
import { parseRequestObject, RequestObjectError } from './request-object.js';
import { exportPublicJwk } from './jwks.js';
import type { JwkSet } from './jwks.js';
import { sign, arrayBufferToBase64Url, stringToArrayBuffer } from './crypto-utils.js';

function encodeSegment(value: unknown): string {
  return arrayBufferToBase64Url(stringToArrayBuffer(JSON.stringify(value)));
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
        jwks,
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
          jwks,
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
          jwks,
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
          jwks,
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: false,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });

    it('should throw RequestObjectError when no JWKS is registered', async () => {
      const request = await buildSigned(
        { scope: 'openid' },
        rsaKeyPair.privateKey,
        kid,
      );

      await expect(
        parseRequestObject(request, {
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: false,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
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
