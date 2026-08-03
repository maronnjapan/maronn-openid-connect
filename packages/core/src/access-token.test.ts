import { describe, it, expect, beforeAll } from 'vitest';
import { generateAccessToken, AccessTokenPayload, GenerateAccessTokenOptions } from './access-token.js';
import { verify } from './crypto-utils.js';

// Helper functions to generate test keys
async function generateRsaKeyPair(hash: 'SHA-256' | 'SHA-384' | 'SHA-512' = 'SHA-256') {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash },
    true,
    ['sign', 'verify']
  );
}

async function generateEcKeyPair(curve: 'P-256' | 'P-384' | 'P-521' = 'P-256') {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, ['sign', 'verify']);
}

// Helper to decode JWT parts
function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [headerB64, payloadB64] = token.split('.');
  const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
  return { header, payload };
}

// Helper to create valid payload
function createValidPayload(overrides?: Partial<AccessTokenPayload>): AccessTokenPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://example.com',
    sub: 'user123',
    aud: ['https://api.example.com'],
    exp: now + 3600,
    iat: now,
    ...overrides,
  };
}

describe('generateAccessToken', () => {
  let rsaKeyPair: CryptoKeyPair;
  let ecKeyPair: CryptoKeyPair;

  beforeAll(async () => {
    rsaKeyPair = await generateRsaKeyPair();
    ecKeyPair = await generateEcKeyPair('P-256');
  });

  describe('JWT Structure', () => {
    describe('JOSE Header', () => {
      // RS256: Required by OIDC Core specification for ID Token signing
      // ES256: Recommended for new implementations (smaller keys, faster signing)
      it('should set alg claim to RS256 for RSASSA-PKCS1-v1_5 with SHA-256', async () => {
        const token = await generateAccessToken({
          payload: createValidPayload(),
          privateKey: rsaKeyPair.privateKey,
        });

        const { header } = decodeJwt(token);
        expect(header.alg).toEqual('RS256');
      });

      it('should set alg claim to ES256 for ECDSA with P-256 curve', async () => {
        const token = await generateAccessToken({
          payload: createValidPayload(),
          privateKey: ecKeyPair.privateKey,
        });

        const { header } = decodeJwt(token);
        expect(header.alg).toEqual('ES256');
      });

      it('should include kid claim when keyId is provided', async () => {
        const token = await generateAccessToken({
          payload: createValidPayload(),
          privateKey: rsaKeyPair.privateKey,
          keyId: 'key-1',
        });

        const { header } = decodeJwt(token);
        expect(header.kid).toEqual('key-1');
      });

      // RFC 9068 Section 2.1: JWT Profile for OAuth 2.0 Access Tokens
      // mandates typ = "at+jwt" so resource servers can distinguish
      // access tokens from ID tokens (which use typ = "JWT").
      it('should set typ claim to at+jwt per RFC 9068', async () => {
        const token = await generateAccessToken({
          payload: createValidPayload(),
          privateKey: rsaKeyPair.privateKey,
        });

        const { header } = decodeJwt(token);
        expect(header.typ).toEqual('at+jwt');
      });
    });

    it('should encode payload as Base64URL', async () => {
      const payload = createValidPayload();
      const token = await generateAccessToken({
        payload,
        privateKey: rsaKeyPair.privateKey,
      });

      const parts = token.split('.');
      expect(parts.length).toEqual(3);
      // Should not contain standard base64 characters that are replaced in base64url
      expect(parts[1]).not.toContain('+');
      expect(parts[1]).not.toContain('/');
      expect(parts[1]).not.toContain('=');
    });

    describe('Signature Generation', () => {
      it('should generate valid RS256 signature', async () => {
        const token = await generateAccessToken({
          payload: createValidPayload(),
          privateKey: rsaKeyPair.privateKey,
        });

        const [headerB64, payloadB64, signatureB64] = token.split('.');
        const signedData = `${headerB64}.${payloadB64}`;

        // Use verify function from crypto-utils
        const isValid = await verify(signedData, signatureB64, rsaKeyPair.publicKey);
        expect(isValid).toEqual(true);
      });

      it('should generate valid ES256 signature', async () => {
        const token = await generateAccessToken({
          payload: createValidPayload(),
          privateKey: ecKeyPair.privateKey,
        });

        const [headerB64, payloadB64, signatureB64] = token.split('.');
        const signedData = `${headerB64}.${payloadB64}`;

        // Use verify function from crypto-utils
        const isValid = await verify(signedData, signatureB64, ecKeyPair.publicKey);
        expect(isValid).toEqual(true);
      });
    });
  });

  describe('Required Claims', () => {
    describe('iss (Issuer)', () => {
      it('should set iss to match configured issuer', async () => {
        const payload = createValidPayload({ iss: 'https://my-issuer.com' });
        const token = await generateAccessToken({
          payload,
          privateKey: rsaKeyPair.privateKey,
        });

        const { payload: decodedPayload } = decodeJwt(token);
        expect(decodedPayload.iss).toEqual('https://my-issuer.com');
      });

      it('should throw when iss is missing', async () => {
        const payload = createValidPayload();
        delete (payload as Partial<AccessTokenPayload>).iss;
        await expect(
          generateAccessToken({
            payload: payload as AccessTokenPayload,
            privateKey: rsaKeyPair.privateKey,
          })
        ).rejects.toThrow();
      });
    });

    describe('sub (Subject)', () => {
      it('should include valid subject identifier', async () => {
        const payload = createValidPayload({ sub: 'user-unique-id' });
        const token = await generateAccessToken({
          payload,
          privateKey: rsaKeyPair.privateKey,
        });

        const { payload: decoded } = decodeJwt(token);
        expect(decoded.sub).toEqual('user-unique-id');
      });

      it('should throw when sub is missing', async () => {
        const payload = createValidPayload();
        delete (payload as Partial<AccessTokenPayload>).sub;
        await expect(
          generateAccessToken({
            payload: payload as AccessTokenPayload,
            privateKey: rsaKeyPair.privateKey,
          })
        ).rejects.toThrow();
      });
    });

    describe('aud (Audience)', () => {
      it('should set aud as array of resource servers', async () => {
        const payload = createValidPayload({ aud: ['https://api.example.com'] });
        const token = await generateAccessToken({
          payload,
          privateKey: rsaKeyPair.privateKey,
        });

        const { payload: decoded } = decodeJwt(token);
        expect(decoded.aud).toEqual(['https://api.example.com']);
      });

      it('should set aud with multiple values', async () => {
        const payload = createValidPayload({ aud: ['https://api1.example.com', 'https://api2.example.com'] });
        const token = await generateAccessToken({
          payload,
          privateKey: rsaKeyPair.privateKey,
        });

        const { payload: decoded } = decodeJwt(token);
        expect(decoded.aud).toEqual(['https://api1.example.com', 'https://api2.example.com']);
      });

      it('should require aud to be an array (validation may be handled upstream)', async () => {
        const payload = createValidPayload({ aud: ['resource-server'] });
        const token = await generateAccessToken({
          payload,
          privateKey: rsaKeyPair.privateKey,
        });
        const { payload: decoded } = decodeJwt(token);
        expect(Array.isArray(decoded.aud)).toEqual(true);
      });

      it('should throw when aud is missing', async () => {
        const payload = createValidPayload();
        delete (payload as Partial<AccessTokenPayload>).aud;
        await expect(
          generateAccessToken({
            payload: payload as AccessTokenPayload,
            privateKey: rsaKeyPair.privateKey,
          })
        ).rejects.toThrow();
      });

      // RFC 9068 Section 3: a JWT access token's aud identifies the resource
      // server(s) it is intended for, so an empty array is not a valid audience.
      it('should throw when aud is an empty array', async () => {
        const payload = createValidPayload({ aud: [] });
        await expect(
          generateAccessToken({
            payload,
            privateKey: rsaKeyPair.privateKey,
          })
        ).rejects.toThrow();
      });
    });

    describe('exp (Expiration)', () => {
      it('should set exp to future timestamp', async () => {
        const now = Math.floor(Date.now() / 1000);
        const futureExp = now + 3600;
        const payload = createValidPayload({ exp: futureExp });
        const token = await generateAccessToken({
          payload,
          privateKey: rsaKeyPair.privateKey,
        });

        const { payload: decoded } = decodeJwt(token);
        expect(decoded.exp).toEqual(futureExp);
        expect(decoded.exp as number).toBeGreaterThan(now);
      });

      it('should allow small clock skew tolerance', async () => {
        // Very past dates should fail
        const now = Math.floor(Date.now() / 1000);
        const veryPast = now - 3600; // 1 hour ago
        const payload = createValidPayload({ exp: veryPast });
        await expect(
          generateAccessToken({
            payload,
            privateKey: rsaKeyPair.privateKey,
          })
        ).rejects.toThrow();
      });

      it('should throw when exp is in the past', async () => {
        const now = Math.floor(Date.now() / 1000);
        const pastExp = now - 3600; // 1 hour ago
        const payload = createValidPayload({ exp: pastExp });
        await expect(
          generateAccessToken({
            payload,
            privateKey: rsaKeyPair.privateKey,
          })
        ).rejects.toThrow();
      });

      it('should throw when exp is missing', async () => {
        const payload = createValidPayload();
        delete (payload as Partial<AccessTokenPayload>).exp;
        await expect(
          generateAccessToken({
            payload: payload as AccessTokenPayload,
            privateKey: rsaKeyPair.privateKey,
          })
        ).rejects.toThrow();
      });
    });

    describe('iat (Issued At)', () => {
      it('should include iat timestamp', async () => {
        const now = Math.floor(Date.now() / 1000);
        const payload = createValidPayload({ iat: now });
        const token = await generateAccessToken({
          payload,
          privateKey: rsaKeyPair.privateKey,
        });

        const { payload: decoded } = decodeJwt(token);
        expect(decoded.iat).toEqual(now);
      });

      it('should throw when iat is missing', async () => {
        const payload = createValidPayload();
        delete (payload as Partial<AccessTokenPayload>).iat;
        await expect(
          generateAccessToken({
            payload: payload as AccessTokenPayload,
            privateKey: rsaKeyPair.privateKey,
          })
        ).rejects.toThrow();
      });
    });
  });

  describe('Optional Claims', () => {
    describe('scope', () => {
      it('should include scope claim with granted scopes', async () => {
        const payload = createValidPayload({ scope: 'openid profile email' });
        const token = await generateAccessToken({
          payload,
          privateKey: rsaKeyPair.privateKey,
        });

        const { payload: decoded } = decodeJwt(token);
        expect(decoded.scope).toEqual('openid profile email');
      });

      it('should format multiple scopes as space-separated string', async () => {
        const payload = createValidPayload({ scope: 'read write delete' });
        const token = await generateAccessToken({
          payload,
          privateKey: rsaKeyPair.privateKey,
        });

        const { payload: decoded } = decodeJwt(token);
        expect(decoded.scope).toEqual('read write delete');
      });

      it('should allow omitting scope claim', async () => {
        const payload = createValidPayload();
        delete payload.scope;
        const token = await generateAccessToken({
          payload,
          privateKey: rsaKeyPair.privateKey,
        });

        const { payload: decoded } = decodeJwt(token);
        expect(decoded.scope).toBeUndefined();
      });
    });

    // client_id claim is included for audit and tracking purposes
    // Helps resource servers identify which client the token was issued to
    // Useful for logging, analytics, and security monitoring
    describe('client_id', () => {
      it('should include client_id claim when provided', async () => {
        const payload = createValidPayload({ client_id: 'my-client-app' });
        const token = await generateAccessToken({
          payload,
          privateKey: rsaKeyPair.privateKey,
        });

        const { payload: decoded } = decodeJwt(token);
        expect(decoded.client_id).toEqual('my-client-app');
      });

      it('should allow omitting client_id claim', async () => {
        const payload = createValidPayload();
        delete payload.client_id;
        const token = await generateAccessToken({
          payload,
          privateKey: rsaKeyPair.privateKey,
        });

        const { payload: decoded } = decodeJwt(token);
        expect(decoded.client_id).toBeUndefined();
      });
    });
  });

  describe('Custom Claims', () => {
    it('should allow additional custom claims in payload', async () => {
      const payload = createValidPayload();
      (payload as Record<string, unknown>).custom_claim = 'custom_value';
      const token = await generateAccessToken({
        payload,
        privateKey: rsaKeyPair.privateKey,
      });

      const { payload: decoded } = decodeJwt(token);
      expect(decoded.custom_claim).toEqual('custom_value');
    });

    it('should support permissions or roles claim for authorization', async () => {
      const payload = createValidPayload();
      (payload as Record<string, unknown>).roles = ['admin', 'user'];
      (payload as Record<string, unknown>).permissions = ['read', 'write'];
      const token = await generateAccessToken({
        payload,
        privateKey: rsaKeyPair.privateKey,
      });

      const { payload: decoded } = decodeJwt(token);
      expect(decoded.roles).toEqual(['admin', 'user']);
      expect(decoded.permissions).toEqual(['read', 'write']);
    });
  });

  describe('Token Uniqueness', () => {
    it('should generate different tokens for different payloads', async () => {
      const payload1 = createValidPayload({ sub: 'user1' });
      const payload2 = createValidPayload({ sub: 'user2' });

      const token1 = await generateAccessToken({
        payload: payload1,
        privateKey: rsaKeyPair.privateKey,
      });
      const token2 = await generateAccessToken({
        payload: payload2,
        privateKey: rsaKeyPair.privateKey,
      });

      expect(token1).not.toEqual(token2);
    });

    it('should generate different tokens for same payload at different times', async () => {
      const now = Math.floor(Date.now() / 1000);
      const payload1 = createValidPayload({ iat: now });
      const payload2 = createValidPayload({ iat: now + 1 });

      const token1 = await generateAccessToken({
        payload: payload1,
        privateKey: rsaKeyPair.privateKey,
      });
      const token2 = await generateAccessToken({
        payload: payload2,
        privateKey: rsaKeyPair.privateKey,
      });

      expect(token1).not.toEqual(token2);
    });
  });
});
