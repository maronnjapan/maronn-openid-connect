/**
 * Token Endpoint のリクエスト検証ステップ関数の振る舞いテスト。
 *
 * CLI 生成コードは grant_type の検証、クライアントの解決、grant 固有の検証を
 * ステップ関数ごとに呼び出す。本ファイルは各ステップの振る舞い（エラーコード、
 * error_description、戻り値、resolver の呼び出し）を網羅的に固定する。
 * ステップをつないだ呼び出し順序は、各 sample の conformance.test.ts が担保する。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveAuthenticatedTokenClient,
  validateClientGrantType,
  validateGrantTypeSupported,
} from './token-request.js';
import type {
  AuthorizationCodeInfo,
  AuthorizationCodeResolver,
  RefreshTokenInfo,
  RefreshTokenResolver,
  TokenClientInfo,
  TokenClientResolver,
  TokenRequestParams,
} from './token-request.js';
import {
  buildValidatedAuthorizationCodeRequest,
  consumeAuthorizationCode,
  resolveAuthorizationCode,
  validateAuthorizationCodeClient,
  validateAuthorizationCodeExpiration,
  validateAuthorizationCodeRedirectUri,
  validateAuthorizationCodeUnused,
  verifyAuthorizationCodePkce,
} from './authorization-code-grant.js';
import {
  buildValidatedRefreshTokenRequest,
  resolveRefreshToken,
  validateRefreshTokenClient,
  validateRefreshTokenExpiration,
  validateRefreshTokenIdleTimeout,
  validateRefreshTokenScope,
  validateRefreshTokenUnused,
} from './refresh-token-grant.js';
import { TokenError, TokenErrorCode } from './token-error.js';

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

// --- Helper: 同期ステップが投げた例外を取り出す（投げなければ undefined） ---
function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

// --- Helper: 非同期ステップが投げた例外を取り出す（投げなければ undefined） ---
async function captureAsyncError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

// --- Helper: ステップ関数の既定 currentTime と同じ時計（Unix epoch 秒） ---
function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// --- Fixture: grant_types 未登録の confidential client ---
const confidentialClient: TokenClientInfo = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
};

function createClientResolver(clients: TokenClientInfo[]): TokenClientResolver {
  return {
    findClient: async (clientId: string) =>
      clients.find((client) => client.clientId === clientId) ?? null,
  };
}

// --- Fixture: client-123 に発行された、未使用・有効期限内・PKCE 束縛なしの認可コード ---
function createAuthorizationCode(
  overrides: Partial<AuthorizationCodeInfo> = {},
): AuthorizationCodeInfo {
  return {
    code: 'valid-auth-code',
    grantId: 'grant-1',
    clientId: 'client-123',
    redirectUri: 'https://client.example.com/cb',
    redirectUriExplicit: false,
    scope: ['openid', 'profile'],
    expiresAt: nowInSeconds() + 600,
    used: false,
    ...overrides,
  };
}

// --- Fixture: codeVerifier に対する S256 の code_challenge を保存した認可コード ---
async function createPkceBoundAuthorizationCode(
  codeVerifier: string,
): Promise<AuthorizationCodeInfo> {
  return createAuthorizationCode({
    codeChallenge: await generateCodeChallenge(codeVerifier),
    codeChallengeMethod: 'S256',
  });
}

function createAuthorizationCodeResolver(
  codes: AuthorizationCodeInfo[] = [],
  overrides: Partial<AuthorizationCodeResolver> = {},
): AuthorizationCodeResolver {
  return {
    findAuthorizationCode: async (code: string) =>
      codes.find((authorizationCode) => authorizationCode.code === code) ?? null,
    revokeAuthorizationCode: async () => {},
    ...overrides,
  };
}

// --- Fixture: client-123 に発行された、未使用・有効期限内・offline_access なしの refresh token ---
function createRefreshTokenInfo(
  overrides: Partial<RefreshTokenInfo> = {},
): RefreshTokenInfo {
  return {
    subject: 'user-123',
    clientId: 'client-123',
    scope: ['openid', 'profile'],
    expiresAt: nowInSeconds() + 3600,
    used: false,
    grantId: 'grant-rt-001',
    authTime: 1_699_990_000,
    originalIssuedAt: 1_699_990_000,
    ...overrides,
  };
}

function createRefreshTokenResolver(
  tokens: Record<string, RefreshTokenInfo> = {},
  overrides: Partial<RefreshTokenResolver> = {},
): RefreshTokenResolver {
  return {
    resolve: async (token: string) => tokens[token] ?? null,
    revokeRefreshToken: async () => {},
    ...overrides,
  };
}

describe('validateGrantTypeSupported', () => {
  describe('grant_type validation', () => {
    it('should reject missing grant_type', () => {
      const error = captureError(() => validateGrantTypeSupported(undefined));

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: TokenErrorCode.InvalidRequest,
        errorDescription: 'Missing required parameter: grant_type',
      });
    });

    // RFC 6749 §5.2: OP 全体で提供しない grant_type は unsupported_grant_type。
    // クライアント別の不許可（unauthorized_client）は validateClientGrantType が担う別の軸。
    it('should reject unsupported grant_type', () => {
      const error = captureError(() =>
        validateGrantTypeSupported('client_credentials'),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: TokenErrorCode.UnsupportedGrantType,
        errorDescription: 'Unsupported grant_type: client_credentials',
      });
    });

    it('should accept grant_type=authorization_code', () => {
      const result = validateGrantTypeSupported('authorization_code');

      expect(result).toBe('authorization_code');
    });
  });

  // OPレベルの grant 提供可否（機能トグル）。クライアント別の grantTypes 認可
  // （unauthorized_client）とは別の軸で、OP 自体が提供しない grant_type は
  // RFC 6749 §5.2 の unsupported_grant_type として拒否する。
  describe('supportedGrantTypes option', () => {
    it('should reject refresh_token grant with unsupported_grant_type when supportedGrantTypes excludes it', () => {
      const error = captureError(() =>
        validateGrantTypeSupported('refresh_token', ['authorization_code']),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: TokenErrorCode.UnsupportedGrantType,
        errorDescription: 'Unsupported grant_type: refresh_token',
      });
    });

    it('should reject authorization_code grant with unsupported_grant_type when supportedGrantTypes excludes it', () => {
      const error = captureError(() =>
        validateGrantTypeSupported('authorization_code', ['refresh_token']),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: TokenErrorCode.UnsupportedGrantType,
        errorDescription: 'Unsupported grant_type: authorization_code',
      });
    });

    it('should accept authorization_code grant when supportedGrantTypes is ["authorization_code"]', () => {
      const result = validateGrantTypeSupported('authorization_code', [
        'authorization_code',
      ]);

      expect(result).toBe('authorization_code');
    });

    it('should accept refresh_token grant when supportedGrantTypes lists both grant types', () => {
      const result = validateGrantTypeSupported('refresh_token', [
        'authorization_code',
        'refresh_token',
      ]);

      expect(result).toBe('refresh_token');
    });
  });
});

describe('resolveAuthenticatedTokenClient', () => {
  it('should reject when authenticatedClientId is not provided', async () => {
    const error = await captureAsyncError(() =>
      resolveAuthenticatedTokenClient(
        undefined as unknown as string,
        createClientResolver([confidentialClient]),
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidClient,
      errorDescription: 'Client authentication required',
    });
  });

  it('should reject when client is not found', async () => {
    const error = await captureAsyncError(() =>
      resolveAuthenticatedTokenClient(
        'unknown-client',
        createClientResolver([confidentialClient]),
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidClient,
      errorDescription: 'Client authentication failed',
    });
  });

  it('should accept valid authenticated client', async () => {
    const result = await resolveAuthenticatedTokenClient(
      'client-123',
      createClientResolver([confidentialClient]),
    );

    expect(result).toEqual({
      clientId: 'client-123',
      clientSecret: 'secret-456',
    });
  });

  // RFC 6749 §3.2.1: public clients have no client_secret. The step receives the
  // client_id produced by client authentication (the `none` method) and resolves it
  // just like a confidential client's.
  describe('public client', () => {
    it('should resolve a public client registered without client_secret', async () => {
      const result = await resolveAuthenticatedTokenClient(
        'client-123',
        createClientResolver([
          { clientId: 'client-123', tokenEndpointAuthMethod: 'none' },
        ]),
      );

      expect(result).toEqual({
        clientId: 'client-123',
        tokenEndpointAuthMethod: 'none',
      });
    });
  });
});

describe('validateClientGrantType', () => {
  // RFC 6749 §5.2: unauthorized_client =
  // "The authenticated client is not authorized to use this authorization grant type."
  // OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: grant_types default is ["authorization_code"].
  describe('client grant_types enforcement', () => {
    it('should reject refresh_token grant with unauthorized_client when client grantTypes excludes refresh_token', () => {
      // Client registered for authorization_code only (no refresh_token).
      const client: TokenClientInfo = {
        clientId: 'client-123',
        clientSecret: 'secret-456',
        grantTypes: ['authorization_code'],
      };

      const error = captureError(() =>
        validateClientGrantType(client, 'refresh_token'),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: TokenErrorCode.UnauthorizedClient,
        errorDescription: 'Client is not authorized to use grant_type: refresh_token',
      });
    });

    it('should reject refresh_token grant with unauthorized_client when grantTypes is unspecified (default authorization_code only)', () => {
      // Spec default (RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2): omitted
      // grant_types means ["authorization_code"], which excludes refresh_token.
      const error = captureError(() =>
        validateClientGrantType(confidentialClient, 'refresh_token'),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: TokenErrorCode.UnauthorizedClient,
        errorDescription: 'Client is not authorized to use grant_type: refresh_token',
      });
    });

    it('should allow refresh_token grant when client grantTypes includes refresh_token', () => {
      const client: TokenClientInfo = {
        clientId: 'client-123',
        clientSecret: 'secret-456',
        grantTypes: ['authorization_code', 'refresh_token'],
      };

      expect(() => validateClientGrantType(client, 'refresh_token')).not.toThrow();
    });

    it('should allow authorization_code grant when client grantTypes includes authorization_code', () => {
      const client: TokenClientInfo = {
        clientId: 'client-123',
        clientSecret: 'secret-456',
        grantTypes: ['authorization_code'],
      };

      expect(() =>
        validateClientGrantType(client, 'authorization_code'),
      ).not.toThrow();
    });

    it('should allow authorization_code grant when grantTypes is unspecified (default)', () => {
      expect(() =>
        validateClientGrantType(confidentialClient, 'authorization_code'),
      ).not.toThrow();
    });
  });

  // RFC 6749 §3.2.1: public clients have no client_secret. Per-client grant_types
  // authorization applies to them exactly as to confidential clients.
  describe('public client', () => {
    it('should allow the refresh_token grant for a public client without client_secret', () => {
      const publicClient: TokenClientInfo = {
        clientId: 'client-123',
        tokenEndpointAuthMethod: 'none',
        grantTypes: ['authorization_code', 'refresh_token'],
      };

      expect(() =>
        validateClientGrantType(publicClient, 'refresh_token'),
      ).not.toThrow();
    });
  });
});

describe('resolveAuthorizationCode', () => {
  it('should reject missing code parameter', async () => {
    const error = await captureAsyncError(() =>
      resolveAuthorizationCode(
        { grant_type: 'authorization_code' },
        createAuthorizationCodeResolver([createAuthorizationCode()]),
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidRequest,
      errorDescription: 'Missing required parameter: code',
    });
  });

  it('should reject unknown authorization code', async () => {
    const error = await captureAsyncError(() =>
      resolveAuthorizationCode(
        { grant_type: 'authorization_code', code: 'unknown-code' },
        createAuthorizationCodeResolver([createAuthorizationCode()]),
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Authorization code not found',
    });
  });

  it('should accept valid authorization code', async () => {
    const authorizationCode = createAuthorizationCode();

    const result = await resolveAuthorizationCode(
      { grant_type: 'authorization_code', code: 'valid-auth-code' },
      createAuthorizationCodeResolver([authorizationCode]),
    );

    expect(result).toEqual({
      code: 'valid-auth-code',
      authorizationCode,
    });
  });
});

describe('validateAuthorizationCodeUnused', () => {
  it('should reject already used authorization code', async () => {
    const error = await captureAsyncError(() =>
      validateAuthorizationCodeUnused(
        createAuthorizationCode({ used: true }),
        createAuthorizationCodeResolver(),
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Authorization code has already been used',
    });
  });

  // OAuth 2.1 Section 4.1.2 / RFC 6749 Section 4.1.2:
  // On reuse, the AS MUST deny AND SHOULD revoke previously issued tokens.
  describe('Code reuse: token revocation (OP-OAuth-2nd-Revokes)', () => {
    it('should call revokeTokensByGrantId with the grantId of the reused code', async () => {
      const revokedGrantIds: string[] = [];
      const resolver = createAuthorizationCodeResolver([], {
        revokeTokensByGrantId: async (grantId: string) => {
          revokedGrantIds.push(grantId);
        },
      });

      const error = await captureAsyncError(() =>
        validateAuthorizationCodeUnused(
          createAuthorizationCode({ used: true, grantId: 'grant-abc' }),
          resolver,
        ),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(revokedGrantIds).toEqual(['grant-abc']);
    });

    it('should still throw invalid_grant after revoking tokens', async () => {
      const resolver = createAuthorizationCodeResolver([], {
        revokeTokensByGrantId: async () => {},
      });

      const error = await captureAsyncError(() =>
        validateAuthorizationCodeUnused(
          createAuthorizationCode({ used: true, grantId: 'grant-xyz' }),
          resolver,
        ),
      );

      expect(error).toMatchObject({
        error: TokenErrorCode.InvalidGrant,
        errorDescription: 'Authorization code has already been used',
      });
    });

    // revokeTokensByGrantId は optional。RFC 6749 §4.1.2 / OAuth 2.1 §4.1.2 の失効は
    // "SHOULD revoke (when possible)" であり、resolver が失効手段を持たなくても
    // 再利用されたコード自体は MUST deny として invalid_grant で拒否する。
    it('should still reject a reused code when the resolver does not implement revokeTokensByGrantId', async () => {
      const error = await captureAsyncError(() =>
        validateAuthorizationCodeUnused(
          createAuthorizationCode({ used: true, grantId: 'grant-1' }),
          createAuthorizationCodeResolver(),
        ),
      );

      // optional メソッドの欠落で TypeError にならず、TokenError として拒否する
      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: TokenErrorCode.InvalidGrant,
        errorDescription: 'Authorization code has already been used',
      });
    });
  });
});

describe('validateAuthorizationCodeClient', () => {
  it('should reject authorization code issued to different client', () => {
    const error = captureError(() =>
      validateAuthorizationCodeClient(
        createAuthorizationCode({ clientId: 'other-client' }),
        'client-123',
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Authorization code was issued to a different client',
    });
  });
});

// currentTime を省略し、既定値（現在時刻の Unix epoch 秒）で判定させる。
describe('validateAuthorizationCodeExpiration', () => {
  it('should accept an authorization code that has not expired yet', () => {
    const now = nowInSeconds();

    expect(() =>
      validateAuthorizationCodeExpiration(
        createAuthorizationCode({ expiresAt: now + 600 }),
      ),
    ).not.toThrow();
  });

  it('should reject expired authorization code', () => {
    const now = nowInSeconds();

    const error = captureError(() =>
      validateAuthorizationCodeExpiration(
        createAuthorizationCode({ expiresAt: now - 100 }),
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Authorization code has expired',
    });
  });

  // RFC 7519 §4.1.4 (on-or-after): expiresAt === now is expired, identical to the
  // refresh-token boundary so both grants share one expiry convention.
  it('should reject an authorization code whose expiresAt equals now', () => {
    const now = nowInSeconds();

    const error = captureError(() =>
      validateAuthorizationCodeExpiration(
        createAuthorizationCode({ expiresAt: now }),
      ),
    );

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Authorization code has expired',
    });
  });
});

describe('validateAuthorizationCodeRedirectUri', () => {
  it('should reject when redirect_uri does not match original request', () => {
    const error = captureError(() =>
      validateAuthorizationCodeRedirectUri(
        createAuthorizationCode({ redirectUri: 'https://client.example.com/cb' }),
        'https://attacker.example.com/cb',
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'redirect_uri does not match the authorization request',
    });
  });

  it('should accept when redirect_uri is missing in token request', () => {
    expect(() =>
      validateAuthorizationCodeRedirectUri(
        createAuthorizationCode({ redirectUri: 'https://client.example.com/cb' }),
        undefined,
      ),
    ).not.toThrow();
  });

  it('should accept matching redirect_uri', () => {
    expect(() =>
      validateAuthorizationCodeRedirectUri(
        createAuthorizationCode({ redirectUri: 'https://client.example.com/cb' }),
        'https://client.example.com/cb',
      ),
    ).not.toThrow();
  });

  // OIDC Core 1.0 Section 3.1.3.2:
  // 認可リクエストに redirect_uri が含まれていた場合、Token リクエストでも MUST 一致。
  // 認可コード発行時に redirectUriExplicit=true を保持し、Token 側で必須化する。
  describe('OIDC Core 3.1.3.2 explicit redirect_uri binding', () => {
    it('should reject token request without redirect_uri when authorization request had explicit redirect_uri', () => {
      const error = captureError(() =>
        validateAuthorizationCodeRedirectUri(
          createAuthorizationCode({
            redirectUri: 'https://client.example.com/cb',
            redirectUriExplicit: true,
          }),
          undefined,
        ),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: TokenErrorCode.InvalidGrant,
        errorDescription:
          'redirect_uri is required because it was included in the authorization request',
      });
    });

    it('should accept token request with matching redirect_uri when authorization request had explicit redirect_uri', () => {
      expect(() =>
        validateAuthorizationCodeRedirectUri(
          createAuthorizationCode({
            redirectUri: 'https://client.example.com/cb',
            redirectUriExplicit: true,
          }),
          'https://client.example.com/cb',
        ),
      ).not.toThrow();
    });

    it('should accept token request without redirect_uri when authorization request omitted redirect_uri', () => {
      expect(() =>
        validateAuthorizationCodeRedirectUri(
          createAuthorizationCode({
            redirectUri: 'https://client.example.com/cb',
            redirectUriExplicit: false,
          }),
          undefined,
        ),
      ).not.toThrow();
    });
  });
});

describe('verifyAuthorizationCodePkce', () => {
  it('should reject missing code_verifier', async () => {
    const authorizationCode = await createPkceBoundAuthorizationCode(
      generateCodeVerifier(),
    );

    const error = await captureAsyncError(() =>
      verifyAuthorizationCodePkce(authorizationCode, undefined),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Missing required parameter: code_verifier',
    });
  });

  it('should reject invalid code_verifier (wrong value)', async () => {
    const authorizationCode = await createPkceBoundAuthorizationCode(
      generateCodeVerifier(),
    );

    // RFC 7636 §4.1 の形式（43〜128 文字の unreserved 文字）は満たし、値だけが異なる verifier
    const error = await captureAsyncError(() =>
      verifyAuthorizationCodePkce(
        authorizationCode,
        'wrong-code-verifier-that-does-not-match-the-challenge',
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'code_verifier validation failed',
    });
  });

  it('should accept valid code_verifier with S256 method', async () => {
    const codeVerifier = generateCodeVerifier();
    const authorizationCode = await createPkceBoundAuthorizationCode(codeVerifier);

    const result = await verifyAuthorizationCodePkce(authorizationCode, codeVerifier);

    expect(result).toBe(true);
  });

  it('should accept a missing code_verifier and return false when the authorization code has no PKCE binding', async () => {
    const result = await verifyAuthorizationCodePkce(
      createAuthorizationCode({
        codeChallenge: undefined,
        codeChallengeMethod: undefined,
      }),
      undefined,
    );

    expect(result).toBe(false);
  });

  // RFC 7636 Section 4.1: length and character validation
  it('should reject code_verifier shorter than 43 characters', async () => {
    const shortVerifier = 'A'.repeat(42);
    const authorizationCode = await createPkceBoundAuthorizationCode(shortVerifier);

    const error = await captureAsyncError(() =>
      verifyAuthorizationCodePkce(authorizationCode, shortVerifier),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'code_verifier length must be between 43 and 128 characters',
    });
  });

  it('should reject code_verifier longer than 128 characters', async () => {
    const longVerifier = 'A'.repeat(129);
    const authorizationCode = await createPkceBoundAuthorizationCode(longVerifier);

    const error = await captureAsyncError(() =>
      verifyAuthorizationCodePkce(authorizationCode, longVerifier),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'code_verifier length must be between 43 and 128 characters',
    });
  });

  it('should reject code_verifier containing invalid characters', async () => {
    // RFC 7636: only [A-Za-z0-9\-._~] are allowed; '+' is not a valid character
    const invalidVerifier = 'A'.repeat(42) + '+';
    const authorizationCode = await createPkceBoundAuthorizationCode(invalidVerifier);

    const error = await captureAsyncError(() =>
      verifyAuthorizationCodePkce(authorizationCode, invalidVerifier),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'code_verifier contains invalid characters',
    });
  });

  it('should accept code_verifier of exactly 43 characters', async () => {
    const verifier43 = 'A'.repeat(43);
    const authorizationCode = await createPkceBoundAuthorizationCode(verifier43);

    const result = await verifyAuthorizationCodePkce(authorizationCode, verifier43);

    expect(result).toBe(true);
  });

  it('should accept code_verifier of exactly 128 characters', async () => {
    const verifier128 = 'A'.repeat(128);
    const authorizationCode = await createPkceBoundAuthorizationCode(verifier128);

    const result = await verifyAuthorizationCodePkce(authorizationCode, verifier128);

    expect(result).toBe(true);
  });
});

describe('consumeAuthorizationCode', () => {
  it('should call revokeAuthorizationCode with the exchanged code', async () => {
    const consumedCodes: string[] = [];
    const resolver = createAuthorizationCodeResolver([createAuthorizationCode()], {
      revokeAuthorizationCode: async (code: string) => {
        consumedCodes.push(code);
      },
    });

    await consumeAuthorizationCode('valid-auth-code', resolver);

    expect(consumedCodes).toEqual(['valid-auth-code']);
  });

  // OAuth 2.1 §4.1.2 / RFC 9700 §4.13: revoke* must keep the record as used:true
  // (not physically delete) so a reused code/token still triggers the grant-wide
  // revocation cascade. This contract test exercises both a compliant (consume)
  // store and a non-compliant (delete) store through consumeAuthorizationCode and
  // the steps that see the code again on reuse (resolveAuthorizationCode, then
  // validateAuthorizationCodeUnused) to make the difference observable — the symptom
  // of a delete implementation is that revokeTokensByGrantId is never called on reuse.
  describe('revoke* contract: used-mark vs physical delete (reuse cascade)', () => {
    function createContractStore(mode: 'consume' | 'delete') {
      const store = new Map<string, AuthorizationCodeInfo>();
      store.set('code-1', createAuthorizationCode({ code: 'code-1', scope: ['openid'] }));

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

      return { authCodeResolver, store, revokedGrantIds };
    }

    // 再提示されたコードを引き直すときの Token Request
    const reuseParams: TokenRequestParams = {
      grant_type: 'authorization_code',
      code: 'code-1',
    };

    it('should keep the code as used:true after exchange when revoke consumes (not deletes)', async () => {
      const { authCodeResolver, store } = createContractStore('consume');

      await consumeAuthorizationCode('code-1', authCodeResolver);

      expect(store.get('code-1')).toMatchObject({ used: true });
    });

    it('should reject reuse with invalid_grant AND revoke the grant when revoke consumes', async () => {
      const { authCodeResolver, revokedGrantIds } = createContractStore('consume');
      await consumeAuthorizationCode('code-1', authCodeResolver);

      const { authorizationCode } = await resolveAuthorizationCode(
        reuseParams,
        authCodeResolver,
      );
      const error = await captureAsyncError(() =>
        validateAuthorizationCodeUnused(authorizationCode, authCodeResolver),
      );

      expect(error).toMatchObject({
        error: TokenErrorCode.InvalidGrant,
        errorDescription: 'Authorization code has already been used',
      });
      expect(revokedGrantIds).toEqual(['grant-1']);
    });

    // Contract violation made visible: a delete implementation rejects reuse as
    // not-found but never fires the cascade, so previously issued tokens survive.
    it('should reject reuse but FAIL to revoke the grant when revoke physically deletes', async () => {
      const { authCodeResolver, store, revokedGrantIds } = createContractStore('delete');
      await consumeAuthorizationCode('code-1', authCodeResolver);
      expect(store.get('code-1')).toBeUndefined();

      const error = await captureAsyncError(() =>
        resolveAuthorizationCode(reuseParams, authCodeResolver),
      );

      expect(error).toMatchObject({
        error: TokenErrorCode.InvalidGrant,
        errorDescription: 'Authorization code not found',
      });
      expect(revokedGrantIds).toEqual([]);
    });
  });
});

describe('buildValidatedAuthorizationCodeRequest', () => {
  it('should return validated token request with all fields', () => {
    const result = buildValidatedAuthorizationCodeRequest(
      'valid-auth-code',
      createAuthorizationCode({
        scope: ['openid', 'profile', 'email'],
        nonce: 'test-nonce',
      }),
      'client-123',
      true,
    );

    expect(result).toEqual({
      grantType: 'authorization_code',
      clientId: 'client-123',
      code: 'valid-auth-code',
      grantId: 'grant-1',
      redirectUri: 'https://client.example.com/cb',
      scope: ['openid', 'profile', 'email'],
      nonce: 'test-nonce',
      audience: undefined,
      acrValues: undefined,
      claims: undefined,
      sessionId: undefined,
      codeVerified: true,
    });
  });

  it('should carry codeVerified false for an authorization code without PKCE binding', () => {
    // verifyAuthorizationCodePkce は PKCE 束縛の無いコードに対して false を返す
    const result = buildValidatedAuthorizationCodeRequest(
      'valid-auth-code',
      createAuthorizationCode(),
      'client-123',
      false,
    );

    expect(result).toMatchObject({
      grantType: 'authorization_code',
      clientId: 'client-123',
      code: 'valid-auth-code',
      codeVerified: false,
    });
  });

  it('should include audience from authorization code when provided', () => {
    const result = buildValidatedAuthorizationCodeRequest(
      'valid-auth-code',
      createAuthorizationCode({
        audience: ['https://api.example.com', 'https://other.example.com'],
      }),
      'client-123',
      true,
    );

    expect(result.audience).toEqual([
      'https://api.example.com',
      'https://other.example.com',
    ]);
  });

  it('should return undefined audience when not in authorization code', () => {
    const result = buildValidatedAuthorizationCodeRequest(
      'valid-auth-code',
      createAuthorizationCode(),
      'client-123',
      true,
    );

    expect(result.audience).toBeUndefined();
  });

  // OIDC Core 1.0 §3.1.2.1: acr_values requested at authorization is carried on the
  // authorization code and must be returned so the token endpoint can pass it to the
  // AcrResolver as requestedAcrValues.
  it('should include acrValues from authorization code when provided', () => {
    const result = buildValidatedAuthorizationCodeRequest(
      'valid-auth-code',
      createAuthorizationCode({ acrValues: 'loa2 loa3' }),
      'client-123',
      true,
    );

    expect(result).toMatchObject({
      grantType: 'authorization_code',
      acrValues: 'loa2 loa3',
    });
  });

  it('should return undefined acrValues when not in authorization code', () => {
    const result = buildValidatedAuthorizationCodeRequest(
      'valid-auth-code',
      createAuthorizationCode(),
      'client-123',
      true,
    );

    expect(result).toMatchObject({
      grantType: 'authorization_code',
      acrValues: undefined,
    });
  });
});

describe('resolveRefreshToken', () => {
  it('should reject missing refresh_token parameter', async () => {
    const error = await captureAsyncError(() =>
      resolveRefreshToken(
        { grant_type: 'refresh_token' },
        createRefreshTokenResolver({ 'valid-refresh-token': createRefreshTokenInfo() }),
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidRequest,
      errorDescription: 'Missing required parameter: refresh_token',
    });
  });

  it('should reject when refreshTokenResolver is not provided', async () => {
    const error = await captureAsyncError(() =>
      resolveRefreshToken(
        { grant_type: 'refresh_token', refresh_token: 'valid-refresh-token' },
        undefined,
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidRequest,
      errorDescription: 'Refresh token resolver not provided',
    });
  });

  it('should reject when refresh token is not found', async () => {
    const error = await captureAsyncError(() =>
      resolveRefreshToken(
        { grant_type: 'refresh_token', refresh_token: 'not-existing-token' },
        createRefreshTokenResolver({ 'valid-refresh-token': createRefreshTokenInfo() }),
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Refresh token not found',
    });
  });
});

describe('validateRefreshTokenUnused', () => {
  it('should reject when refresh token has already been used', async () => {
    const error = await captureAsyncError(() =>
      validateRefreshTokenUnused(
        createRefreshTokenInfo({ used: true }),
        createRefreshTokenResolver(),
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Refresh token has already been used',
    });
  });

  // OAuth 2.1 Section 4.3.1 のローテーションは、新トークン保存成功後に呼び出し側が
  // 旧 RT を失効する責務を負う。使用済み判定のステップは未使用の RT を失効しない。
  it('should not revoke an unused refresh token (rotation handled by caller)', async () => {
    const revokedTokens: string[] = [];
    const revokedGrantIds: string[] = [];
    const resolver = createRefreshTokenResolver({}, {
      revokeRefreshToken: async (token: string) => {
        revokedTokens.push(token);
      },
      revokeTokensByGrantId: async (grantId: string) => {
        revokedGrantIds.push(grantId);
      },
    });

    await expect(
      validateRefreshTokenUnused(createRefreshTokenInfo(), resolver),
    ).resolves.toBeUndefined();

    expect(revokedTokens).toEqual([]);
    expect(revokedGrantIds).toEqual([]);
  });

  // T-003: refresh token 再利用検知時は同 grant の AT/RT を全失効する
  // (OAuth 2.1 Section 4.3.1 SHOULD)
  describe('Refresh token reuse cascade revocation', () => {
    it('should call revokeTokensByGrantId when used refresh token is detected', async () => {
      const revokedGrantIds: string[] = [];
      const resolver = createRefreshTokenResolver({}, {
        revokeTokensByGrantId: async (grantId: string) => {
          revokedGrantIds.push(grantId);
        },
      });

      const error = await captureAsyncError(() =>
        validateRefreshTokenUnused(
          createRefreshTokenInfo({ used: true, grantId: 'grant-compromised' }),
          resolver,
        ),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(revokedGrantIds).toEqual(['grant-compromised']);
    });

    it('should still throw invalid_grant when revokeTokensByGrantId is not provided', async () => {
      // revokeTokensByGrantId は optional なので未提供でも例外を投げる
      const error = await captureAsyncError(() =>
        validateRefreshTokenUnused(
          createRefreshTokenInfo({ used: true }),
          createRefreshTokenResolver(),
        ),
      );

      expect(error).toMatchObject({
        error: TokenErrorCode.InvalidGrant,
        errorDescription: 'Refresh token has already been used',
      });
    });
  });
});

describe('validateRefreshTokenClient', () => {
  it('should accept a refresh token issued to the authenticated client', () => {
    expect(() =>
      validateRefreshTokenClient(createRefreshTokenInfo(), 'client-123'),
    ).not.toThrow();
  });

  it('should reject when refresh token was issued to a different client', () => {
    const error = captureError(() =>
      validateRefreshTokenClient(
        createRefreshTokenInfo({ clientId: 'other-client' }),
        'client-123',
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Refresh token was issued to a different client',
    });
  });

  // RFC 6749 §3.2.1: public clients have no client_secret. The refresh token is still
  // bound to the client_id that client authentication (the `none` method) produced.
  describe('public client', () => {
    // RFC 6749 §6: the refresh token MUST be bound to the public client it was issued to.
    it('should reject refresh token bound to a different public client', () => {
      const error = captureError(() =>
        validateRefreshTokenClient(
          createRefreshTokenInfo({ clientId: 'other-public-client' }),
          'client-123',
        ),
      );

      expect(error).toMatchObject({
        error: TokenErrorCode.InvalidGrant,
        errorDescription: 'Refresh token was issued to a different client',
      });
    });
  });
});

// currentTime を省略し、既定値（現在時刻の Unix epoch 秒）で判定させる。
describe('validateRefreshTokenExpiration', () => {
  it('should accept a refresh token that has not expired yet', () => {
    const now = nowInSeconds();

    expect(() =>
      validateRefreshTokenExpiration(
        createRefreshTokenInfo({ expiresAt: now + 3600 }),
      ),
    ).not.toThrow();
  });

  it('should reject when refresh token has expired', () => {
    const now = nowInSeconds();

    const error = captureError(() =>
      validateRefreshTokenExpiration(
        createRefreshTokenInfo({ expiresAt: now - 100 }),
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Refresh token has expired',
    });
  });

  // RFC 7519 §4.1.4 (on-or-after): expiresAt === now must be treated as expired,
  // matching the authorization-code boundary (no <-vs-<= mismatch between grants).
  it('should reject a refresh token whose expiresAt equals now', () => {
    const now = nowInSeconds();

    const error = captureError(() =>
      validateRefreshTokenExpiration(createRefreshTokenInfo({ expiresAt: now })),
    );

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Refresh token has expired',
    });
  });
});

// Opt-in refresh token idle (inactivity) timeout. Default OFF. RFC 9700 §4.14.2
// recommends limiting refresh token exposure (rotation + limited lifetime); the
// idle-timeout mechanism itself is a common IdP feature (e.g. Auth0 inactivity
// lifetime) that operationalizes that guidance, not a claim mandated by the RFC.
// currentTime を省略し、既定値（現在時刻の Unix epoch 秒）で判定させる。
describe('validateRefreshTokenIdleTimeout', () => {
  it('should not expire an idle refresh token when no timeout is configured', () => {
    const now = nowInSeconds();

    expect(() =>
      validateRefreshTokenIdleTimeout(
        createRefreshTokenInfo({ lastUsedAt: now - 100000 }),
        undefined,
      ),
    ).not.toThrow();
  });

  it('should reject when now - lastUsedAt exceeds the idle timeout', () => {
    const now = nowInSeconds();

    const error = captureError(() =>
      validateRefreshTokenIdleTimeout(
        createRefreshTokenInfo({ lastUsedAt: now - 1000 }),
        600,
      ),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Refresh token expired due to inactivity',
    });
  });

  it('should accept when now - lastUsedAt is within the idle timeout', () => {
    const now = nowInSeconds();

    expect(() =>
      validateRefreshTokenIdleTimeout(
        createRefreshTokenInfo({ lastUsedAt: now - 100 }),
        600,
      ),
    ).not.toThrow();
  });

  it('should skip the idle check when lastUsedAt is not stored even if a timeout is set', () => {
    expect(() =>
      validateRefreshTokenIdleTimeout(
        createRefreshTokenInfo({ lastUsedAt: undefined }),
        600,
      ),
    ).not.toThrow();
  });
});

// RFC 6749 §6: 要求 scope は元の grant に含まれない scope を含んではならず、
// 省略時は元の grant と同じ scope として扱う。超過は RFC 6749 §5.2 の invalid_scope。
describe('validateRefreshTokenScope', () => {
  it('should return scope from refresh token info when scope is not requested', () => {
    const result = validateRefreshTokenScope(undefined, ['openid', 'email']);

    expect(result).toEqual(['openid', 'email']);
  });

  it('should return requested scope when it is a subset of original scope', () => {
    const result = validateRefreshTokenScope('openid profile', [
      'openid',
      'profile',
      'email',
    ]);

    expect(result).toEqual(['openid', 'profile']);
  });

  it('should return original scope when requested scope is identical', () => {
    const result = validateRefreshTokenScope('openid profile', ['openid', 'profile']);

    expect(result).toEqual(['openid', 'profile']);
  });

  it('should handle scope with extra spaces and duplicates', () => {
    const result = validateRefreshTokenScope('  openid   profile  openid  ', [
      'openid',
      'profile',
      'email',
    ]);

    expect(result).toEqual(['openid', 'profile']);
  });

  it('should reject when requested scope includes scopes not in original grant', () => {
    const error = captureError(() =>
      validateRefreshTokenScope('openid profile admin', ['openid', 'profile']),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidScope,
      errorDescription: 'Requested scope exceeds original grant: admin',
    });
  });

  it('should reject when requested scope is entirely different from original grant', () => {
    const error = captureError(() =>
      validateRefreshTokenScope('admin write', ['openid', 'profile']),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidScope,
      errorDescription: 'Requested scope exceeds original grant: admin write',
    });
  });

  it('should reject when scope is empty string', () => {
    const error = captureError(() =>
      validateRefreshTokenScope('', ['openid', 'profile']),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidScope,
      errorDescription: 'Requested scope must not be empty',
    });
  });

  it('should reject when scope is only whitespace', () => {
    const error = captureError(() =>
      validateRefreshTokenScope('   ', ['openid', 'profile']),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidScope,
      errorDescription: 'Requested scope must not be empty',
    });
  });
});

describe('buildValidatedRefreshTokenRequest', () => {
  it('should return the validated refresh_token request', () => {
    const result = buildValidatedRefreshTokenRequest(
      createRefreshTokenInfo(),
      'client-123',
      ['openid', 'profile'],
    );

    expect(result).toEqual({
      grantType: 'refresh_token',
      clientId: 'client-123',
      subject: 'user-123',
      scope: ['openid', 'profile'],
      grantId: 'grant-rt-001',
      audience: undefined,
      authTime: 1_699_990_000,
      nonce: undefined,
      acr: undefined,
      amr: undefined,
      azp: undefined,
      originalIssuedAt: 1_699_990_000,
      hadOfflineAccess: false,
      sessionId: undefined,
    });
  });

  it('should return grantType refresh_token', () => {
    const info = createRefreshTokenInfo();

    const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

    expect(result.grantType).toBe('refresh_token');
  });

  it('should return clientId', () => {
    const info = createRefreshTokenInfo();

    const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

    expect(result.clientId).toBe('client-123');
  });

  it('should return subject from refresh token info', () => {
    const info = createRefreshTokenInfo({ subject: 'user-xyz' });

    const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

    expect(result.subject).toBe('user-xyz');
  });

  it('should propagate grantId from refresh token info', () => {
    const info = createRefreshTokenInfo({ grantId: 'grant-propagated' });

    const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

    expect(result.grantId).toBe('grant-propagated');
  });

  // T-002: 元アクセストークンの audience を新 AT に引き継ぐ
  it('should propagate audience from refresh token info', () => {
    const info = createRefreshTokenInfo({ audience: ['https://api.example.com'] });

    const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

    expect(result.audience).toEqual(['https://api.example.com']);
  });

  it('should leave audience undefined when refresh token info has no audience', () => {
    const info = createRefreshTokenInfo();

    const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

    expect(result.audience).toBeUndefined();
  });

  // T-005: OIDC Core 1.0 §12.1 — refresh で再発行する ID Token は初回認証時と同じ
  // auth_time / nonce / acr / amr / azp を保持しなければならない。
  describe('OIDC Core 1.0 §12.1 ID Token claim preservation', () => {
    it('should propagate authTime from refresh token info', () => {
      const info = createRefreshTokenInfo({ authTime: 1_700_000_000 });

      const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

      expect(result.authTime).toBe(1_700_000_000);
    });

    it('should propagate nonce from refresh token info', () => {
      const info = createRefreshTokenInfo({ nonce: 'original-nonce' });

      const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

      expect(result.nonce).toBe('original-nonce');
    });

    it('should propagate acr from refresh token info', () => {
      const info = createRefreshTokenInfo({ acr: 'urn:mace:incommon:iap:silver' });

      const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

      expect(result.acr).toBe('urn:mace:incommon:iap:silver');
    });

    it('should propagate amr from refresh token info', () => {
      const info = createRefreshTokenInfo({ amr: ['pwd', 'mfa'] });

      const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

      expect(result.amr).toEqual(['pwd', 'mfa']);
    });

    it('should propagate azp from refresh token info', () => {
      const info = createRefreshTokenInfo({ azp: 'client-123' });

      const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

      expect(result.azp).toBe('client-123');
    });
  });

  // RFC 6749 §6: refresh 時の scope 縮小は当該リクエストの access token / ID Token の
  // 権限縮小として扱い、refresh token rotation の可否とは切り離す。rotation 可否は
  // 「元の grant が offline_access を持っていたか」で判断するため、その情報を hadOfflineAccess
  // として伝播させる。
  describe('Refresh token rotation eligibility (hadOfflineAccess)', () => {
    it('should set hadOfflineAccess to true when original refresh token scope includes offline_access', () => {
      const info = createRefreshTokenInfo({ scope: ['openid', 'offline_access'] });

      const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

      expect(result).toMatchObject({ grantType: 'refresh_token', hadOfflineAccess: true });
    });

    it('should set hadOfflineAccess to false when original refresh token scope lacks offline_access', () => {
      const info = createRefreshTokenInfo({ scope: ['openid', 'profile'] });

      const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

      expect(result).toMatchObject({ grantType: 'refresh_token', hadOfflineAccess: false });
    });

    // 縮小後 scope から offline_access を落としても、元 grant が持っていたかどうかは
    // 元 refresh token の scope で判断するため hadOfflineAccess は true を維持する。
    it('should keep hadOfflineAccess true even when requested scope drops offline_access', () => {
      // effectiveScope には、要求 scope 'openid email' に対して validateRefreshTokenScope が
      // 返す縮小後 scope を渡す。
      const result = buildValidatedRefreshTokenRequest(
        createRefreshTokenInfo({ scope: ['openid', 'email', 'offline_access'] }),
        'client-123',
        ['openid', 'email'],
      );

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
    it('should propagate originalIssuedAt from refresh token info', () => {
      const info = createRefreshTokenInfo({ originalIssuedAt: 1_700_000_000 });

      const result = buildValidatedRefreshTokenRequest(info, 'client-123', info.scope);

      expect(result.originalIssuedAt).toBe(1_700_000_000);
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
