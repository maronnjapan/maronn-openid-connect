import { describe, it, expect } from 'vitest';
import { createAuthorizationCode } from './authorization-code.js';
import type { CreateAuthorizationCodeOptions } from './authorization-code.js';
import type { AuthorizationResponseParams } from './auth-transaction.js';

function createValidResponse(overrides?: Partial<AuthorizationResponseParams>): AuthorizationResponseParams {
  return {
    redirectUri: 'https://client.example.com/cb',
    clientId: 'client-1',
    scope: ['openid', 'profile'],
    codeChallenge: 'challenge-value',
    codeChallengeMethod: 'S256',
    ...overrides,
  };
}

function createValidOptions(overrides?: Partial<CreateAuthorizationCodeOptions>): CreateAuthorizationCodeOptions {
  return {
    authorizationResponse: createValidResponse(),
    subject: 'user-123',
    authTime: 1700000000,
    ...overrides,
  };
}

describe('createAuthorizationCode', () => {
  describe('Code generation', () => {
    it('should generate a random code as a string', async () => {
      const result = await createAuthorizationCode(createValidOptions());
      expect(typeof result.code).toBe('string');
      expect(result.code.length).toBeGreaterThan(0);
    });

    it('should generate different codes on each call', async () => {
      const a = await createAuthorizationCode(createValidOptions());
      const b = await createAuthorizationCode(createValidOptions());
      expect(a.code).not.toBe(b.code);
    });
  });

  describe('Required fields', () => {
    it('should set used to false', async () => {
      const result = await createAuthorizationCode(createValidOptions());
      expect(result.used).toBe(false);
    });

    it('should copy clientId from authorizationResponse', async () => {
      const result = await createAuthorizationCode(
        createValidOptions({ authorizationResponse: createValidResponse({ clientId: 'cid-x' }) }),
      );
      expect(result.clientId).toBe('cid-x');
    });

    it('should copy redirectUri from authorizationResponse', async () => {
      const result = await createAuthorizationCode(
        createValidOptions({ authorizationResponse: createValidResponse({ redirectUri: 'https://x/cb' }) }),
      );
      expect(result.redirectUri).toBe('https://x/cb');
    });

    it('should copy scope from authorizationResponse', async () => {
      const result = await createAuthorizationCode(
        createValidOptions({ authorizationResponse: createValidResponse({ scope: ['openid', 'email'] }) }),
      );
      expect(result.scope).toEqual(['openid', 'email']);
    });

    it('should copy codeChallenge and codeChallengeMethod', async () => {
      const result = await createAuthorizationCode(
        createValidOptions({
          authorizationResponse: createValidResponse({
            codeChallenge: 'cc-1',
            codeChallengeMethod: 'S256',
          }),
        }),
      );
      expect(result.codeChallenge).toBe('cc-1');
      expect(result.codeChallengeMethod).toBe('S256');
    });

    it('should omit codeChallenge and codeChallengeMethod when authorizationResponse has no PKCE binding', async () => {
      const result = await createAuthorizationCode(
        createValidOptions({
          authorizationResponse: createValidResponse({
            codeChallenge: undefined,
            codeChallengeMethod: undefined,
          }),
        }),
      );

      expect(result.codeChallenge).toBeUndefined();
      expect(result.codeChallengeMethod).toBeUndefined();
    });

    it('should set subject from options', async () => {
      const result = await createAuthorizationCode(createValidOptions({ subject: 'user-x' }));
      expect(result.subject).toBe('user-x');
    });

    it('should set authTime from options', async () => {
      const result = await createAuthorizationCode(createValidOptions({ authTime: 1234567890 }));
      expect(result.authTime).toBe(1234567890);
    });
  });

  describe('Expiration (TTL)', () => {
    // OIDC Core 1.0 Section 3.1.3.1: authorization codes SHOULD be short-lived
    it('should default ttlSeconds to 300', async () => {
      const before = Math.floor(Date.now() / 1000);
      const result = await createAuthorizationCode(createValidOptions());
      const after = Math.floor(Date.now() / 1000);
      expect(result.expiresAt).toBeGreaterThanOrEqual(before + 300);
      expect(result.expiresAt).toBeLessThanOrEqual(after + 300);
    });

    it('should set expiresAt based on provided ttlSeconds', async () => {
      const before = Math.floor(Date.now() / 1000);
      const result = await createAuthorizationCode(createValidOptions({ ttlSeconds: 60 }));
      const after = Math.floor(Date.now() / 1000);
      expect(result.expiresAt).toBeGreaterThanOrEqual(before + 60);
      expect(result.expiresAt).toBeLessThanOrEqual(after + 60);
    });
  });

  // OAuth 2.1 Section 4.1.2 / RFC 6749 Section 4.1.2:
  // On code reuse, the AS SHOULD revoke all tokens previously issued from the code.
  // The grantId links the authorization code to its issued tokens so the AS can revoke them.
  describe('grantId', () => {
    it('should generate a grantId as a string', async () => {
      const result = await createAuthorizationCode(createValidOptions());
      expect(typeof result.grantId).toBe('string');
      expect(result.grantId.length).toBeGreaterThan(0);
    });

    it('should generate a unique grantId per code', async () => {
      const a = await createAuthorizationCode(createValidOptions());
      const b = await createAuthorizationCode(createValidOptions());
      expect(a.grantId).not.toBe(b.grantId);
    });

    it('should generate grantId distinct from code', async () => {
      const result = await createAuthorizationCode(createValidOptions());
      expect(result.grantId).not.toBe(result.code);
    });
  });

  describe('Optional fields', () => {
    it('should include nonce when present in authorizationResponse', async () => {
      const result = await createAuthorizationCode(
        createValidOptions({ authorizationResponse: createValidResponse({ nonce: 'n-1' }) }),
      );
      expect(result.nonce).toBe('n-1');
    });

    it('should not include nonce when absent', async () => {
      const result = await createAuthorizationCode(createValidOptions());
      expect(result.nonce).toBeUndefined();
    });

    it('should include audience when present', async () => {
      const result = await createAuthorizationCode(
        createValidOptions({ authorizationResponse: createValidResponse({ audience: ['api-1'] }) }),
      );
      expect(result.audience).toEqual(['api-1']);
    });

    it('should not include audience when absent', async () => {
      const result = await createAuthorizationCode(createValidOptions());
      expect(result.audience).toBeUndefined();
    });

    // OIDC Core 1.0 §3.1.2.1: acr_values requested at authorization must be preserved
    // on the authorization code so the token endpoint can feed it to the AcrResolver.
    it('should include acrValues when present', async () => {
      const result = await createAuthorizationCode(
        createValidOptions({ authorizationResponse: createValidResponse({ acrValues: 'loa2 loa3' }) }),
      );
      expect(result.acrValues).toBe('loa2 loa3');
    });

    it('should not include acrValues when absent', async () => {
      const result = await createAuthorizationCode(createValidOptions());
      expect(result.acrValues).toBeUndefined();
    });

    // online refresh token（offline_access 無しで発行する Refresh Token）を、この認可を
    // 生んだ認証セッションへ束縛するために引き継ぐ。
    it('should include sessionId when the authorization was issued within a session', async () => {
      const result = await createAuthorizationCode(
        createValidOptions({ sessionId: 'session-abc' }),
      );
      expect(result.sessionId).toBe('session-abc');
    });

    it('should not include sessionId when absent', async () => {
      const result = await createAuthorizationCode(createValidOptions());
      expect(result.sessionId).toBeUndefined();
    });
  });
});
