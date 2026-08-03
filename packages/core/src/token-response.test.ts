import { describe, it, expect, beforeAll } from 'vitest';
import { generateTokenResponse, buildAccessTokenAudience, buildIdTokenAudience } from './token-response.js';
import type { TokenResponseOptions, TokenResponse } from './token-response.js';
import { base64UrlToArrayBuffer, arrayBufferToBase64Url, stringToArrayBuffer } from './crypto-utils.js';

// --- Helper: RSA鍵ペアの生成 ---
let rsaKeyPair: CryptoKeyPair;

beforeAll(async () => {
  rsaKeyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
});

function createValidOptions(overrides?: Partial<TokenResponseOptions>): TokenResponseOptions {
  const now = Math.floor(Date.now() / 1000);
  return {
    issuer: 'https://op.example.com',
    subject: 'user-123',
    clientId: 'client-456',
    scope: ['openid', 'profile'],
    privateKey: rsaKeyPair.privateKey,
    accessTokenExpiresIn: 3600,
    idTokenExpiresIn: 3600,
    ...overrides,
  };
}

/**
 * JWTをデコードするヘルパー
 */
function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const parts = token.split('.');
  const header = JSON.parse(new TextDecoder().decode(base64UrlToArrayBuffer(parts[0]!)));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToArrayBuffer(parts[1]!)));
  return { header, payload };
}

describe('generateTokenResponse', () => {
  describe('Token Response structure', () => {
    it('should return access_token', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      expect(response.access_token).toBeDefined();
      expect(typeof response.access_token).toBe('string');
      expect(response.access_token.length).toBeGreaterThan(0);
    });

    it('should return token_type as Bearer', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      expect(response.token_type).toBe('Bearer');
    });

    it('should return expires_in', async () => {
      const options = createValidOptions({ accessTokenExpiresIn: 7200 });
      const { response } = await generateTokenResponse(options);
      expect(response.expires_in).toBe(7200);
    });

    it('should return id_token', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      expect(response.id_token).toBeDefined();
      expect(typeof response.id_token).toBe('string');
    });

    it('should include scope in the token response', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      // OAuth 2.1 Section 3.2.3: scope is REQUIRED if different from requested,
      // OPTIONAL otherwise. We always include it for clarity and conformance.
      expect(response.scope).toBeDefined();
      expect(typeof response.scope).toBe('string');
    });

    it('should include scope as space-delimited string', async () => {
      const options = createValidOptions({ scope: ['openid', 'profile', 'email'] });
      const { response } = await generateTokenResponse(options);
      expect(response.scope).toBe('openid profile email');
    });

    it('should include single scope without trailing space', async () => {
      const options = createValidOptions({ scope: ['openid'] });
      const { response } = await generateTokenResponse(options);
      expect(response.scope).toBe('openid');
    });
  });

  describe('Access Token (JWT)', () => {
    it('should be a valid JWT with three parts', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      const parts = response.access_token.split('.');
      expect(parts).toHaveLength(3);
    });

    it('should have iss claim matching issuer', async () => {
      const options = createValidOptions({ issuer: 'https://op.example.com' });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.access_token);
      expect(payload.iss).toBe('https://op.example.com');
    });

    it('should have sub claim matching subject', async () => {
      const options = createValidOptions({ subject: 'user-abc' });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.access_token);
      expect(payload.sub).toBe('user-abc');
    });

    it('should have client_id claim', async () => {
      const options = createValidOptions({ clientId: 'client-xyz' });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.access_token);
      expect(payload.client_id).toBe('client-xyz');
    });

    it('should use provided audience for aud claim', async () => {
      const options = createValidOptions({
        audience: ['https://api.example.com', 'https://other.example.com'],
      });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.access_token);
      expect(payload.aud).toEqual(['https://api.example.com', 'https://other.example.com']);
    });

    // RFC 9068 Section 3: a JWT access token MUST carry a non-empty aud.
    // When no audience is supplied, the issuer (the OP itself) is used as the
    // default audience so the token is never issued with an empty aud.
    it('should default aud to issuer when audience is not provided', async () => {
      const options = createValidOptions({ issuer: 'https://op.default-aud.com' });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.access_token);
      expect(payload.aud).toEqual(['https://op.default-aud.com']);
    });

    it('should default aud to issuer when audience is an empty array', async () => {
      const options = createValidOptions({ issuer: 'https://op.empty-aud.com', audience: [] });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.access_token);
      expect(payload.aud).toEqual(['https://op.empty-aud.com']);
    });

    it('should never issue a JWT access token with an empty aud', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.access_token);
      expect(Array.isArray(payload.aud)).toBe(true);
      expect((payload.aud as string[]).length).toBeGreaterThan(0);
    });

    // OIDC Core 1.0 Section 12 / RFC 9068: refresh_token grant must preserve the
    // original aud. The caller passes the stored audience back into the request,
    // so an explicitly-supplied audience is retained across rotations.
    it('should retain the same aud when audience is passed again (refresh case)', async () => {
      const audience = ['https://api.example.com'];
      const first = await generateTokenResponse(createValidOptions({ audience }));
      const second = await generateTokenResponse(createValidOptions({ audience }));
      expect(decodeJwt(first.response.access_token).payload.aud).toEqual(audience);
      expect(decodeJwt(second.response.access_token).payload.aud).toEqual(audience);
    });

    it('should retain the default issuer aud across successive issuances (refresh case)', async () => {
      const options = createValidOptions({ issuer: 'https://op.refresh-default.com' });
      const first = await generateTokenResponse(options);
      const second = await generateTokenResponse(options);
      expect(decodeJwt(first.response.access_token).payload.aud).toEqual(['https://op.refresh-default.com']);
      expect(decodeJwt(second.response.access_token).payload.aud).toEqual(['https://op.refresh-default.com']);
    });

    it('should have scope claim as space-separated string', async () => {
      const options = createValidOptions({ scope: ['openid', 'profile', 'email'] });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.access_token);
      expect(payload.scope).toBe('openid profile email');
    });

    it('should have exp claim', async () => {
      const options = createValidOptions({ accessTokenExpiresIn: 3600 });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.access_token);
      expect(payload.exp).toBeDefined();
      const now = Math.floor(Date.now() / 1000);
      expect(payload.exp as number).toBeGreaterThanOrEqual(now + 3500);
      expect(payload.exp as number).toBeLessThanOrEqual(now + 3700);
    });

    it('should have iat claim', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.access_token);
      expect(payload.iat).toBeDefined();
      const now = Math.floor(Date.now() / 1000);
      expect(payload.iat as number).toBeGreaterThanOrEqual(now - 5);
      expect(payload.iat as number).toBeLessThanOrEqual(now + 5);
    });

    it('should include kid in header when keyId is provided', async () => {
      const options = createValidOptions({ keyId: 'my-key-1' });
      const { response } = await generateTokenResponse(options);
      const { header } = decodeJwt(response.access_token);
      expect(header.kid).toBe('my-key-1');
    });
  });

  describe('ID Token (JWT)', () => {
    it('should be a valid JWT with three parts', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      const parts = response.id_token.split('.');
      expect(parts).toHaveLength(3);
    });

    it('should have iss claim matching issuer', async () => {
      const options = createValidOptions({ issuer: 'https://op.example.com' });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token);
      expect(payload.iss).toBe('https://op.example.com');
    });

    it('should have sub claim matching subject', async () => {
      const options = createValidOptions({ subject: 'user-def' });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token);
      expect(payload.sub).toBe('user-def');
    });

    it('should have aud claim matching clientId', async () => {
      const options = createValidOptions({ clientId: 'client-aud' });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token);
      expect(payload.aud).toBe('client-aud');
    });

    it('should have exp claim', async () => {
      const options = createValidOptions({ idTokenExpiresIn: 1800 });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token);
      const now = Math.floor(Date.now() / 1000);
      expect(payload.exp as number).toBeGreaterThanOrEqual(now + 1700);
      expect(payload.exp as number).toBeLessThanOrEqual(now + 1900);
    });

    it('should have iat claim', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token);
      const now = Math.floor(Date.now() / 1000);
      expect(payload.iat as number).toBeGreaterThanOrEqual(now - 5);
      expect(payload.iat as number).toBeLessThanOrEqual(now + 5);
    });

    it('should include nonce when provided', async () => {
      const options = createValidOptions({ nonce: 'test-nonce-123' });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token);
      expect(payload.nonce).toBe('test-nonce-123');
    });

    it('should not include nonce when not provided', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token);
      expect(payload.nonce).toBeUndefined();
    });

    // OIDC Core 1.0 Section 3.1.3.6: at_hash
    it('should include at_hash claim', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token);
      expect(payload.at_hash).toBeDefined();
      expect(typeof payload.at_hash).toBe('string');
    });

    it('should compute at_hash as left half of SHA-256 hash of access_token', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token);

      // Manually compute at_hash: SHA-256 of access_token, take left 128 bits, base64url encode
      const accessTokenBytes = stringToArrayBuffer(response.access_token);
      const hashBuffer = await crypto.subtle.digest('SHA-256', accessTokenBytes);
      const leftHalf = hashBuffer.slice(0, hashBuffer.byteLength / 2);
      const expectedAtHash = arrayBufferToBase64Url(leftHalf);

      expect(payload.at_hash).toBe(expectedAtHash);
    });

    // OIDC Core 1.0 §3.1.3.6: "the hash algorithm used is the hash algorithm used
    // in the `alg` Header Parameter of the ID Token's JOSE Header." When the ID Token
    // is signed with a non-SHA-256 alg, at_hash must follow that alg's hash function.
    describe('at_hash hash algorithm agility', () => {
      // Helper: compute the spec-defined hash claim value for an access token.
      async function expectedHash(
        accessToken: string,
        hashName: 'SHA-256' | 'SHA-384' | 'SHA-512',
      ): Promise<string> {
        const hashBuffer = await crypto.subtle.digest(hashName, stringToArrayBuffer(accessToken));
        const leftHalf = hashBuffer.slice(0, hashBuffer.byteLength / 2);
        return arrayBufferToBase64Url(leftHalf);
      }

      async function generateRsaKey(hash: 'SHA-256' | 'SHA-384' | 'SHA-512'): Promise<CryptoKeyPair> {
        return crypto.subtle.generateKey(
          {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash,
          },
          true,
          ['sign', 'verify'],
        );
      }

      async function generateEcKey(namedCurve: 'P-256' | 'P-384' | 'P-521'): Promise<CryptoKeyPair> {
        return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve }, true, ['sign', 'verify']);
      }

      it('should compute at_hash with SHA-256 left half (16 bytes) for RS256 id_token', async () => {
        const key = await generateRsaKey('SHA-256');
        const options = createValidOptions({ idTokenPrivateKey: key.privateKey });
        const { response } = await generateTokenResponse(options);
        const { payload } = decodeJwt(response.id_token);

        const expected = await expectedHash(response.access_token, 'SHA-256');
        expect(payload.at_hash).toBe(expected);
        // SHA-256 (32 bytes) -> left half 16 bytes -> base64url length 22
        expect((payload.at_hash as string).length).toBe(22);
      });

      it('should compute at_hash with SHA-256 left half for ES256 id_token', async () => {
        const key = await generateEcKey('P-256');
        const options = createValidOptions({ idTokenPrivateKey: key.privateKey });
        const { response } = await generateTokenResponse(options);
        const { payload } = decodeJwt(response.id_token);

        const expected = await expectedHash(response.access_token, 'SHA-256');
        expect(payload.at_hash).toBe(expected);
      });

      it('should compute at_hash with SHA-384 left half (24 bytes) for RS384 id_token', async () => {
        const key = await generateRsaKey('SHA-384');
        const options = createValidOptions({ idTokenPrivateKey: key.privateKey });
        const { response } = await generateTokenResponse(options);
        const { payload } = decodeJwt(response.id_token);

        const expected = await expectedHash(response.access_token, 'SHA-384');
        expect(payload.at_hash).toBe(expected);
        // SHA-384 (48 bytes) -> left half 24 bytes -> base64url length 32
        expect((payload.at_hash as string).length).toBe(32);
      });

      it('should compute at_hash with SHA-384 left half for ES384 id_token', async () => {
        const key = await generateEcKey('P-384');
        const options = createValidOptions({ idTokenPrivateKey: key.privateKey });
        const { response } = await generateTokenResponse(options);
        const { payload } = decodeJwt(response.id_token);

        const expected = await expectedHash(response.access_token, 'SHA-384');
        expect(payload.at_hash).toBe(expected);
      });

      it('should compute at_hash with SHA-512 left half (32 bytes) for RS512 id_token', async () => {
        const key = await generateRsaKey('SHA-512');
        const options = createValidOptions({ idTokenPrivateKey: key.privateKey });
        const { response } = await generateTokenResponse(options);
        const { payload } = decodeJwt(response.id_token);

        const expected = await expectedHash(response.access_token, 'SHA-512');
        expect(payload.at_hash).toBe(expected);
        // SHA-512 (64 bytes) -> left half 32 bytes -> base64url length 43
        expect((payload.at_hash as string).length).toBe(43);
      });

      it('should compute at_hash with SHA-512 left half for ES512 id_token', async () => {
        const key = await generateEcKey('P-521');
        const options = createValidOptions({ idTokenPrivateKey: key.privateKey });
        const { response } = await generateTokenResponse(options);
        const { payload } = decodeJwt(response.id_token);

        const expected = await expectedHash(response.access_token, 'SHA-512');
        expect(payload.at_hash).toBe(expected);
      });

      it('should base at_hash on the id_token signing alg, not the access_token signing alg', async () => {
        // access_token signed with RS256 (SHA-256), id_token signed with RS512 (SHA-512).
        const idKey = await generateRsaKey('SHA-512');
        const options = createValidOptions({ idTokenPrivateKey: idKey.privateKey });
        const { response } = await generateTokenResponse(options);
        const { payload } = decodeJwt(response.id_token);

        const sha512Expected = await expectedHash(response.access_token, 'SHA-512');
        const sha256Expected = await expectedHash(response.access_token, 'SHA-256');
        expect(payload.at_hash).toBe(sha512Expected);
        expect(payload.at_hash).not.toBe(sha256Expected);
      });
    });

    it('should include kid in header when keyId is provided', async () => {
      const options = createValidOptions({ keyId: 'id-key-1' });
      const { response } = await generateTokenResponse(options);
      const { header } = decodeJwt(response.id_token);
      expect(header.kid).toBe('id-key-1');
    });

    it('should include auth_time when provided', async () => {
      const authTime = Math.floor(Date.now() / 1000) - 300;
      const options = createValidOptions({ authTime });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token);
      expect(payload.auth_time).toBe(authTime);
    });
  });

  describe('ID Token issuance control', () => {
    it('should include id_token by default when issueIdToken is not set', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      expect(response.id_token).toBeDefined();
    });

    it('should include id_token when issueIdToken is true', async () => {
      const options = createValidOptions({ issueIdToken: true });
      const { response } = await generateTokenResponse(options);
      expect(response.id_token).toBeDefined();
    });

    it('should not include id_token when issueIdToken is false', async () => {
      // OIDC Core 1.0 Section 12: refresh_token grant MAY omit id_token
      const options = createValidOptions({ issueIdToken: false });
      const { response } = await generateTokenResponse(options);
      expect(response.id_token).toBeUndefined();
    });
  });

  describe('Refresh Token', () => {
    it('should not include refresh_token when issueRefreshToken is not set', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      expect(response.refresh_token).toBeUndefined();
    });

    it('should not include refresh_token when issueRefreshToken is false', async () => {
      const options = createValidOptions({ issueRefreshToken: false });
      const { response } = await generateTokenResponse(options);
      expect(response.refresh_token).toBeUndefined();
    });

    it('should include refresh_token when issueRefreshToken is true', async () => {
      const options = createValidOptions({ issueRefreshToken: true });
      const { response } = await generateTokenResponse(options);
      expect(response.refresh_token).toBeDefined();
    });

    it('should return a non-empty string for refresh_token when issued', async () => {
      const options = createValidOptions({ issueRefreshToken: true });
      const { response } = await generateTokenResponse(options);
      expect(typeof response.refresh_token).toBe('string');
      expect((response.refresh_token as string).length).toBeGreaterThan(0);
    });

    it('should generate unique refresh tokens on each call', async () => {
      const options = createValidOptions({ issueRefreshToken: true });
      const r1 = await generateTokenResponse(options); const response1 = r1.response;
      const r2 = await generateTokenResponse(options); const response2 = r2.response;
      expect(response1.refresh_token).not.toBe(response2.refresh_token);
    });
  });

  describe('Separate signing keys for access_token and id_token', () => {
    let secondaryKeyPair: CryptoKeyPair;

    beforeAll(async () => {
      secondaryKeyPair = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      );
    });

    // OIDC Core 1.0 allows id_token_signed_response_alg to be configured per client,
    // so the ID token MAY be signed with a different key than the access token.
    it('should sign id_token with idTokenPrivateKey when provided', async () => {
      const options = createValidOptions({
        idTokenPrivateKey: secondaryKeyPair.privateKey,
        idTokenKeyId: 'id-key-2',
      });
      const { response } = await generateTokenResponse(options);

      // ID token signature must verify with the secondary public key, not the primary.
      const idParts = response.id_token.split('.');
      const idSig = base64UrlToArrayBuffer(idParts[2]!);
      const idData = stringToArrayBuffer(`${idParts[0]}.${idParts[1]}`);
      const verifiedBySecondary = await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        secondaryKeyPair.publicKey,
        idSig,
        idData,
      );
      expect(verifiedBySecondary).toBe(true);

      const verifiedByPrimary = await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        rsaKeyPair.publicKey,
        idSig,
        idData,
      );
      expect(verifiedByPrimary).toBe(false);
    });

    it('should sign access_token with primary privateKey even when idTokenPrivateKey is provided', async () => {
      const options = createValidOptions({
        idTokenPrivateKey: secondaryKeyPair.privateKey,
        idTokenKeyId: 'id-key-2',
      });
      const { response } = await generateTokenResponse(options);

      const atParts = response.access_token.split('.');
      const atSig = base64UrlToArrayBuffer(atParts[2]!);
      const atData = stringToArrayBuffer(`${atParts[0]}.${atParts[1]}`);
      const verifiedByPrimary = await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        rsaKeyPair.publicKey,
        atSig,
        atData,
      );
      expect(verifiedByPrimary).toBe(true);
    });

    it('should set kid header from idTokenKeyId on id_token only', async () => {
      const options = createValidOptions({
        keyId: 'access-key',
        idTokenPrivateKey: secondaryKeyPair.privateKey,
        idTokenKeyId: 'id-key-2',
      });
      const { response } = await generateTokenResponse(options);

      const { header: atHeader } = decodeJwt(response.access_token);
      const { header: idHeader } = decodeJwt(response.id_token);
      expect(atHeader.kid).toBe('access-key');
      expect(idHeader.kid).toBe('id-key-2');
    });

    it('should fall back idTokenKeyId to keyId when not provided', async () => {
      const options = createValidOptions({
        keyId: 'shared-key',
        idTokenPrivateKey: secondaryKeyPair.privateKey,
      });
      const { response } = await generateTokenResponse(options);

      // idTokenKeyId is undefined → falls back to keyId. Even though the actual signing
      // uses the secondary key, the header still says kid=shared-key (consistent with
      // a deployment that rotates rarely and shares the kid label).
      const { header: idHeader } = decodeJwt(response.id_token);
      expect(idHeader.kid).toBe('shared-key');
    });

    it('should sign both tokens with the same key when idTokenPrivateKey is omitted (backward compat)', async () => {
      const options = createValidOptions({ keyId: 'shared-key' });
      const { response } = await generateTokenResponse(options);

      const verify = async (jwt: string) => {
        const parts = jwt.split('.');
        return crypto.subtle.verify(
          { name: 'RSASSA-PKCS1-v1_5' },
          rsaKeyPair.publicKey,
          base64UrlToArrayBuffer(parts[2]!),
          stringToArrayBuffer(`${parts[0]}.${parts[1]}`),
        );
      };
      expect(await verify(response.access_token)).toBe(true);
      expect(await verify(response.id_token)).toBe(true);
    });
  });

  // OIDC Core 1.0 §2 / §12.1: acr / amr conveyance in the ID Token.
  // The OP cannot decide acr / amr policy on its own — it must be injected by the
  // hosting application. T-015 introduces an AcrResolver that the application can
  // implement (or omit, preserving the T-009 hold "no acr/amr" behavior).
  describe('acr / amr resolver injection (T-015)', () => {
    it('should include acr and amr in the ID Token when the resolver returns values', async () => {
      const options = createValidOptions({
        acrResolver: async () => ({ acr: 'urn:mace:incommon:iap:silver', amr: ['pwd', 'mfa'] }),
      });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token!);
      expect(payload.acr).toBe('urn:mace:incommon:iap:silver');
      expect(payload.amr).toEqual(['pwd', 'mfa']);
    });

    it('should pass userId, clientId and requestedAcrValues to the resolver', async () => {
      const calls: Array<{ userId: string; clientId: string; requestedAcrValues?: string }> = [];
      const options = createValidOptions({
        subject: 'user-acr',
        clientId: 'client-acr',
        requestedAcrValues: '0 1',
        acrResolver: async (ctx) => {
          calls.push(ctx);
          return { acr: '1', amr: ['pwd'] };
        },
      });
      await generateTokenResponse(options);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        userId: 'user-acr',
        clientId: 'client-acr',
        requestedAcrValues: '0 1',
      });
    });

    it('should omit acr and amr from ID Token when the resolver returns undefined', async () => {
      const options = createValidOptions({
        acrResolver: async () => undefined,
      });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token!);
      expect(payload.acr).toBeUndefined();
      expect(payload.amr).toBeUndefined();
    });

    it('should omit acr and amr from ID Token when no resolver is provided (T-009 hold behavior)', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token!);
      expect(payload.acr).toBeUndefined();
      expect(payload.amr).toBeUndefined();
    });

    // OIDC Core 1.0 §12.1 SHOULD: refresh で発行する ID Token は初回認証時の
    // acr / amr を保持する。caller は格納済みの値を直接渡し、resolver は呼び出さない。
    it('should use directly-passed acr/amr (refresh case) and skip resolver', async () => {
      let resolverCalled = false;
      const options = createValidOptions({
        acr: 'urn:initial',
        amr: ['pwd'],
        acrResolver: async () => {
          resolverCalled = true;
          return { acr: 'should-not-be-used', amr: ['x'] };
        },
      });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token!);
      expect(payload.acr).toBe('urn:initial');
      expect(payload.amr).toEqual(['pwd']);
      expect(resolverCalled).toBe(false);
    });

    // P0: refresh token への acr / amr 永続化のため、解決値を呼び出し側へ返す。
    it('should return resolved acr/amr alongside the response when resolver supplies them', async () => {
      const options = createValidOptions({
        acrResolver: async () => ({ acr: 'urn:resolved', amr: ['pwd', 'mfa'] }),
      });
      const result = await generateTokenResponse(options);
      expect(result.resolvedAcr).toBe('urn:resolved');
      expect(result.resolvedAmr).toEqual(['pwd', 'mfa']);
    });

    it('should return resolved acr/amr equal to directly-passed values on refresh path', async () => {
      const options = createValidOptions({
        acr: 'urn:initial',
        amr: ['pwd'],
      });
      const result = await generateTokenResponse(options);
      expect(result.resolvedAcr).toBe('urn:initial');
      expect(result.resolvedAmr).toEqual(['pwd']);
    });

    it('should leave resolvedAcr/resolvedAmr undefined when resolver returns undefined', async () => {
      const options = createValidOptions({
        acrResolver: async () => undefined,
      });
      const result = await generateTokenResponse(options);
      expect(result.resolvedAcr).toBeUndefined();
      expect(result.resolvedAmr).toBeUndefined();
    });

    // OIDC Core 1.0 §5.5.1.1: claims.id_token.acr.values drives requested acr_values.
    it('should pass claims.id_token.acr.values to the resolver as requestedAcrValues', async () => {
      let receivedAcrValues: string | undefined;
      const options = createValidOptions({
        claims: {
          id_token: { acr: { essential: true, values: ['urn:a', 'urn:b'] } },
        },
        acrResolver: async (ctx) => {
          receivedAcrValues = ctx.requestedAcrValues;
          return { acr: 'urn:a', amr: ['pwd'] };
        },
      });
      const result = await generateTokenResponse(options);
      expect(receivedAcrValues).toBe('urn:a urn:b');
      expect(result.resolvedAcr).toBe('urn:a');
    });

    it('should let acr_values request param take precedence over claims.id_token.acr.values', async () => {
      let receivedAcrValues: string | undefined;
      const options = createValidOptions({
        requestedAcrValues: 'urn:from-acr-values',
        claims: {
          id_token: { acr: { values: ['urn:from-claims'] } },
        },
        acrResolver: async (ctx) => {
          receivedAcrValues = ctx.requestedAcrValues;
          return { acr: 'urn:from-acr-values', amr: ['pwd'] };
        },
      });
      await generateTokenResponse(options);
      expect(receivedAcrValues).toBe('urn:from-acr-values');
    });

    it('should ignore unknown id_token claim members without throwing', async () => {
      const options = createValidOptions({
        claims: {
          id_token: { custom_unknown_claim: { essential: true } },
        },
        acrResolver: async () => ({ acr: 'urn:resolved', amr: ['pwd'] }),
      });
      const result = await generateTokenResponse(options);
      expect(result.resolvedAcr).toBe('urn:resolved');
    });

    // Make sure the public response body never carries acr/amr — those are ID Token only.
    it('should not leak acr/amr into the response body', async () => {
      const options = createValidOptions({
        acrResolver: async () => ({ acr: 'urn:resolved', amr: ['pwd'] }),
      });
      const { response } = await generateTokenResponse(options);
      expect((response as Record<string, unknown>).acr).toBeUndefined();
      expect((response as Record<string, unknown>).amr).toBeUndefined();
    });
  });

  // OIDC Core 1.0 §12 / §5.4: refresh で発行される ID Token のクレームセットは
  // 削減後の scope に従う。userClaims を渡した場合、ID Token は scope に応じて
  // フィルタされたクレームを含む。
  describe('ID Token claims filtered by scope (T-020)', () => {
    const userClaims = {
      sub: 'user-claims',
      name: 'Alice',
      family_name: 'Doe',
      email: 'alice@example.com',
      email_verified: true,
      phone_number: '+81-90-0000-0000',
    };

    it('should omit profile claims when scope is reduced to openid email', async () => {
      const options = createValidOptions({
        scope: ['openid', 'email'],
        userClaims,
      });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token!);
      expect(payload.email).toBe('alice@example.com');
      expect(payload.email_verified).toBe(true);
      expect(payload.name).toBeUndefined();
      expect(payload.family_name).toBeUndefined();
      expect(payload.phone_number).toBeUndefined();
    });

    it('should include all matching claims when scope is openid profile email', async () => {
      const options = createValidOptions({
        scope: ['openid', 'profile', 'email'],
        userClaims,
      });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token!);
      expect(payload.name).toBe('Alice');
      expect(payload.family_name).toBe('Doe');
      expect(payload.email).toBe('alice@example.com');
      expect(payload.email_verified).toBe(true);
    });

    it('should always include required claims (sub/iss/aud/exp/iat) regardless of scope reduction', async () => {
      const options = createValidOptions({
        scope: ['openid'],
        userClaims,
      });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token!);
      expect(payload.sub).toBeDefined();
      expect(payload.iss).toBeDefined();
      expect(payload.aud).toBeDefined();
      expect(payload.exp).toBeDefined();
      expect(payload.iat).toBeDefined();
      // openid scope alone should not pull in profile/email/phone claims.
      expect(payload.name).toBeUndefined();
      expect(payload.email).toBeUndefined();
      expect(payload.phone_number).toBeUndefined();
    });

    it('should keep ID Token unchanged when userClaims is not provided', async () => {
      const options = createValidOptions({ scope: ['openid', 'profile'] });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token!);
      expect(payload.name).toBeUndefined();
      expect(payload.email).toBeUndefined();
    });

    it('should not let user claims override required ID Token claims', async () => {
      const options = createValidOptions({
        subject: 'user-required',
        scope: ['openid', 'profile'],
        userClaims: {
          sub: 'spoofed-sub',
          name: 'Alice',
        } as never,
      });
      const { response } = await generateTokenResponse(options);
      const { payload } = decodeJwt(response.id_token!);
      expect(payload.sub).toBe('user-required');
      expect(payload.name).toBe('Alice');
    });
  });

  describe('Token signature verification', () => {
    it('should produce valid RS256 signature for access_token', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      const parts = response.access_token.split('.');
      const signingInput = `${parts[0]}.${parts[1]}`;
      const signatureBuffer = base64UrlToArrayBuffer(parts[2]!);
      const dataBuffer = stringToArrayBuffer(signingInput);
      const isValid = await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        rsaKeyPair.publicKey,
        signatureBuffer,
        dataBuffer
      );
      expect(isValid).toBe(true);
    });

    it('should produce valid RS256 signature for id_token', async () => {
      const options = createValidOptions();
      const { response } = await generateTokenResponse(options);
      const parts = response.id_token.split('.');
      const signingInput = `${parts[0]}.${parts[1]}`;
      const signatureBuffer = base64UrlToArrayBuffer(parts[2]!);
      const dataBuffer = stringToArrayBuffer(signingInput);
      const isValid = await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        rsaKeyPair.publicKey,
        signatureBuffer,
        dataBuffer
      );
      expect(isValid).toBe(true);
    });
  });
});

// RFC 9068 §3: a JWT access token's aud must be non-empty and identify the
// resource(s) the token is intended for. This helper centralises the audience
// composition policy so every framework template (and direct core callers)
// build the aud the same way: the OP's own UserInfo endpoint is a permanent
// member, requested resource indicators are appended, duplicates are removed,
// and an empty result falls back to the issuer.
describe('buildAccessTokenAudience', () => {
  it('should fall back to issuer when neither userInfoEndpoint nor requested is provided', () => {
    expect(buildAccessTokenAudience({ issuer: 'https://op.example.com' })).toEqual([
      'https://op.example.com',
    ]);
  });

  it('should fall back to issuer when requested is an empty array and no userInfoEndpoint', () => {
    expect(buildAccessTokenAudience({ requested: [], issuer: 'https://op.example.com' })).toEqual([
      'https://op.example.com',
    ]);
  });

  it('should include only the userInfoEndpoint when no resource is requested', () => {
    expect(
      buildAccessTokenAudience({
        userInfoEndpoint: 'https://op.example.com/userinfo',
        issuer: 'https://op.example.com',
      }),
    ).toEqual(['https://op.example.com/userinfo']);
  });

  it('should use requested resources as-is when no userInfoEndpoint is provided', () => {
    expect(
      buildAccessTokenAudience({
        requested: ['https://api.example.com'],
        issuer: 'https://op.example.com',
      }),
    ).toEqual(['https://api.example.com']);
  });

  it('should keep the userInfoEndpoint as the first member and append requested resources', () => {
    expect(
      buildAccessTokenAudience({
        userInfoEndpoint: 'https://op.example.com/userinfo',
        requested: ['https://api.example.com'],
        issuer: 'https://op.example.com',
      }),
    ).toEqual(['https://op.example.com/userinfo', 'https://api.example.com']);
  });

  it('should never remove the userInfoEndpoint when multiple resources are requested', () => {
    const aud = buildAccessTokenAudience({
      userInfoEndpoint: 'https://op.example.com/userinfo',
      requested: ['https://api1.example.com', 'https://api2.example.com'],
      issuer: 'https://op.example.com',
    });
    expect(aud).toContain('https://op.example.com/userinfo');
    expect(aud).toEqual([
      'https://op.example.com/userinfo',
      'https://api1.example.com',
      'https://api2.example.com',
    ]);
  });

  it('should deduplicate when requested already contains the userInfoEndpoint', () => {
    expect(
      buildAccessTokenAudience({
        userInfoEndpoint: 'https://op.example.com/userinfo',
        requested: ['https://op.example.com/userinfo', 'https://api.example.com'],
        issuer: 'https://op.example.com',
      }),
    ).toEqual(['https://op.example.com/userinfo', 'https://api.example.com']);
  });

  it('should deduplicate repeated requested resources', () => {
    expect(
      buildAccessTokenAudience({
        requested: ['https://api.example.com', 'https://api.example.com'],
        issuer: 'https://op.example.com',
      }),
    ).toEqual(['https://api.example.com']);
  });

  it('should be idempotent when re-applied to an already composed audience (refresh case)', () => {
    const first = buildAccessTokenAudience({
      userInfoEndpoint: 'https://op.example.com/userinfo',
      requested: ['https://api.example.com'],
      issuer: 'https://op.example.com',
    });
    // On refresh the stored (already composed) audience is fed back in as requested.
    const second = buildAccessTokenAudience({
      userInfoEndpoint: 'https://op.example.com/userinfo',
      requested: first,
      issuer: 'https://op.example.com',
    });
    expect(second).toEqual(first);
  });
});

// OIDC Core 1.0 §2 / §3.1.3.7 (4-5): the ID Token aud is a single string (clientId) when
// the client is the sole audience, with azp omitted. When additional audiences are supplied
// aud becomes an array and azp = clientId is REQUIRED. These freeze both shapes so a change
// cannot silently drop the required azp or wrongly widen aud.
describe('generateTokenResponse - ID Token aud/azp shape', () => {
  it('should issue aud as a single string equal to clientId by default', async () => {
    const options = createValidOptions({ clientId: 'client-single-aud' });
    const { response } = await generateTokenResponse(options);
    const { payload } = decodeJwt(response.id_token!);
    expect(payload.aud).toBe('client-single-aud');
  });

  it('should not issue aud as an array when no additional audiences are given', async () => {
    const options = createValidOptions();
    const { response } = await generateTokenResponse(options);
    const { payload } = decodeJwt(response.id_token!);
    expect(Array.isArray(payload.aud)).toBe(false);
  });

  it('should not include an azp claim for a single audience', async () => {
    const options = createValidOptions();
    const { response } = await generateTokenResponse(options);
    const { payload } = decodeJwt(response.id_token!);
    expect(Object.prototype.hasOwnProperty.call(payload, 'azp')).toBe(false);
  });

  it('should issue aud as an array [clientId, ...additional] when idTokenAudiences is given', async () => {
    const options = createValidOptions({
      clientId: 'client-primary',
      idTokenAudiences: ['https://other.example/rp', 'https://third.example/rp'],
    });
    const { response } = await generateTokenResponse(options);
    const { payload } = decodeJwt(response.id_token!);
    expect(payload.aud).toEqual([
      'client-primary',
      'https://other.example/rp',
      'https://third.example/rp',
    ]);
  });

  it('should set azp to clientId when aud contains multiple values', async () => {
    const options = createValidOptions({
      clientId: 'client-primary',
      idTokenAudiences: ['https://other.example/rp'],
    });
    const { response } = await generateTokenResponse(options);
    const { payload } = decodeJwt(response.id_token!);
    expect(payload.azp).toBe('client-primary');
  });

  it('should keep aud a single string and omit azp when additional audiences dedupe to clientId only', async () => {
    const options = createValidOptions({
      clientId: 'client-primary',
      idTokenAudiences: ['client-primary'],
    });
    const { response } = await generateTokenResponse(options);
    const { payload } = decodeJwt(response.id_token!);
    expect(payload.aud).toBe('client-primary');
    expect(Object.prototype.hasOwnProperty.call(payload, 'azp')).toBe(false);
  });
});

// Direct unit tests for the aud/azp policy helper (OIDC Core 1.0 §2 / §3.1.3.7 (4-5)).
describe('buildIdTokenAudience', () => {
  it('should return aud as a single string and no azp for the client alone', () => {
    expect(buildIdTokenAudience({ clientId: 'c1' })).toEqual({ aud: 'c1' });
  });

  it('should return aud as an array with azp = clientId for multiple audiences', () => {
    expect(
      buildIdTokenAudience({ clientId: 'c1', additional: ['https://api.example/rp'] }),
    ).toEqual({ aud: ['c1', 'https://api.example/rp'], azp: 'c1' });
  });

  it('should place clientId first and dedupe repeated audiences preserving order', () => {
    expect(
      buildIdTokenAudience({ clientId: 'c1', additional: ['a', 'c1', 'a', 'b'] }),
    ).toEqual({ aud: ['c1', 'a', 'b'], azp: 'c1' });
  });

  it('should treat additional audiences equal to clientId only as a single audience', () => {
    expect(buildIdTokenAudience({ clientId: 'c1', additional: ['c1'] })).toEqual({ aud: 'c1' });
  });
});
