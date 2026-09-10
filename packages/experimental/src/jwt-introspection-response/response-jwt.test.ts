import type { IntrospectionResponse, SigningKey } from '@maronn-openid-connect/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_INTROSPECTION_JWT_TYP, createIntrospectionResponseJwt } from './response-jwt.js';

function decodeSegment(segment: string): Record<string, unknown> {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function header(jwt: string): Record<string, unknown> {
  return decodeSegment(jwt.split('.')[0] ?? '');
}

function payload(jwt: string): Record<string, unknown> {
  return decodeSegment(jwt.split('.')[1] ?? '');
}

function signatureBytes(jwt: string): Uint8Array {
  const segment = jwt.split('.')[2] ?? '';
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

// 2026-08-24T00:00:00Z. Injected so every iat assertion is a fixed value.
const NOW = new Date('2026-08-24T00:00:00.000Z');
const NOW_SECONDS = 1787529600;

const ACTIVE_INTROSPECTION: IntrospectionResponse = {
  active: true,
  scope: 'openid',
  client_id: 'rs-client',
  token_type: 'Bearer',
  sub: 'testuser',
  exp: NOW_SECONDS + 3600,
};

let signingKey: SigningKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  signingKey = { privateKey: keyPair.privateKey, publicJwk, keyId: 'introspection-key-1' };
  publicKey = keyPair.publicKey;
});

describe('createIntrospectionResponseJwt', () => {
  describe('JOSE Header', () => {
    // RFC 9701 §5 REQUIRED typ + §8.1: the typ header is what stops the response
    // JWT from being replayed as an access token or ID token.
    it('should set typ to token-introspection+jwt, alg to RS256 and kid to the signing key id', async () => {
      const jwt = await createIntrospectionResponseJwt({
        issuer: 'http://localhost:3000',
        audience: 'rs-client',
        introspection: ACTIVE_INTROSPECTION,
        signingKey,
        now: NOW,
      });

      expect(header(jwt)).toEqual({
        typ: 'token-introspection+jwt',
        alg: 'RS256',
        kid: 'introspection-key-1',
      });
    });
  });

  describe('Payload claims (RFC 9701 §5)', () => {
    it('should carry iss, aud, iat and the token_introspection claim with the response verbatim', async () => {
      const jwt = await createIntrospectionResponseJwt({
        issuer: 'http://localhost:3000',
        audience: 'rs-client',
        introspection: ACTIVE_INTROSPECTION,
        signingKey,
        now: NOW,
      });

      expect(payload(jwt)).toEqual({
        iss: 'http://localhost:3000',
        aud: 'rs-client',
        iat: NOW_SECONDS,
        token_introspection: {
          active: true,
          scope: 'openid',
          client_id: 'rs-client',
          token_type: 'Bearer',
          sub: 'testuser',
          exp: NOW_SECONDS + 3600,
        },
      });
    });

    // RFC 9701 §5 SHOULD NOT: top-level sub / exp would let the JWT pass for an
    // access token; the member set is pinned so neither can appear.
    it('should not put sub or exp on the top level', async () => {
      const jwt = await createIntrospectionResponseJwt({
        issuer: 'http://localhost:3000',
        audience: 'rs-client',
        introspection: ACTIVE_INTROSPECTION,
        signingKey,
        now: NOW,
      });

      expect(Object.keys(payload(jwt))).toEqual(['iss', 'aud', 'iat', 'token_introspection']);
    });

    // RFC 9701 §5: an unknown or expired token is answered with the same JWT
    // structure whose token_introspection carries only active: false.
    it('should wrap an inactive response as token_introspection with active false only', async () => {
      const jwt = await createIntrospectionResponseJwt({
        issuer: 'http://localhost:3000',
        audience: 'rs-client',
        introspection: { active: false },
        signingKey,
        now: NOW,
      });

      expect(payload(jwt)).toEqual({
        iss: 'http://localhost:3000',
        aud: 'rs-client',
        iat: NOW_SECONDS,
        token_introspection: { active: false },
      });
    });

    it('should derive iat deterministically from the injected now', async () => {
      const jwt = await createIntrospectionResponseJwt({
        issuer: 'http://localhost:3000',
        audience: 'rs-client',
        introspection: { active: false },
        signingKey,
        now: new Date('2026-08-24T00:00:59.999Z'),
      });

      expect(payload(jwt).iat).toBe(NOW_SECONDS + 59);
    });
  });

  describe('Signature', () => {
    it('should produce a compact JWS whose signature verifies with the public key', async () => {
      const jwt = await createIntrospectionResponseJwt({
        issuer: 'http://localhost:3000',
        audience: 'rs-client',
        introspection: ACTIVE_INTROSPECTION,
        signingKey,
        now: NOW,
      });

      const [encodedHeader = '', encodedPayload = ''] = jwt.split('.');
      const verified = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        publicKey,
        signatureBytes(jwt),
        new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
      );

      expect(jwt.split('.').length).toBe(3);
      expect(verified).toBe(true);
    });
  });

  describe('typ constant', () => {
    it('should expose the RFC 9701 typ value verbatim', () => {
      expect(TOKEN_INTROSPECTION_JWT_TYP).toBe('token-introspection+jwt');
    });
  });
});
