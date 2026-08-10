import type { SigningKey } from '@maronn-openid-connect/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertJarmLifetimeSeconds,
  buildJarmRedirectUrl,
  createJarmResponseJwt,
} from './response-jwt.js';

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

// 2026-08-04T00:00:00Z. Injected so every exp assertion is a fixed value.
const NOW = new Date('2026-08-04T00:00:00.000Z');
const NOW_SECONDS = 1785801600;

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
  signingKey = { privateKey: keyPair.privateKey, publicJwk, keyId: 'jarm-key-1' };
  publicKey = keyPair.publicKey;
});

describe('createJarmResponseJwt', () => {
  describe('JOSE Header', () => {
    // JARM §2.2 / §3: the OP signs with RS256 (the default when the client
    // registered no authorization_signed_response_alg). alg is not configurable,
    // so `none` (rejected by clients per §2.4) can never be produced.
    it('should set alg to RS256 and kid to the signing key id without a typ header', async () => {
      const jwt = await createJarmResponseJwt({
        issuer: 'http://localhost:3000',
        clientId: 'my-client',
        parameters: { code: 'auth-code-1' },
        signingKey,
        now: NOW,
      });

      expect(header(jwt)).toEqual({ alg: 'RS256', kid: 'jarm-key-1' });
    });
  });

  describe('Success response claims', () => {
    // JARM §2.1: iss / aud / exp are REQUIRED, and the authorization response
    // parameters travel as claims of the same JWT.
    it('should carry iss, aud, exp, code and state as claims', async () => {
      const jwt = await createJarmResponseJwt({
        issuer: 'http://localhost:3000',
        clientId: 'my-client',
        parameters: { code: 'auth-code-1', state: 'S8NJ7' },
        signingKey,
        now: NOW,
      });

      expect(payload(jwt)).toEqual({
        iss: 'http://localhost:3000',
        aud: 'my-client',
        exp: NOW_SECONDS + 60,
        code: 'auth-code-1',
        state: 'S8NJ7',
      });
    });

    // JARM §2.1: state is present in the response only when the request had one.
    it('should omit the state claim entirely when state is undefined', async () => {
      const jwt = await createJarmResponseJwt({
        issuer: 'http://localhost:3000',
        clientId: 'my-client',
        parameters: { code: 'auth-code-1', state: undefined },
        signingKey,
        now: NOW,
      });

      expect(payload(jwt)).toEqual({
        iss: 'http://localhost:3000',
        aud: 'my-client',
        exp: NOW_SECONDS + 60,
        code: 'auth-code-1',
      });
    });

    it('should default the response JWT lifetime to 60 seconds', async () => {
      const jwt = await createJarmResponseJwt({
        issuer: 'http://localhost:3000',
        clientId: 'my-client',
        parameters: { code: 'auth-code-1' },
        signingKey,
        now: NOW,
      });

      expect(payload(jwt)['exp']).toBe(NOW_SECONDS + 60);
    });

    it('should set exp to now plus the requested lifetime', async () => {
      const jwt = await createJarmResponseJwt({
        issuer: 'http://localhost:3000',
        clientId: 'my-client',
        parameters: { code: 'auth-code-1' },
        signingKey,
        lifetimeSeconds: 600,
        now: NOW,
      });

      expect(payload(jwt)['exp']).toBe(NOW_SECONDS + 600);
    });

    // Sub-second precision must not leak into exp: JWT NumericDate is seconds.
    it('should floor exp to whole seconds', async () => {
      const jwt = await createJarmResponseJwt({
        issuer: 'http://localhost:3000',
        clientId: 'my-client',
        parameters: { code: 'auth-code-1' },
        signingKey,
        now: new Date(NOW.getTime() + 999),
      });

      expect(payload(jwt)['exp']).toBe(NOW_SECONDS + 60);
    });

    // The protocol claims are the OP's own statement about the response. A
    // caller-supplied parameter of the same name must not be able to restate it.
    it('should keep iss, aud and exp non-overridable by response parameters', async () => {
      const jwt = await createJarmResponseJwt({
        issuer: 'http://localhost:3000',
        clientId: 'my-client',
        parameters: {
          code: 'auth-code-1',
          iss: 'https://evil.example',
          aud: 'other-client',
          exp: '9999999999',
        },
        signingKey,
        now: NOW,
      });

      expect(payload(jwt)).toEqual({
        iss: 'http://localhost:3000',
        aud: 'my-client',
        exp: NOW_SECONDS + 60,
        code: 'auth-code-1',
      });
    });
  });

  describe('Error response claims', () => {
    // JARM §2.1 error example: the error response is the same JWT shape with
    // error / error_description / state instead of code.
    it('should carry error, error_description and state as claims', async () => {
      const jwt = await createJarmResponseJwt({
        issuer: 'http://localhost:3000',
        clientId: 'my-client',
        parameters: {
          error: 'access_denied',
          error_description: 'User denied the request',
          state: 'S8NJ7',
        },
        signingKey,
        now: NOW,
      });

      expect(payload(jwt)).toEqual({
        iss: 'http://localhost:3000',
        aud: 'my-client',
        exp: NOW_SECONDS + 60,
        error: 'access_denied',
        error_description: 'User denied the request',
        state: 'S8NJ7',
      });
    });

    it('should omit error_description when it is undefined', async () => {
      const jwt = await createJarmResponseJwt({
        issuer: 'http://localhost:3000',
        clientId: 'my-client',
        parameters: {
          error: 'access_denied',
          error_description: undefined,
          state: 'S8NJ7',
        },
        signingKey,
        now: NOW,
      });

      expect(payload(jwt)).toEqual({
        iss: 'http://localhost:3000',
        aud: 'my-client',
        exp: NOW_SECONDS + 60,
        error: 'access_denied',
        state: 'S8NJ7',
      });
    });
  });

  describe('Signature', () => {
    // JARM §2.4: the client verifies the JWS with a key resolved from the OP's
    // jwks_uri via kid. The compact serialization must therefore verify against
    // the public half of the signing key.
    it('should produce a compact JWS that verifies with the signing key public half', async () => {
      const jwt = await createJarmResponseJwt({
        issuer: 'http://localhost:3000',
        clientId: 'my-client',
        parameters: { code: 'auth-code-1', state: 'S8NJ7' },
        signingKey,
        now: NOW,
      });
      const [encodedHeader, encodedPayload] = jwt.split('.');
      const verified = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        publicKey,
        signatureBytes(jwt),
        new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
      );

      expect(verified).toBe(true);
    });

    it('should produce exactly three base64url segments', async () => {
      const jwt = await createJarmResponseJwt({
        issuer: 'http://localhost:3000',
        clientId: 'my-client',
        parameters: { code: 'auth-code-1' },
        signingKey,
        now: NOW,
      });

      expect(jwt.split('.')).toHaveLength(3);
      expect(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)).toBe(true);
    });

    // JARM §3 / RFC 7515 §4.1.1: this function always declares `alg: RS256`, so
    // the JOSE header would lie about the signature if it accepted another key
    // type. Web Crypto refuses to sign with a mismatched key, which is what pins
    // the contract "signingKey MUST be an RS256 key" — the caller (the CLI
    // generated code) is responsible for selecting one.
    it('should reject an ES256 signing key instead of signing under the RS256 header', async () => {
      const ecdsaKeyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      const ecdsaPublicJwk = await crypto.subtle.exportKey('jwk', ecdsaKeyPair.publicKey);

      await expect(
        createJarmResponseJwt({
          issuer: 'http://localhost:3000',
          clientId: 'my-client',
          parameters: { code: 'auth-code-1' },
          signingKey: {
            privateKey: ecdsaKeyPair.privateKey,
            publicJwk: ecdsaPublicJwk,
            keyId: 'es256-key',
          },
          now: NOW,
        }),
      ).rejects.toThrow();
    });

    // Non-ASCII claim values must survive as UTF-8 before base64url encoding.
    it('should encode non-ASCII claim values as UTF-8', async () => {
      const jwt = await createJarmResponseJwt({
        issuer: 'http://localhost:3000',
        clientId: 'クライアント',
        parameters: { code: 'auth-code-1' },
        signingKey,
        now: NOW,
      });

      expect(payload(jwt)['aud']).toBe('クライアント');
    });
  });
});

describe('buildJarmRedirectUrl', () => {
  // JARM §2.3.1: the response is delivered as the single `response` query
  // parameter. No plain code / state / iss parameter is added.
  it('should append only the response parameter to the redirect URI', () => {
    expect(buildJarmRedirectUrl('https://client.example.com/cb', 'header.payload.signature')).toBe(
      'https://client.example.com/cb?response=header.payload.signature',
    );
  });

  it('should preserve query parameters already present on the redirect URI', () => {
    expect(buildJarmRedirectUrl('https://client.example.com/cb?tenant=a', 'a.b.c')).toBe(
      'https://client.example.com/cb?tenant=a&response=a.b.c',
    );
  });

  it('should replace an existing response parameter instead of appending a second one', () => {
    expect(buildJarmRedirectUrl('https://client.example.com/cb?response=stale', 'a.b.c')).toBe(
      'https://client.example.com/cb?response=a.b.c',
    );
  });
});

describe('assertJarmLifetimeSeconds', () => {
  // JARM §2.1: "The JWT MUST have an expiration time (exp) ... a maximum
  // lifetime of 10 minutes is RECOMMENDED."
  describe('Accepted values', () => {
    it('should accept the lower bound of 5 seconds', () => {
      expect(() => assertJarmLifetimeSeconds(5)).not.toThrow();
    });

    it('should accept the upper bound of 600 seconds', () => {
      expect(() => assertJarmLifetimeSeconds(600)).not.toThrow();
    });

    it('should accept the default of 60 seconds', () => {
      expect(() => assertJarmLifetimeSeconds(60)).not.toThrow();
    });
  });

  describe('Rejected values', () => {
    it('should reject 4 seconds as below the lower bound', () => {
      expect(() => assertJarmLifetimeSeconds(4)).toThrow(
        'jarmConfig.jarmResponseLifetimeSeconds must be an integer between 5 and 600 seconds (JARM Section 2.1), got 4',
      );
    });

    it('should reject 601 seconds as above the upper bound', () => {
      expect(() => assertJarmLifetimeSeconds(601)).toThrow(
        'jarmConfig.jarmResponseLifetimeSeconds must be an integer between 5 and 600 seconds (JARM Section 2.1), got 601',
      );
    });

    it('should reject a non-integer lifetime', () => {
      expect(() => assertJarmLifetimeSeconds(60.5)).toThrow(
        'jarmConfig.jarmResponseLifetimeSeconds must be an integer between 5 and 600 seconds (JARM Section 2.1), got 60.5',
      );
    });

    it('should reject NaN', () => {
      expect(() => assertJarmLifetimeSeconds(Number.NaN)).toThrow(
        'jarmConfig.jarmResponseLifetimeSeconds must be an integer between 5 and 600 seconds (JARM Section 2.1), got NaN',
      );
    });
  });
});
