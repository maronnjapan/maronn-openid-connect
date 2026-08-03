import { describe, it, expect, beforeAll } from 'vitest';
import {
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
} from './access-token-issuer.js';
import type { AccessTokenPayload } from './access-token.js';

async function generateRsaKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
}

function buildPayload(overrides?: Partial<AccessTokenPayload>): AccessTokenPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://example.com',
    sub: 'user-1',
    aud: ['https://api.example.com'],
    exp: now + 3600,
    iat: now,
    ...overrides,
  };
}

describe('createJwtAccessTokenIssuer', () => {
  let keyPair: CryptoKeyPair;

  beforeAll(async () => {
    keyPair = await generateRsaKeyPair();
  });

  it('should issue a JWT with three dot-separated segments', async () => {
    const issuer = createJwtAccessTokenIssuer();
    const token = await issuer.issue({
      payload: buildPayload(),
      privateKey: keyPair.privateKey,
    });
    expect(token.split('.').length).toBe(3);
  });

  it('should embed payload claims (sub, iss) in the JWT body', async () => {
    const issuer = createJwtAccessTokenIssuer();
    const token = await issuer.issue({
      payload: buildPayload({ sub: 'alice' }),
      privateKey: keyPair.privateKey,
    });
    const [, payloadB64] = token.split('.');
    const json = JSON.parse(
      atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')),
    );
    expect(json.sub).toBe('alice');
    expect(json.iss).toBe('https://example.com');
  });

  it('should set kid in header when keyId is provided', async () => {
    const issuer = createJwtAccessTokenIssuer();
    const token = await issuer.issue({
      payload: buildPayload(),
      privateKey: keyPair.privateKey,
      keyId: 'kid-test',
    });
    const [headerB64] = token.split('.');
    const header = JSON.parse(
      atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')),
    );
    expect(header.kid).toBe('kid-test');
  });

  it('should reject when privateKey is missing', async () => {
    const issuer = createJwtAccessTokenIssuer();
    await expect(
      issuer.issue({ payload: buildPayload() }),
    ).rejects.toThrow(/privateKey/);
  });

  // RFC 9068 §2.2 lists nbf as an OPTIONAL claim; RFC 7519 §4.1.5 defines it as
  // "not before". We emit nbf = iat for clock-skew tolerance and interop with RPs
  // that expect it (Auth0 / Keycloak emit nbf by default).
  describe('nbf claim (RFC 9068 §2.2 / RFC 7519 §4.1.5)', () => {
    function decodePayload(token: string): Record<string, unknown> {
      const [, payloadB64] = token.split('.');
      return JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    }

    it('should include nbf claim in the JWT payload', async () => {
      const issuer = createJwtAccessTokenIssuer();
      const token = await issuer.issue({
        payload: buildPayload(),
        privateKey: keyPair.privateKey,
      });
      const json = decodePayload(token);
      expect(typeof json.nbf).toBe('number');
    });

    it('should set nbf equal to iat', async () => {
      const now = Math.floor(Date.now() / 1000);
      const issuer = createJwtAccessTokenIssuer();
      const token = await issuer.issue({
        payload: buildPayload({ iat: now }),
        privateKey: keyPair.privateKey,
      });
      const json = decodePayload(token);
      expect(json.nbf).toBe(now);
      expect(json.nbf).toBe(json.iat);
    });

    it('should preserve an explicitly provided nbf', async () => {
      const now = Math.floor(Date.now() / 1000);
      const issuer = createJwtAccessTokenIssuer();
      const token = await issuer.issue({
        payload: buildPayload({ iat: now, nbf: now - 5 }),
        privateKey: keyPair.privateKey,
      });
      const json = decodePayload(token);
      expect(json.nbf).toBe(now - 5);
    });
  });
});

describe('createOpaqueAccessTokenIssuer', () => {
  it('should return a non-empty random string without dot separators', async () => {
    const issuer = createOpaqueAccessTokenIssuer();
    const token = await issuer.issue({ payload: buildPayload() });
    expect(token.length).toBeGreaterThan(0);
    // Opaque token must not be misread as a JWT (3 dot-separated parts)
    expect(token.includes('.')).toBe(false);
  });

  it('should produce unique tokens across calls', async () => {
    const issuer = createOpaqueAccessTokenIssuer();
    const a = await issuer.issue({ payload: buildPayload() });
    const b = await issuer.issue({ payload: buildPayload() });
    expect(a).not.toBe(b);
  });

  it('should respect the configured byteLength', async () => {
    const issuer = createOpaqueAccessTokenIssuer(16);
    const token = await issuer.issue({ payload: buildPayload() });
    // 16 bytes -> 22 characters of base64url (no padding)
    expect(token.length).toBe(22);
  });

  it('should default to 32 bytes when byteLength is not provided', async () => {
    const issuer = createOpaqueAccessTokenIssuer();
    const token = await issuer.issue({ payload: buildPayload() });
    // 32 bytes -> 43 characters of base64url (no padding)
    expect(token.length).toBe(43);
  });

  it('should reject zero or negative byteLength', () => {
    expect(() => createOpaqueAccessTokenIssuer(0)).toThrow();
    expect(() => createOpaqueAccessTokenIssuer(-1)).toThrow();
  });

  it('should not embed payload claims in the token string', async () => {
    const issuer = createOpaqueAccessTokenIssuer();
    const token = await issuer.issue({
      payload: buildPayload({ sub: 'sensitive-user-id' }),
    });
    expect(token).not.toContain('sensitive-user-id');
  });
});
