import { describe, it, expect, beforeAll } from 'vitest';
import {
  validateTokenRequest,
  validateAuthorizationCodeGrant,
  validateRefreshTokenGrant,
  TokenError,
  TokenErrorCode,
} from './token-request.js';
import type {
  TokenRequestParams,
  TokenClientInfo,
  TokenClientResolver,
  AuthorizationCodeInfo,
  AuthorizationCodeResolver,
  TokenRequestContext,
  RefreshTokenInfo,
  RefreshTokenResolver,
} from './token-request.js';

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

// --- Helper: SHA-256でcode_challengeを生成 ---
async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Helper: 有効なcode_verifierを生成 ---
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  let binary = '';
  for (let i = 0; i < array.length; i++) {
    binary += String.fromCharCode(array[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Helper: 有効なTokenRequestContextを構築 ---
function createValidContext(overrides?: {
  params?: Partial<TokenRequestParams>;
  client?: Partial<TokenClientInfo>;
  authCode?: Partial<AuthorizationCodeInfo>;
  codeVerifier?: string;
}): { context: TokenRequestContext; codeVerifier: string } {
  const codeVerifier = overrides?.codeVerifier ?? generateCodeVerifier();

  const defaultClient: TokenClientInfo = {
    clientId: 'client-123',
    clientSecret: 'secret-456',
    ...overrides?.client,
  };

  const now = Math.floor(Date.now() / 1000);

  const defaultAuthCode: AuthorizationCodeInfo = {
    code: 'valid-auth-code',
    clientId: 'client-123',
    redirectUri: 'https://client.example.com/cb',
    redirectUriExplicit: false,
    scope: ['openid', 'profile'],
    codeChallenge: '', // set below
    codeChallengeMethod: 'S256',
    expiresAt: now + 600,
    used: false,
    nonce: undefined,
    grantId: 'grant-1',
    ...overrides?.authCode,
  };

  const clientResolver: TokenClientResolver = {
    findClient: async (clientId: string) => {
      if (clientId === defaultClient.clientId) return defaultClient;
      return null;
    },
  };

  const authCodeResolver: AuthorizationCodeResolver = {
    findAuthorizationCode: async (code: string) => {
      if (code === (overrides?.authCode?.code ?? 'valid-auth-code')) return defaultAuthCode;
      return null;
    },
    revokeAuthorizationCode: async () => {},
  };

  const defaultParams: TokenRequestParams = {
    grant_type: 'authorization_code',
    code: 'valid-auth-code',
    redirect_uri: 'https://client.example.com/cb',
    code_verifier: codeVerifier,
    ...overrides?.params,
  };

  return {
    context: {
      params: defaultParams,
      clientResolver,
      authCodeResolver,
      authenticatedClientId: 'client-123',
    },
    codeVerifier,
  };
}

describe('validateTokenRequest', () => {
  describe('grant_type validation', () => {
    it('should reject missing grant_type', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        params: { grant_type: undefined as unknown as string },
        authCode: { codeChallenge },
        codeVerifier,
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidRequest });
    });

    it('should reject unsupported grant_type', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        params: { grant_type: 'client_credentials' },
        authCode: { codeChallenge },
        codeVerifier,
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.UnsupportedGrantType });
    });

    it('should accept grant_type=authorization_code', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        params: { grant_type: 'authorization_code' },
        authCode: { codeChallenge },
        codeVerifier,
      });
      const result = await validateTokenRequest(context);
      expect(result.grantType).toBe('authorization_code');
    });
  });

  describe('Client authentication', () => {
    it('should reject when authenticatedClientId is not provided', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        authCode: { codeChallenge },
        codeVerifier,
      });
      context.authenticatedClientId = undefined as unknown as string;
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidClient });
    });

    it('should reject when client is not found', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        authCode: { codeChallenge },
        codeVerifier,
      });
      context.authenticatedClientId = 'unknown-client';
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidClient });
    });

    it('should accept valid authenticated client', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        authCode: { codeChallenge },
        codeVerifier,
      });
      const result = await validateTokenRequest(context);
      expect(result.clientId).toBe('client-123');
    });
  });

  describe('Authorization code validation', () => {
    it('should reject missing code parameter', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        params: { code: undefined as unknown as string },
        authCode: { codeChallenge },
        codeVerifier,
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidRequest });
    });

    it('should reject unknown authorization code', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        params: { code: 'unknown-code' },
        authCode: { codeChallenge },
        codeVerifier,
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    it('should reject authorization code issued to different client', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        authCode: { codeChallenge, clientId: 'other-client' },
        codeVerifier,
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    it('should reject expired authorization code', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const now = Math.floor(Date.now() / 1000);
      const { context } = createValidContext({
        authCode: { codeChallenge, expiresAt: now - 100 },
        codeVerifier,
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    // RFC 7519 §4.1.4 (on-or-after): expiresAt === now is expired, identical to the
    // refresh-token boundary so both grants share one expiry convention.
    it('should reject an authorization code whose expiresAt equals now', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const now = Math.floor(Date.now() / 1000);
      const { context } = createValidContext({
        authCode: { codeChallenge, expiresAt: now },
        codeVerifier,
      });
      await expect(validateTokenRequest(context)).rejects.toMatchObject({
        error: TokenErrorCode.InvalidGrant,
      });
    });

    it('should reject already used authorization code', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        authCode: { codeChallenge, used: true },
        codeVerifier,
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    // OAuth 2.1 Section 4.1.2 / RFC 6749 Section 4.1.2:
    // On reuse, the AS MUST deny AND SHOULD revoke previously issued tokens.
    describe('Code reuse: token revocation (OP-OAuth-2nd-Revokes)', () => {
      it('should call revokeTokensByGrantId with the grantId of the reused code', async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);

        let revokedGrantId: string | undefined;
        const { context: baseContext } = createValidContext({
          authCode: { codeChallenge, used: true, grantId: 'grant-abc' },
          codeVerifier,
        });

        const context: TokenRequestContext = {
          ...baseContext,
          authCodeResolver: {
            ...baseContext.authCodeResolver,
            revokeTokensByGrantId: async (grantId: string) => {
              revokedGrantId = grantId;
            },
          },
        };

        await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
        expect(revokedGrantId).toBe('grant-abc');
      });

      it('should still throw invalid_grant after revoking tokens', async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);
        const { context: baseContext } = createValidContext({
          authCode: { codeChallenge, used: true, grantId: 'grant-xyz' },
          codeVerifier,
        });
        const context: TokenRequestContext = {
          ...baseContext,
          authCodeResolver: {
            ...baseContext.authCodeResolver,
            revokeTokensByGrantId: async () => {},
          },
        };
        await expect(validateTokenRequest(context)).rejects.toMatchObject({
          error: TokenErrorCode.InvalidGrant,
        });
      });

      it('should not error when revokeTokensByGrantId is not provided (backward compat)', async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);
        const { context } = createValidContext({
          authCode: { codeChallenge, used: true, grantId: 'grant-1' },
          codeVerifier,
        });
        // Should still throw invalid_grant, not crash on missing optional method
        await expect(validateTokenRequest(context)).rejects.toMatchObject({
          error: TokenErrorCode.InvalidGrant,
        });
      });
    });

    it('should accept valid authorization code', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        authCode: { codeChallenge },
        codeVerifier,
      });
      const result = await validateTokenRequest(context);
      expect(result.code).toBe('valid-auth-code');
    });
  });

  describe('redirect_uri validation', () => {
    it('should reject when redirect_uri does not match original request', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        params: { redirect_uri: 'https://attacker.example.com/cb' },
        authCode: { codeChallenge, redirectUri: 'https://client.example.com/cb' },
        codeVerifier,
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    it('should accept when redirect_uri is missing in token request', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        params: { redirect_uri: undefined },
        authCode: { codeChallenge, redirectUri: 'https://client.example.com/cb' },
        codeVerifier,
      });
      const result = await validateTokenRequest(context);
      expect(result.redirectUri).toBe('https://client.example.com/cb');
    });

    it('should accept matching redirect_uri', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        params: { redirect_uri: 'https://client.example.com/cb' },
        authCode: { codeChallenge, redirectUri: 'https://client.example.com/cb' },
        codeVerifier,
      });
      const result = await validateTokenRequest(context);
      expect(result.redirectUri).toBe('https://client.example.com/cb');
    });

    // OIDC Core 1.0 Section 3.1.3.2:
    // 認可リクエストに redirect_uri が含まれていた場合、Token リクエストでも MUST 一致。
    // 認可コード発行時に redirectUriExplicit=true を保持し、Token 側で必須化する。
    describe('OIDC Core 3.1.3.2 explicit redirect_uri binding', () => {
      it('should reject token request without redirect_uri when authorization request had explicit redirect_uri', async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);
        const { context } = createValidContext({
          params: { redirect_uri: undefined },
          authCode: {
            codeChallenge,
            redirectUri: 'https://client.example.com/cb',
            redirectUriExplicit: true,
          },
          codeVerifier,
        });
        await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
        await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
      });

      it('should accept token request with matching redirect_uri when authorization request had explicit redirect_uri', async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);
        const { context } = createValidContext({
          params: { redirect_uri: 'https://client.example.com/cb' },
          authCode: {
            codeChallenge,
            redirectUri: 'https://client.example.com/cb',
            redirectUriExplicit: true,
          },
          codeVerifier,
        });
        const result = await validateTokenRequest(context);
        expect(result.redirectUri).toBe('https://client.example.com/cb');
      });

      it('should accept token request without redirect_uri when authorization request omitted redirect_uri', async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);
        const { context } = createValidContext({
          params: { redirect_uri: undefined },
          authCode: {
            codeChallenge,
            redirectUri: 'https://client.example.com/cb',
            redirectUriExplicit: false,
          },
          codeVerifier,
        });
        const result = await validateTokenRequest(context);
        expect(result.redirectUri).toBe('https://client.example.com/cb');
      });
    });
  });

  describe('PKCE code_verifier validation', () => {
    it('should reject missing code_verifier', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        params: { code_verifier: undefined as unknown as string },
        authCode: { codeChallenge },
        codeVerifier,
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    it('should reject invalid code_verifier (wrong value)', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        params: { code_verifier: 'wrong-code-verifier-that-does-not-match' },
        authCode: { codeChallenge },
        codeVerifier,
      });
      // Override params to use wrong verifier
      context.params.code_verifier = 'wrong-code-verifier-that-does-not-match';
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    it('should accept valid code_verifier with S256 method', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        authCode: { codeChallenge, codeChallengeMethod: 'S256' },
        codeVerifier,
      });
      const result = await validateTokenRequest(context);
      expect(result.codeVerified).toBe(true);
    });

    it('should accept authorization_code grants without code_verifier when the authorization code has no PKCE binding', async () => {
      const { context } = createValidContext({
        params: { code_verifier: undefined },
        authCode: {
          codeChallenge: undefined,
          codeChallengeMethod: undefined,
        },
      });

      const result = await validateTokenRequest(context);

      expect(result).toMatchObject({
        grantType: 'authorization_code',
        clientId: 'client-123',
        code: 'valid-auth-code',
        codeVerified: false,
      });
    });

    // RFC 7636 Section 4.1: length and character validation
    it('should reject code_verifier shorter than 43 characters', async () => {
      const shortVerifier = 'A'.repeat(42);
      const codeChallenge = await generateCodeChallenge(shortVerifier);
      const { context } = createValidContext({
        authCode: { codeChallenge },
        codeVerifier: shortVerifier,
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    it('should reject code_verifier longer than 128 characters', async () => {
      const longVerifier = 'A'.repeat(129);
      const codeChallenge = await generateCodeChallenge(longVerifier);
      const { context } = createValidContext({
        authCode: { codeChallenge },
        codeVerifier: longVerifier,
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    it('should reject code_verifier containing invalid characters', async () => {
      // RFC 7636: only [A-Za-z0-9\-._~] are allowed; '+' is not a valid character
      const invalidVerifier = 'A'.repeat(42) + '+';
      const codeChallenge = await generateCodeChallenge(invalidVerifier);
      const { context } = createValidContext({
        authCode: { codeChallenge },
        codeVerifier: invalidVerifier,
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    it('should accept code_verifier of exactly 43 characters', async () => {
      const verifier43 = 'A'.repeat(43);
      const codeChallenge = await generateCodeChallenge(verifier43);
      const { context } = createValidContext({
        authCode: { codeChallenge },
        codeVerifier: verifier43,
      });
      const result = await validateTokenRequest(context);
      expect(result.codeVerified).toBe(true);
    });

    it('should accept code_verifier of exactly 128 characters', async () => {
      const verifier128 = 'A'.repeat(128);
      const codeChallenge = await generateCodeChallenge(verifier128);
      const { context } = createValidContext({
        authCode: { codeChallenge },
        codeVerifier: verifier128,
      });
      const result = await validateTokenRequest(context);
      expect(result.codeVerified).toBe(true);
    });
  });

  describe('Successful validation result', () => {
    it('should return validated token request with all fields', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        authCode: {
          codeChallenge,
          scope: ['openid', 'profile', 'email'],
          nonce: 'test-nonce',
        },
        codeVerifier,
      });
      const result = await validateTokenRequest(context);
      expect(result.grantType).toBe('authorization_code');
      expect(result.clientId).toBe('client-123');
      expect(result.code).toBe('valid-auth-code');
      expect(result.redirectUri).toBe('https://client.example.com/cb');
      expect(result.scope).toEqual(['openid', 'profile', 'email']);
      expect(result.nonce).toBe('test-nonce');
      expect(result.codeVerified).toBe(true);
    });

    it('should include audience from authorization code when provided', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        authCode: {
          codeChallenge,
          audience: ['https://api.example.com', 'https://other.example.com'],
        },
        codeVerifier,
      });
      const result = await validateTokenRequest(context);
      expect(result.audience).toEqual(['https://api.example.com', 'https://other.example.com']);
    });

    it('should return undefined audience when not in authorization code', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        authCode: { codeChallenge },
        codeVerifier,
      });
      const result = await validateTokenRequest(context);
      expect(result.audience).toBeUndefined();
    });

    // OIDC Core 1.0 §3.1.2.1: acr_values requested at authorization is carried on the
    // authorization code and must be returned so the token endpoint can pass it to the
    // AcrResolver as requestedAcrValues.
    it('should include acrValues from authorization code when provided', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        authCode: { codeChallenge, acrValues: 'loa2 loa3' },
        codeVerifier,
      });
      const result = await validateTokenRequest(context);
      expect(result).toMatchObject({
        grantType: 'authorization_code',
        acrValues: 'loa2 loa3',
      });
    });

    it('should return undefined acrValues when not in authorization code', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const { context } = createValidContext({
        authCode: { codeChallenge },
        codeVerifier,
      });
      const result = await validateTokenRequest(context);
      expect(result).toMatchObject({
        grantType: 'authorization_code',
        acrValues: undefined,
      });
    });

    it('should call revokeAuthorizationCode after successful validation', async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      let revokedCode: string | undefined;
      const { context } = createValidContext({
        authCode: { codeChallenge },
        codeVerifier,
      });
      context.authCodeResolver.revokeAuthorizationCode = async (code: string) => {
        revokedCode = code;
      };
      await validateTokenRequest(context);
      expect(revokedCode).toBe('valid-auth-code');
    });
  });
});

// --- Helper: refresh_token grant用コンテキストを構築 ---
function createRefreshTokenContext(overrides?: {
  refreshToken?: string;
  refreshTokenInfo?: Partial<RefreshTokenInfo>;
  hasResolver?: boolean;
  scope?: string;
}): TokenRequestContext {
  const now = Math.floor(Date.now() / 1000);
  const defaultRefreshTokenInfo: RefreshTokenInfo = {
    subject: 'user-123',
    clientId: 'client-123',
    scope: ['openid', 'profile'],
    expiresAt: now + 3600,
    used: false,
    grantId: 'grant-rt-001',
    authTime: now - 60,
    originalIssuedAt: now - 60,
    ...overrides?.refreshTokenInfo,
  };

  const clientResolver: TokenClientResolver = {
    findClient: async (clientId: string) => {
      if (clientId === 'client-123') {
        // Refresh-capable client: explicitly registered for both grant types
        // (RFC 7591 §2 default is authorization_code only).
        return {
          clientId: 'client-123',
          clientSecret: 'secret-456',
          grantTypes: ['authorization_code', 'refresh_token'],
        };
      }
      return null;
    },
  };

  const authCodeResolver: AuthorizationCodeResolver = {
    findAuthorizationCode: async () => null,
    revokeAuthorizationCode: async () => {},
  };

  const refreshTokenResolver: RefreshTokenResolver | undefined =
    overrides?.hasResolver === false
      ? undefined
      : {
          resolve: async (token: string) => {
            if (token === (overrides?.refreshToken ?? 'valid-refresh-token')) {
              return defaultRefreshTokenInfo;
            }
            return null;
          },
          revokeRefreshToken: async () => {},
        };

  return {
    params: {
      grant_type: 'refresh_token',
      code: '',
      code_verifier: '',
      refresh_token: overrides?.refreshToken ?? 'valid-refresh-token',
      scope: overrides?.scope,
    },
    clientResolver,
    authCodeResolver,
    authenticatedClientId: 'client-123',
    refreshTokenResolver,
  };
}

describe('validateTokenRequest - refresh_token grant', () => {
  describe('refresh_token parameter validation', () => {
    it('should reject missing refresh_token parameter', async () => {
      const context = createRefreshTokenContext();
      context.params.refresh_token = undefined;
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidRequest });
    });

    it('should reject when refreshTokenResolver is not provided', async () => {
      const context = createRefreshTokenContext({ hasResolver: false });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidRequest });
    });
  });

  describe('Refresh token info validation', () => {
    it('should reject when refresh token is not found', async () => {
      const context = createRefreshTokenContext();
      // Override params to use a token the resolver does not recognize
      context.params.refresh_token = 'not-existing-token';
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    it('should reject when refresh token has already been used', async () => {
      const context = createRefreshTokenContext({ refreshTokenInfo: { used: true } });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    it('should reject when refresh token was issued to a different client', async () => {
      const context = createRefreshTokenContext({
        refreshTokenInfo: { clientId: 'other-client' },
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    it('should reject when refresh token has expired', async () => {
      const now = Math.floor(Date.now() / 1000);
      const context = createRefreshTokenContext({
        refreshTokenInfo: { expiresAt: now - 100 },
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidGrant });
    });

    // RFC 7519 §4.1.4 (on-or-after): expiresAt === now must be treated as expired,
    // matching the authorization-code boundary (no <-vs-<= mismatch between grants).
    it('should reject a refresh token whose expiresAt equals now', async () => {
      const now = Math.floor(Date.now() / 1000);
      const context = createRefreshTokenContext({
        refreshTokenInfo: { expiresAt: now },
      });
      await expect(validateTokenRequest(context)).rejects.toMatchObject({
        error: TokenErrorCode.InvalidGrant,
      });
    });

    // Opt-in refresh token idle (inactivity) timeout. Default OFF. RFC 9700 §4.14.2
    // recommends limiting refresh token exposure (rotation + limited lifetime); the
    // idle-timeout mechanism itself is a common IdP feature (e.g. Auth0 inactivity
    // lifetime) that operationalizes that guidance, not a claim mandated by the RFC.
    describe('idle (inactivity) timeout', () => {
      it('should not expire an idle refresh token when no timeout is configured (backward compatible)', async () => {
        const now = Math.floor(Date.now() / 1000);
        const context = createRefreshTokenContext({
          refreshTokenInfo: { lastUsedAt: now - 100000 },
        });
        const result = await validateTokenRequest(context);
        expect(result.grantType).toBe('refresh_token');
      });

      it('should reject when now - lastUsedAt exceeds the idle timeout', async () => {
        const now = Math.floor(Date.now() / 1000);
        const context = createRefreshTokenContext({
          refreshTokenInfo: { lastUsedAt: now - 1000 },
        });
        context.refreshTokenIdleTimeoutSeconds = 600;
        await expect(validateTokenRequest(context)).rejects.toMatchObject({
          error: TokenErrorCode.InvalidGrant,
          errorDescription: 'Refresh token expired due to inactivity',
        });
      });

      it('should accept when now - lastUsedAt is within the idle timeout', async () => {
        const now = Math.floor(Date.now() / 1000);
        const context = createRefreshTokenContext({
          refreshTokenInfo: { lastUsedAt: now - 100 },
        });
        context.refreshTokenIdleTimeoutSeconds = 600;
        const result = await validateTokenRequest(context);
        expect(result.grantType).toBe('refresh_token');
      });

      it('should skip the idle check when lastUsedAt is not stored even if a timeout is set', async () => {
        const context = createRefreshTokenContext({
          refreshTokenInfo: { lastUsedAt: undefined },
        });
        context.refreshTokenIdleTimeoutSeconds = 600;
        const result = await validateTokenRequest(context);
        expect(result.grantType).toBe('refresh_token');
      });
    });
  });

  describe('Successful refresh token validation', () => {
    it('should return grantType refresh_token', async () => {
      const context = createRefreshTokenContext();
      const result = await validateTokenRequest(context);
      expect(result.grantType).toBe('refresh_token');
    });

    it('should return clientId', async () => {
      const context = createRefreshTokenContext();
      const result = await validateTokenRequest(context);
      expect(result.clientId).toBe('client-123');
    });

    it('should return subject from refresh token info', async () => {
      const context = createRefreshTokenContext({
        refreshTokenInfo: { subject: 'user-xyz' },
      });
      const result = await validateTokenRequest(context);
      // Narrow the type to access subject
      if (result.grantType === 'refresh_token') {
        expect(result.subject).toBe('user-xyz');
      }
    });

    it('should return scope from refresh token info', async () => {
      const context = createRefreshTokenContext({
        refreshTokenInfo: { scope: ['openid', 'email'] },
      });
      const result = await validateTokenRequest(context);
      expect(result.scope).toEqual(['openid', 'email']);
    });

    it('should return requested scope when it is a subset of original scope', async () => {
      const context = createRefreshTokenContext({
        refreshTokenInfo: { scope: ['openid', 'profile', 'email'] },
        scope: 'openid profile',
      });
      const result = await validateTokenRequest(context);
      expect(result.scope).toEqual(['openid', 'profile']);
    });

    it('should return original scope when requested scope is identical', async () => {
      const context = createRefreshTokenContext({
        refreshTokenInfo: { scope: ['openid', 'profile'] },
        scope: 'openid profile',
      });
      const result = await validateTokenRequest(context);
      expect(result.scope).toEqual(['openid', 'profile']);
    });

    it('should handle scope with extra spaces and duplicates', async () => {
      const context = createRefreshTokenContext({
        refreshTokenInfo: { scope: ['openid', 'profile', 'email'] },
        scope: '  openid   profile  openid  ',
      });
      const result = await validateTokenRequest(context);
      expect(result.scope).toEqual(['openid', 'profile']);
    });

    // OAuth 2.1 Section 4.3.1 のローテーションは、新トークン保存成功後に呼び出し側が
    // 旧 RT を失効する責務を負う。validateTokenRequest 内では失効しない。
    it('should not revoke refresh token inside validateTokenRequest (rotation handled by caller)', async () => {
      let revokedToken: string | undefined;
      const context = createRefreshTokenContext();
      context.refreshTokenResolver!.revokeRefreshToken = async (token: string) => {
        revokedToken = token;
      };
      await validateTokenRequest(context);
      expect(revokedToken).toBeUndefined();
    });

    it('should propagate grantId from refresh token info', async () => {
      const context = createRefreshTokenContext({
        refreshTokenInfo: { grantId: 'grant-propagated' },
      });
      const result = await validateTokenRequest(context);
      if (result.grantType === 'refresh_token') {
        expect(result.grantId).toBe('grant-propagated');
      }
    });

    // T-002: 元アクセストークンの audience を新 AT に引き継ぐ
    it('should propagate audience from refresh token info', async () => {
      const context = createRefreshTokenContext({
        refreshTokenInfo: { audience: ['https://api.example.com'] },
      });
      const result = await validateTokenRequest(context);
      if (result.grantType === 'refresh_token') {
        expect(result.audience).toEqual(['https://api.example.com']);
      }
    });

    it('should leave audience undefined when refresh token info has no audience', async () => {
      const context = createRefreshTokenContext();
      const result = await validateTokenRequest(context);
      if (result.grantType === 'refresh_token') {
        expect(result.audience).toBeUndefined();
      }
    });

    // T-005: OIDC Core 1.0 §12.1 — refresh で再発行する ID Token は初回認証時と同じ
    // auth_time / nonce / acr / amr / azp を保持しなければならない。
    describe('OIDC Core 1.0 §12.1 ID Token claim preservation', () => {
      it('should propagate authTime from refresh token info', async () => {
        const context = createRefreshTokenContext({
          refreshTokenInfo: { authTime: 1_700_000_000 },
        });
        const result = await validateTokenRequest(context);
        if (result.grantType === 'refresh_token') {
          expect(result.authTime).toBe(1_700_000_000);
        }
      });

      it('should propagate nonce from refresh token info', async () => {
        const context = createRefreshTokenContext({
          refreshTokenInfo: { nonce: 'original-nonce' },
        });
        const result = await validateTokenRequest(context);
        if (result.grantType === 'refresh_token') {
          expect(result.nonce).toBe('original-nonce');
        }
      });

      it('should propagate acr from refresh token info', async () => {
        const context = createRefreshTokenContext({
          refreshTokenInfo: { acr: 'urn:mace:incommon:iap:silver' },
        });
        const result = await validateTokenRequest(context);
        if (result.grantType === 'refresh_token') {
          expect(result.acr).toBe('urn:mace:incommon:iap:silver');
        }
      });

      it('should propagate amr from refresh token info', async () => {
        const context = createRefreshTokenContext({
          refreshTokenInfo: { amr: ['pwd', 'mfa'] },
        });
        const result = await validateTokenRequest(context);
        if (result.grantType === 'refresh_token') {
          expect(result.amr).toEqual(['pwd', 'mfa']);
        }
      });

      it('should propagate azp from refresh token info', async () => {
        const context = createRefreshTokenContext({
          refreshTokenInfo: { azp: 'client-123' },
        });
        const result = await validateTokenRequest(context);
        if (result.grantType === 'refresh_token') {
          expect(result.azp).toBe('client-123');
        }
      });
    });

    // RFC 6749 §6: refresh 時の scope 縮小は当該リクエストの access token / ID Token の
    // 権限縮小として扱い、refresh token rotation の可否とは切り離す。rotation 可否は
    // 「元の grant が offline_access を持っていたか」で判断するため、その情報を hadOfflineAccess
    // として伝播させる。
    describe('Refresh token rotation eligibility (hadOfflineAccess)', () => {
      it('should set hadOfflineAccess to true when original refresh token scope includes offline_access', async () => {
        const context = createRefreshTokenContext({
          refreshTokenInfo: { scope: ['openid', 'offline_access'] },
        });
        const result = await validateTokenRequest(context);
        expect(result).toMatchObject({ grantType: 'refresh_token', hadOfflineAccess: true });
      });

      it('should set hadOfflineAccess to false when original refresh token scope lacks offline_access', async () => {
        const context = createRefreshTokenContext({
          refreshTokenInfo: { scope: ['openid', 'profile'] },
        });
        const result = await validateTokenRequest(context);
        expect(result).toMatchObject({ grantType: 'refresh_token', hadOfflineAccess: false });
      });

      // 縮小後 scope から offline_access を落としても、元 grant が持っていたかどうかは
      // 元 refresh token の scope で判断するため hadOfflineAccess は true を維持する。
      it('should keep hadOfflineAccess true even when requested scope drops offline_access', async () => {
        const context = createRefreshTokenContext({
          refreshTokenInfo: { scope: ['openid', 'email', 'offline_access'] },
          scope: 'openid email',
        });
        const result = await validateTokenRequest(context);
        // effective scope（access token / ID Token 用）は縮小されたまま、
        // rotation 可否を表す hadOfflineAccess は元 grant に基づき true を維持する。
        expect(result).toMatchObject({
          grantType: 'refresh_token',
          scope: ['openid', 'email'],
          hadOfflineAccess: true,
        });
      });
    });

    // OAuth 2.1 §6.1: refresh token は initial issuance からの absolute lifetime のみで失効する。
    // そのため初回発行時刻 originalIssuedAt を rotation を跨いで引き継ぐ。
    describe('OAuth 2.1 §6.1 absolute lifetime preservation', () => {
      it('should propagate originalIssuedAt from refresh token info', async () => {
        const context = createRefreshTokenContext({
          refreshTokenInfo: { originalIssuedAt: 1_700_000_000 },
        });
        const result = await validateTokenRequest(context);
        if (result.grantType === 'refresh_token') {
          expect(result.originalIssuedAt).toBe(1_700_000_000);
        }
      });
    });
  });

  // T-003: refresh token 再利用検知時は同 grant の AT/RT を全失効する
  // (OAuth 2.1 Section 4.3.1 SHOULD)
  describe('Refresh token reuse cascade revocation', () => {
    it('should call revokeTokensByGrantId when used refresh token is detected', async () => {
      let revokedGrantId: string | undefined;
      const context = createRefreshTokenContext({
        refreshTokenInfo: { used: true, grantId: 'grant-compromised' },
      });
      context.refreshTokenResolver!.revokeTokensByGrantId = async (grantId: string) => {
        revokedGrantId = grantId;
      };
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      expect(revokedGrantId).toBe('grant-compromised');
    });

    it('should still throw invalid_grant when revokeTokensByGrantId is not provided', async () => {
      const context = createRefreshTokenContext({
        refreshTokenInfo: { used: true },
      });
      // revokeTokensByGrantId は optional なので未提供でも例外を投げる
      await expect(validateTokenRequest(context)).rejects.toMatchObject({
        error: TokenErrorCode.InvalidGrant,
      });
    });
  });

  describe('Scope validation for refresh token', () => {
    it('should reject when requested scope includes scopes not in original grant', async () => {
      const context = createRefreshTokenContext({
        refreshTokenInfo: { scope: ['openid', 'profile'] },
        scope: 'openid profile admin',
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidScope });
    });

    it('should reject when requested scope is entirely different from original grant', async () => {
      const context = createRefreshTokenContext({
        refreshTokenInfo: { scope: ['openid', 'profile'] },
        scope: 'admin write',
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidScope });
    });

    it('should reject when scope is empty string', async () => {
      const context = createRefreshTokenContext({
        scope: '',
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidScope });
    });

    it('should reject when scope is only whitespace', async () => {
      const context = createRefreshTokenContext({
        scope: '   ',
      });
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      await expect(validateTokenRequest(context)).rejects.toMatchObject({ error: TokenErrorCode.InvalidScope });
    });

    it('should not revoke refresh token when scope validation fails', async () => {
      let revokedToken: string | undefined;
      const context = createRefreshTokenContext({
        refreshTokenInfo: { scope: ['openid', 'profile'] },
        scope: 'openid admin',
      });
      context.refreshTokenResolver!.revokeRefreshToken = async (token: string) => {
        revokedToken = token;
      };
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      expect(revokedToken).toBeUndefined();
    });

    // T-003 補完: scope 検証失敗で再利用扱いにはしないので cascade revoke も呼ばない
    it('should not call revokeTokensByGrantId when scope validation fails', async () => {
      let revokedGrantId: string | undefined;
      const context = createRefreshTokenContext({
        refreshTokenInfo: { scope: ['openid', 'profile'] },
        scope: 'openid admin',
      });
      context.refreshTokenResolver!.revokeTokensByGrantId = async (grantId: string) => {
        revokedGrantId = grantId;
      };
      await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
      expect(revokedGrantId).toBeUndefined();
    });
  });
});

describe('TokenError', () => {
  it('should have correct error code', () => {
    const error = new TokenError(TokenErrorCode.InvalidGrant, 'Invalid grant');
    expect(error.error).toBe('invalid_grant');
  });

  it('should have error description', () => {
    const error = new TokenError(TokenErrorCode.InvalidClient, 'Client not found');
    expect(error.errorDescription).toBe('Client not found');
  });

  it('should extend Error', () => {
    const error = new TokenError(TokenErrorCode.InvalidRequest, 'Bad request');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Bad request');
  });

  it('should have correct HTTP status for invalid_client', () => {
    const error = new TokenError(TokenErrorCode.InvalidClient, 'Client not found');
    expect(error.statusCode).toBe(401);
  });

  it('should have HTTP status 400 for other errors', () => {
    const error = new TokenError(TokenErrorCode.InvalidGrant, 'Bad grant');
    expect(error.statusCode).toBe(400);
  });

  describe('WWW-Authenticate header', () => {
    // RFC 6750 Section 3 / OAuth 2.1 Section 5.2: 401 responses MUST include WWW-Authenticate
    it('should return WWW-Authenticate value for invalid_client error', () => {
      const error = new TokenError(TokenErrorCode.InvalidClient, 'Client not found');
      expect(error.wwwAuthenticate).toBe('Basic realm="Client Authentication"');
    });

    it('should return undefined WWW-Authenticate for invalid_grant', () => {
      const error = new TokenError(TokenErrorCode.InvalidGrant, 'Bad grant');
      expect(error.wwwAuthenticate).toBeUndefined();
    });

    it('should return undefined WWW-Authenticate for invalid_request', () => {
      const error = new TokenError(TokenErrorCode.InvalidRequest, 'Bad request');
      expect(error.wwwAuthenticate).toBeUndefined();
    });

    it('should return undefined WWW-Authenticate for unsupported_grant_type', () => {
      const error = new TokenError(TokenErrorCode.UnsupportedGrantType, 'Unsupported');
      expect(error.wwwAuthenticate).toBeUndefined();
    });
  });
});

describe('validateTokenRequest - client grant_types enforcement', () => {
  // RFC 6749 §5.2: unauthorized_client =
  // "The authenticated client is not authorized to use this authorization grant type."
  // OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: grant_types default is ["authorization_code"].

  it('should reject refresh_token grant with unauthorized_client when client grantTypes excludes refresh_token', async () => {
    const context = createRefreshTokenContext();
    // Client registered for authorization_code only (no refresh_token).
    context.clientResolver = {
      findClient: async (clientId: string) =>
        clientId === 'client-123'
          ? { clientId: 'client-123', clientSecret: 'secret-456', grantTypes: ['authorization_code'] }
          : null,
    };
    await expect(validateTokenRequest(context)).rejects.toMatchObject({
      error: TokenErrorCode.UnauthorizedClient,
    });
  });

  it('should reject refresh_token grant with unauthorized_client when grantTypes is unspecified (default authorization_code only)', async () => {
    // Backward-compatible default per RFC 7591: ["authorization_code"] excludes refresh_token.
    const context = createRefreshTokenContext();
    context.clientResolver = {
      findClient: async (clientId: string) =>
        clientId === 'client-123'
          ? { clientId: 'client-123', clientSecret: 'secret-456' }
          : null,
    };
    await expect(validateTokenRequest(context)).rejects.toMatchObject({
      error: TokenErrorCode.UnauthorizedClient,
    });
  });

  it('should allow refresh_token grant when client grantTypes includes refresh_token', async () => {
    const context = createRefreshTokenContext();
    context.clientResolver = {
      findClient: async (clientId: string) =>
        clientId === 'client-123'
          ? { clientId: 'client-123', clientSecret: 'secret-456', grantTypes: ['authorization_code', 'refresh_token'] }
          : null,
    };
    const result = await validateTokenRequest(context);
    expect(result.grantType).toBe('refresh_token');
  });

  it('should allow authorization_code grant when client grantTypes includes authorization_code', async () => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const { context } = createValidContext({
      client: { grantTypes: ['authorization_code'] },
      authCode: { codeChallenge },
      codeVerifier,
    });
    const result = await validateTokenRequest(context);
    expect(result.grantType).toBe('authorization_code');
  });

  it('should allow authorization_code grant when grantTypes is unspecified (default)', async () => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const { context } = createValidContext({
      authCode: { codeChallenge },
      codeVerifier,
    });
    const result = await validateTokenRequest(context);
    expect(result.grantType).toBe('authorization_code');
  });

  it('should return unsupported_grant_type (not unauthorized_client) for a globally unsupported grant_type', async () => {
    // Global OP-level rejection MUST be distinguished from per-client authorization.
    const { context } = createValidContext({
      params: { grant_type: 'client_credentials' },
      client: { grantTypes: ['authorization_code'] },
    });
    await expect(validateTokenRequest(context)).rejects.toMatchObject({
      error: TokenErrorCode.UnsupportedGrantType,
    });
  });
});

// RFC 6749 §3.2.1: public clients have no client_secret. validateTokenRequest
// receives the already-authenticated client_id (resolved via authenticateClient's
// `none` path) and binds the grant to that client_id just like a confidential client.
describe('validateTokenRequest - public client', () => {
  it('should exchange authorization code for a public client without client_secret', async () => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const { context } = createValidContext({
      client: { clientSecret: undefined, tokenEndpointAuthMethod: 'none' },
      authCode: { codeChallenge },
      codeVerifier,
    });
    const result = await validateTokenRequest(context);
    expect(result.grantType).toBe('authorization_code');
    expect(result.clientId).toBe('client-123');
  });

  it('should refresh tokens for a public client without client_secret', async () => {
    const context = createRefreshTokenContext();
    context.clientResolver = {
      findClient: async (clientId: string) =>
        clientId === 'client-123'
          ? {
              clientId: 'client-123',
              tokenEndpointAuthMethod: 'none',
              grantTypes: ['authorization_code', 'refresh_token'],
            }
          : null,
    };
    const result = await validateTokenRequest(context);
    expect(result.grantType).toBe('refresh_token');
    expect(result.clientId).toBe('client-123');
  });

  // RFC 6749 §6: the refresh token MUST be bound to the public client it was issued to.
  it('should reject refresh token bound to a different public client', async () => {
    const context = createRefreshTokenContext({
      refreshTokenInfo: { clientId: 'other-public-client' },
    });
    context.clientResolver = {
      findClient: async (clientId: string) =>
        clientId === 'client-123'
          ? {
              clientId: 'client-123',
              tokenEndpointAuthMethod: 'none',
              grantTypes: ['authorization_code', 'refresh_token'],
            }
          : null,
    };
    await expect(validateTokenRequest(context)).rejects.toMatchObject({
      error: TokenErrorCode.InvalidGrant,
    });
  });
});

// OAuth 2.1 §4.1.2 / RFC 9700 §4.13: revoke* must keep the record as used:true
// (not physically delete) so a reused code/token still triggers the grant-wide
// revocation cascade. This contract test exercises both a compliant (consume)
// store and a non-compliant (delete) store end-to-end through validateTokenRequest
// to make the difference observable — the symptom of a delete implementation is
// that revokeTokensByGrantId is never called on reuse.
describe('revoke* contract: used-mark vs physical delete (reuse cascade)', () => {
  async function buildAuthCodeContext(mode: 'consume' | 'delete') {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const now = Math.floor(Date.now() / 1000);

    const store = new Map<string, AuthorizationCodeInfo>();
    store.set('code-1', {
      code: 'code-1',
      clientId: 'client-123',
      redirectUri: 'https://client.example.com/cb',
      redirectUriExplicit: false,
      scope: ['openid'],
      codeChallenge,
      codeChallengeMethod: 'S256',
      expiresAt: now + 600,
      used: false,
      grantId: 'grant-1',
    });

    const revokedGrantIds: string[] = [];

    const authCodeResolver: AuthorizationCodeResolver = {
      findAuthorizationCode: async (code) => store.get(code) ?? null,
      // consume: keep the record but flip used=true (compliant).
      // delete: physically remove the record (non-compliant).
      revokeAuthorizationCode: async (code) => {
        if (mode === 'consume') {
          const entry = store.get(code);
          if (entry) store.set(code, { ...entry, used: true });
        } else {
          store.delete(code);
        }
      },
      revokeTokensByGrantId: async (grantId) => {
        revokedGrantIds.push(grantId);
      },
    };

    const clientResolver: TokenClientResolver = {
      findClient: async (clientId) =>
        clientId === 'client-123'
          ? { clientId: 'client-123', clientSecret: 'secret-456' }
          : null,
    };

    const context: TokenRequestContext = {
      params: {
        grant_type: 'authorization_code',
        code: 'code-1',
        redirect_uri: 'https://client.example.com/cb',
        code_verifier: codeVerifier,
      },
      clientResolver,
      authCodeResolver,
      authenticatedClientId: 'client-123',
    };

    return { context, store, revokedGrantIds };
  }

  it('should keep the code as used:true after exchange when revoke consumes (not deletes)', async () => {
    const { context, store } = await buildAuthCodeContext('consume');
    await validateTokenRequest(context);
    expect(store.get('code-1')).toMatchObject({ used: true });
  });

  it('should reject reuse with invalid_grant AND revoke the grant when revoke consumes', async () => {
    const { context, revokedGrantIds } = await buildAuthCodeContext('consume');
    await validateTokenRequest(context);
    await expect(validateTokenRequest(context)).rejects.toMatchObject({
      error: TokenErrorCode.InvalidGrant,
    });
    expect(revokedGrantIds).toEqual(['grant-1']);
  });

  // Contract violation made visible: a delete implementation rejects reuse as
  // not-found but never fires the cascade, so previously issued tokens survive.
  it('should reject reuse but FAIL to revoke the grant when revoke physically deletes', async () => {
    const { context, store, revokedGrantIds } = await buildAuthCodeContext('delete');
    await validateTokenRequest(context);
    expect(store.get('code-1')).toBeUndefined();
    await expect(validateTokenRequest(context)).rejects.toMatchObject({
      error: TokenErrorCode.InvalidGrant,
    });
    expect(revokedGrantIds).toEqual([]);
  });
});

// OPレベルの grant 提供可否（機能トグル）。クライアント別の grantTypes 認可
// （unauthorized_client）とは別の軸で、OP 自体が提供しない grant_type は
// RFC 6749 §5.2 の unsupported_grant_type として拒否する。
describe('validateTokenRequest - supportedGrantTypes option', () => {
  it('should reject refresh_token grant with unsupported_grant_type when supportedGrantTypes excludes it', async () => {
    const context = createRefreshTokenContext();
    context.supportedGrantTypes = ['authorization_code'];
    await expect(validateTokenRequest(context)).rejects.toThrow(TokenError);
    await expect(validateTokenRequest(context)).rejects.toMatchObject({
      error: TokenErrorCode.UnsupportedGrantType,
      errorDescription: 'Unsupported grant_type: refresh_token',
    });
  });

  it('should reject authorization_code grant with unsupported_grant_type when supportedGrantTypes excludes it', async () => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const { context } = createValidContext({
      authCode: { codeChallenge },
      codeVerifier,
    });
    context.supportedGrantTypes = ['refresh_token'];
    await expect(validateTokenRequest(context)).rejects.toMatchObject({
      error: TokenErrorCode.UnsupportedGrantType,
      errorDescription: 'Unsupported grant_type: authorization_code',
    });
  });

  it('should accept authorization_code grant when supportedGrantTypes is ["authorization_code"]', async () => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const { context } = createValidContext({
      authCode: { codeChallenge },
      codeVerifier,
    });
    context.supportedGrantTypes = ['authorization_code'];
    const result = await validateTokenRequest(context);
    expect(result).toMatchObject({
      grantType: 'authorization_code',
      clientId: 'client-123',
    });
  });

  it('should accept refresh_token grant when supportedGrantTypes lists both grant types', async () => {
    const context = createRefreshTokenContext();
    context.supportedGrantTypes = ['authorization_code', 'refresh_token'];
    const result = await validateTokenRequest(context);
    expect(result).toMatchObject({
      grantType: 'refresh_token',
      clientId: 'client-123',
    });
  });
});

// 機能分割された grant 単位のエントリポイント。grant 固有の検証のみを行い、
// クライアント認証・クライアント別 grant 認可を含むフル経路は validateTokenRequest。
describe('validateAuthorizationCodeGrant', () => {
  it('should return the validated authorization_code request', async () => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const { context } = createValidContext({
      authCode: { codeChallenge },
      codeVerifier,
    });
    const result = await validateAuthorizationCodeGrant(context);
    expect(result).toMatchObject({
      grantType: 'authorization_code',
      clientId: 'client-123',
      code: 'valid-auth-code',
      grantId: 'grant-1',
      redirectUri: 'https://client.example.com/cb',
      scope: ['openid', 'profile'],
      codeVerified: true,
    });
  });

  it('should reject an unknown authorization code with invalid_grant', async () => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const { context } = createValidContext({
      authCode: { codeChallenge },
      codeVerifier,
    });
    context.params.code = 'unknown-code';
    await expect(validateAuthorizationCodeGrant(context)).rejects.toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Authorization code not found',
    });
  });
});

describe('validateRefreshTokenGrant', () => {
  it('should return the validated refresh_token request', async () => {
    const context = createRefreshTokenContext();
    const result = await validateRefreshTokenGrant(context);
    expect(result).toMatchObject({
      grantType: 'refresh_token',
      clientId: 'client-123',
      subject: 'user-123',
      scope: ['openid', 'profile'],
      grantId: 'grant-rt-001',
      hadOfflineAccess: false,
    });
  });

  it('should reject an unknown refresh token with invalid_grant', async () => {
    const context = createRefreshTokenContext();
    context.params.refresh_token = 'unknown-refresh-token';
    await expect(validateRefreshTokenGrant(context)).rejects.toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Refresh token not found',
    });
  });
});
