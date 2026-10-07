/**
 * トークンリクエスト検証の機能単位ステップ関数のテスト。
 *
 * CLI 生成コードはこれらのステップを個別に呼び出して、利用者が検証処理を
 * 消したり足したりできるようにする。ステップごとの網羅的な振る舞いは
 * token-request.test.ts が担保し、本ファイルは token-request.test.ts が
 * 扱わないステップ関数のケースと、ステップを構成する部品関数の入出力を固定する。
 */
import { describe, it, expect } from 'vitest';
import { validateGrantTypeSupported } from './token-request.js';
import {
  buildValidatedAuthorizationCodeRequest,
  consumeAuthorizationCode,
  validateAuthorizationCodeClient,
  validateAuthorizationCodeExpiration,
  validateAuthorizationCodeRedirectUri,
  validateAuthorizationCodeUnused,
  requireAuthorizationCode,
  requireStoredAuthorizationCode,
  validateAuthorizationCodeNotUsed,
  requireTokenRequestRedirectUri,
  validateAuthorizationCodeRedirectUriMatch,
  hasPkceBinding,
  requirePkceBinding,
  requireCodeVerifier,
  validateCodeVerifier,
  verifyCodeChallenge,
  verifyPkceCodeVerifier,
} from './authorization-code-grant.js';
import {
  buildValidatedRefreshTokenRequest,
  resolveRefreshToken,
  validateRefreshTokenExpiration,
  validateRefreshTokenIdleTimeout,
  validateRefreshTokenSession,
  validateRefreshTokenUnused,
  requireRefreshToken,
  requireStoredRefreshToken,
  validateRefreshTokenNotUsed,
  requireRefreshTokenSession,
  validateRefreshTokenSessionSubject,
  validateRefreshTokenScopeNotEmpty,
  validateRefreshTokenScopeWithinGrant,
} from './refresh-token-grant.js';
import { TokenError, TokenErrorCode } from './token-error.js';
import type {
  AuthenticationSessionInfo,
  AuthenticationSessionResolver,
} from './authentication-session.js';
import type {
  AuthorizationCodeInfo,
  AuthorizationCodeResolver,
  RefreshTokenInfo,
  RefreshTokenResolver,
} from './token-request.js';

const defaultAuthorizationCode: AuthorizationCodeInfo = {
  code: 'authorization-code',
  grantId: 'grant-123',
  clientId: 'client123',
  redirectUri: 'https://client.example.org/cb',
  redirectUriExplicit: true,
  scope: ['openid', 'profile'],
  codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  codeChallengeMethod: 'S256',
  expiresAt: 1_700_000_100,
  used: false,
  nonce: 'nonce-123',
  audience: ['https://api.example.org'],
  acrValues: 'urn:example:loa:2',
  claims: { id_token: { acr: { essential: true } } },
};

const defaultRefreshToken: RefreshTokenInfo = {
  subject: 'subject-123',
  clientId: 'client123',
  scope: ['openid', 'profile', 'offline_access'],
  expiresAt: 1_700_000_100,
  used: false,
  grantId: 'grant-123',
  originalIssuedAt: 1_699_000_000,
  lastUsedAt: 1_699_999_900,
  audience: ['https://api.example.org'],
  authTime: 1_699_999_000,
  nonce: 'nonce-123',
  acr: 'urn:example:loa:2',
  amr: ['pwd', 'otp'],
  azp: 'client123',
};

// Helper: capture the TokenError thrown by a sync step (undefined if none)
function captureError(fn: () => unknown): TokenError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as TokenError;
  }
}

describe('validateGrantTypeSupported', () => {
  it('should return refresh_token for grant_type=refresh_token', () => {
    const result = validateGrantTypeSupported('refresh_token');

    expect(result).toBe('refresh_token');
  });
});

describe('validateAuthorizationCodeUnused', () => {
  it('should pass without revoking a grant when the authorization code is unused', async () => {
    let revokedGrantId: string | undefined;
    const resolver: AuthorizationCodeResolver = {
      findAuthorizationCode: async () => defaultAuthorizationCode,
      revokeAuthorizationCode: async () => {},
      revokeTokensByGrantId: async (grantId) => {
        revokedGrantId = grantId;
      },
    };

    await validateAuthorizationCodeUnused(defaultAuthorizationCode, resolver);

    expect(revokedGrantId).toBe(undefined);
  });

  it('should revoke the grant and reject a reused authorization code', async () => {
    let revokedGrantId: string | undefined;
    const resolver: AuthorizationCodeResolver = {
      findAuthorizationCode: async () => defaultAuthorizationCode,
      revokeAuthorizationCode: async () => {},
      revokeTokensByGrantId: async (grantId) => {
        revokedGrantId = grantId;
      },
    };

    const error = await validateAuthorizationCodeUnused(
      { ...defaultAuthorizationCode, used: true },
      resolver
    ).catch((e: unknown) => e);

    expect(revokedGrantId).toBe('grant-123');
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Authorization code has already been used',
    });
  });
});

describe('validateAuthorizationCodeClient', () => {
  it('should pass when the authorization code belongs to the authenticated client', () => {
    const error = captureError(() =>
      validateAuthorizationCodeClient(defaultAuthorizationCode, 'client123')
    );

    expect(error).toBe(undefined);
  });
});

describe('validateAuthorizationCodeExpiration', () => {
  it('should pass when the authorization code expires after the current time', () => {
    const error = captureError(() =>
      validateAuthorizationCodeExpiration(defaultAuthorizationCode, 1_700_000_099)
    );

    expect(error).toBe(undefined);
  });

  it('should reject when expiresAt equals the current time', () => {
    const error = captureError(() =>
      validateAuthorizationCodeExpiration(defaultAuthorizationCode, 1_700_000_100)
    );

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Authorization code has expired',
    });
  });
});

describe('validateAuthorizationCodeRedirectUri', () => {
  it('should reject a mismatched redirect_uri', () => {
    const error = captureError(() =>
      validateAuthorizationCodeRedirectUri(
        defaultAuthorizationCode,
        'https://client.example.org/other'
      )
    );

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'redirect_uri does not match the authorization request',
    });
  });
});

describe('buildValidatedAuthorizationCodeRequest', () => {
  it('should build the validated authorization code request from step results', () => {
    const result = buildValidatedAuthorizationCodeRequest(
      'authorization-code',
      defaultAuthorizationCode,
      'client123',
      true
    );

    expect(result).toEqual({
      grantType: 'authorization_code',
      clientId: 'client123',
      code: 'authorization-code',
      grantId: 'grant-123',
      redirectUri: 'https://client.example.org/cb',
      scope: ['openid', 'profile'],
      nonce: 'nonce-123',
      audience: ['https://api.example.org'],
      acrValues: 'urn:example:loa:2',
      claims: { id_token: { acr: { essential: true } } },
      sessionId: undefined,
      codeVerified: true,
    });
  });

  it('should carry the authorization sessionId so the token endpoint can bind an online refresh token', () => {
    const result = buildValidatedAuthorizationCodeRequest(
      'authorization-code',
      { ...defaultAuthorizationCode, sessionId: 'session-abc' },
      'client123',
      true
    );

    expect(result).toMatchObject({
      grantType: 'authorization_code',
      sessionId: 'session-abc',
    });
  });
});

describe('resolveRefreshToken', () => {
  it('should return the token value and resolved refresh token', async () => {
    const resolver: RefreshTokenResolver = {
      resolve: async (token) =>
        token === 'refresh-token' ? defaultRefreshToken : null,
      revokeRefreshToken: async () => {},
    };

    const result = await resolveRefreshToken(
      { grant_type: 'refresh_token', refresh_token: 'refresh-token' },
      resolver
    );

    expect(result).toEqual({
      refreshToken: 'refresh-token',
      refreshTokenInfo: defaultRefreshToken,
    });
  });
});

describe('validateRefreshTokenUnused', () => {
  it('should revoke the grant and reject a reused refresh token', async () => {
    let revokedGrantId: string | undefined;
    const resolver: RefreshTokenResolver = {
      resolve: async () => defaultRefreshToken,
      revokeRefreshToken: async () => {},
      revokeTokensByGrantId: async (grantId) => {
        revokedGrantId = grantId;
      },
    };

    const error = await validateRefreshTokenUnused(
      { ...defaultRefreshToken, used: true },
      resolver
    ).catch((e: unknown) => e);

    expect(revokedGrantId).toBe('grant-123');
    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Refresh token has already been used',
    });
  });
});

describe('validateRefreshTokenExpiration', () => {
  it('should reject when expiresAt equals the current time', () => {
    const error = captureError(() =>
      validateRefreshTokenExpiration(defaultRefreshToken, 1_700_000_100)
    );

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Refresh token has expired',
    });
  });
});

describe('validateRefreshTokenIdleTimeout', () => {
  it('should reject when inactivity exceeds the configured timeout', () => {
    const error = captureError(() =>
      validateRefreshTokenIdleTimeout(defaultRefreshToken, 60, 1_700_000_000)
    );

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Refresh token expired due to inactivity',
    });
  });

  it('should pass when no idle timeout is configured', () => {
    const error = captureError(() =>
      validateRefreshTokenIdleTimeout(defaultRefreshToken, undefined, 1_700_000_000)
    );

    expect(error).toBe(undefined);
  });
});

// OIDC Core 1.0 §11: offline_access は「End-User が居なくても（not logged in）」使える
// Refresh Token を要求する scope。§11 末尾が明示するとおり Refresh Token の利用は
// offline_access 専用ではなく、AS は他の文脈でも発行してよい（MAY grant Refresh Tokens
// in other contexts）。本実装はその「他の文脈」を online refresh token として扱い、
// 発行元の認証セッションへ束縛する。セッションが終われば RT も使えなくなる。
describe('validateRefreshTokenSession', () => {
  // offline_access なし = online refresh token。sessionId で認証セッションへ束縛する。
  const onlineRefreshToken: RefreshTokenInfo = {
    ...defaultRefreshToken,
    scope: ['openid', 'profile'],
    sessionId: 'session-abc',
  };

  // offline_access あり = offline refresh token。sessionId を持たない。
  const offlineRefreshToken: RefreshTokenInfo = {
    ...defaultRefreshToken,
    sessionId: undefined,
  };

  function createSessionResolver(
    sessions: Record<string, AuthenticationSessionInfo>,
  ): AuthenticationSessionResolver {
    return {
      findSession: async (sessionId: string) => sessions[sessionId] ?? null,
    };
  }

  it('should accept an offline refresh token without consulting the session resolver', async () => {
    let lookups = 0;
    const resolver: AuthenticationSessionResolver = {
      findSession: async () => {
        lookups += 1;
        return null;
      },
    };

    await validateRefreshTokenSession(offlineRefreshToken, resolver);

    expect(lookups).toBe(0);
  });

  it('should accept an offline refresh token when no session resolver is configured', async () => {
    const error = await validateRefreshTokenSession(offlineRefreshToken, undefined)
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBe(undefined);
  });

  it('should accept an online refresh token while its authentication session is alive', async () => {
    const resolver = createSessionResolver({
      'session-abc': { subject: 'subject-123', authTime: 1_699_999_000 },
    });

    const error = await validateRefreshTokenSession(onlineRefreshToken, resolver)
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBe(undefined);
  });

  it('should reject an online refresh token after its authentication session ended', async () => {
    const resolver = createSessionResolver({});

    const error = await validateRefreshTokenSession(onlineRefreshToken, resolver)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'The authentication session bound to this refresh token has ended',
    });
  });

  it('should reject an online refresh token when the session now belongs to another subject', async () => {
    const resolver = createSessionResolver({
      'session-abc': { subject: 'other-subject', authTime: 1_699_999_000 },
    });

    const error = await validateRefreshTokenSession(onlineRefreshToken, resolver)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'The authentication session bound to this refresh token belongs to another subject',
    });
  });

  it('should reject an online refresh token when no session resolver is configured', async () => {
    // fail-closed: セッションを確認できないなら、束縛が生きている保証が無い。
    const error = await validateRefreshTokenSession(onlineRefreshToken, undefined)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Authentication session resolver not provided',
    });
  });
});

describe('buildValidatedRefreshTokenRequest', () => {
  it('should build the validated refresh token request from step results', () => {
    const result = buildValidatedRefreshTokenRequest(
      defaultRefreshToken,
      'client123',
      ['openid', 'profile']
    );

    expect(result).toEqual({
      grantType: 'refresh_token',
      clientId: 'client123',
      subject: 'subject-123',
      scope: ['openid', 'profile'],
      grantId: 'grant-123',
      audience: ['https://api.example.org'],
      authTime: 1_699_999_000,
      nonce: 'nonce-123',
      acr: 'urn:example:loa:2',
      amr: ['pwd', 'otp'],
      azp: 'client123',
      originalIssuedAt: 1_699_000_000,
      hadOfflineAccess: true,
      sessionId: undefined,
    });
  });

  it('should carry the bound sessionId so rotation keeps the online refresh token session-bound', () => {
    const result = buildValidatedRefreshTokenRequest(
      { ...defaultRefreshToken, scope: ['openid'], sessionId: 'session-abc' },
      'client123',
      ['openid']
    );

    expect(result).toMatchObject({
      grantType: 'refresh_token',
      sessionId: 'session-abc',
      hadOfflineAccess: false,
    });
  });
});

describe('requireAuthorizationCode', () => {
  it('should return the code', () => {
    expect(requireAuthorizationCode('authorization-code')).toBe('authorization-code');
  });

  it('should reject a missing code with invalid_request', () => {
    expect(() => requireAuthorizationCode(undefined)).toThrow(
      expect.objectContaining({
        error: 'invalid_request',
        errorDescription: 'Missing required parameter: code',
      }),
    );
  });
});

describe('requireStoredAuthorizationCode', () => {
  it('should return the stored record', () => {
    expect(requireStoredAuthorizationCode({ clientId: 'client-1' })).toEqual({
      clientId: 'client-1',
    });
  });

  it('should reject a code that the store did not find', () => {
    expect(() => requireStoredAuthorizationCode(null)).toThrow(
      expect.objectContaining({
        error: 'invalid_grant',
        errorDescription: 'Authorization code not found',
      }),
    );
  });
});

describe('validateAuthorizationCodeNotUsed', () => {
  it('should accept an unused code', () => {
    expect(validateAuthorizationCodeNotUsed(false)).toBeUndefined();
  });

  it('should reject a used code', () => {
    expect(() => validateAuthorizationCodeNotUsed(true)).toThrow(
      'Authorization code has already been used',
    );
  });
});

describe('validateAuthorizationCodeUnused with a minimal resolver', () => {
  it('should revoke the grant before rejecting reuse', async () => {
    const revoked: string[] = [];
    await expect(
      validateAuthorizationCodeUnused(
        { used: true, grantId: 'grant-1' },
        {
          async revokeTokensByGrantId(grantId: string) {
            revoked.push(grantId);
          },
        },
      ),
    ).rejects.toThrow('Authorization code has already been used');
    expect(revoked).toEqual(['grant-1']);
  });
});

describe('consumeAuthorizationCode with a minimal resolver', () => {
  it('should call revokeAuthorizationCode with the code', async () => {
    const revoked: string[] = [];
    await consumeAuthorizationCode('authorization-code', {
      async revokeAuthorizationCode(code: string) {
        revoked.push(code);
      },
    });
    expect(revoked).toEqual(['authorization-code']);
  });
});

describe('requireTokenRequestRedirectUri', () => {
  it('should return the redirect_uri', () => {
    expect(requireTokenRequestRedirectUri('https://client.example/cb')).toBe(
      'https://client.example/cb',
    );
  });

  // OIDC Core 1.0 §3.1.3.2: required when the authorization request included it
  it('should reject a missing redirect_uri', () => {
    expect(() => requireTokenRequestRedirectUri(undefined)).toThrow(
      expect.objectContaining({
        error: 'invalid_grant',
        errorDescription:
          'redirect_uri is required because it was included in the authorization request',
      }),
    );
  });
});

describe('validateAuthorizationCodeRedirectUriMatch', () => {
  it('should accept an identical redirect_uri', () => {
    expect(
      validateAuthorizationCodeRedirectUriMatch(
        'https://client.example/cb',
        'https://client.example/cb',
      ),
    ).toBeUndefined();
  });

  it('should accept an omitted redirect_uri', () => {
    expect(
      validateAuthorizationCodeRedirectUriMatch(undefined, 'https://client.example/cb'),
    ).toBeUndefined();
  });

  it('should reject a different redirect_uri', () => {
    expect(() =>
      validateAuthorizationCodeRedirectUriMatch(
        'https://client.example/other',
        'https://client.example/cb',
      ),
    ).toThrow(
      expect.objectContaining({
        error: 'invalid_grant',
        errorDescription: 'redirect_uri does not match the authorization request',
      }),
    );
  });
});

describe('hasPkceBinding', () => {
  it('should return true when a code_challenge is stored', () => {
    expect(hasPkceBinding('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'S256')).toBe(true);
  });

  it('should return true when only the method is stored', () => {
    expect(hasPkceBinding(undefined, 'S256')).toBe(true);
  });

  it('should return false when neither value is stored', () => {
    expect(hasPkceBinding(undefined, undefined)).toBe(false);
  });
});

describe('requirePkceBinding', () => {
  it('should return the stored challenge and method', () => {
    expect(
      requirePkceBinding('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'S256'),
    ).toEqual({
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
    });
  });

  it('should reject a binding without a method', () => {
    expect(() =>
      requirePkceBinding('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', undefined),
    ).toThrow('Authorization code PKCE binding is incomplete');
  });

  it('should reject a binding without a challenge', () => {
    expect(() => requirePkceBinding(undefined, 'S256')).toThrow(
      'Authorization code PKCE binding is incomplete',
    );
  });
});

describe('requireCodeVerifier', () => {
  it('should return the code_verifier', () => {
    expect(requireCodeVerifier('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    );
  });

  it('should reject a missing code_verifier with invalid_grant', () => {
    expect(() => requireCodeVerifier(undefined)).toThrow(
      expect.objectContaining({
        error: 'invalid_grant',
        errorDescription: 'Missing required parameter: code_verifier',
      }),
    );
  });
});

describe('validateCodeVerifier', () => {
  // RFC 7636 §4.1: code-verifier = 43*128unreserved
  it('should accept 43 characters', () => {
    expect(validateCodeVerifier('a'.repeat(43))).toBeUndefined();
  });

  it('should accept 128 characters', () => {
    expect(validateCodeVerifier('a'.repeat(128))).toBeUndefined();
  });

  it('should reject 42 characters', () => {
    expect(() => validateCodeVerifier('a'.repeat(42))).toThrow(
      'code_verifier length must be between 43 and 128 characters',
    );
  });

  it('should reject 129 characters', () => {
    expect(() => validateCodeVerifier('a'.repeat(129))).toThrow(
      'code_verifier length must be between 43 and 128 characters',
    );
  });

  it('should reject characters outside unreserved', () => {
    expect(() => validateCodeVerifier('!'.repeat(43))).toThrow(
      'code_verifier contains invalid characters',
    );
  });
});

describe('verifyCodeChallenge', () => {
  // RFC 7636 Appendix B test vector
  it('should return true for the matching verifier', async () => {
    expect(
      await verifyCodeChallenge(
        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        'S256',
      ),
    ).toBe(true);
  });

  it('should return false for a different verifier', async () => {
    expect(
      await verifyCodeChallenge(
        'a'.repeat(43),
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        'S256',
      ),
    ).toBe(false);
  });
});

describe('verifyPkceCodeVerifier', () => {
  // RFC 7636 Appendix B test vector
  it('should accept the matching verifier', async () => {
    await expect(
      verifyPkceCodeVerifier(
        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        'S256',
      ),
    ).resolves.toBeUndefined();
  });

  it('should reject a different verifier with invalid_grant', async () => {
    await expect(
      verifyPkceCodeVerifier(
        'a'.repeat(43),
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        'S256',
      ),
    ).rejects.toThrow(
      expect.objectContaining({
        error: 'invalid_grant',
        errorDescription: 'code_verifier validation failed',
      }),
    );
  });
});

describe('requireRefreshToken', () => {
  it('should return the refresh token', () => {
    expect(requireRefreshToken('refresh-token')).toBe('refresh-token');
  });

  it('should reject an empty refresh token', () => {
    expect(() => requireRefreshToken('')).toThrow('Missing required parameter: refresh_token');
  });
});

describe('requireStoredRefreshToken', () => {
  it('should return the stored record', () => {
    expect(requireStoredRefreshToken({ subject: 'user-1' })).toEqual({ subject: 'user-1' });
  });

  it('should reject a token that the store did not find', () => {
    expect(() => requireStoredRefreshToken(null)).toThrow(
      expect.objectContaining({
        error: 'invalid_grant',
        errorDescription: 'Refresh token not found',
      }),
    );
  });
});

describe('validateRefreshTokenNotUsed', () => {
  it('should accept an unused token', () => {
    expect(validateRefreshTokenNotUsed(false)).toBeUndefined();
  });

  it('should reject a rotated token', () => {
    expect(() => validateRefreshTokenNotUsed(true)).toThrow(
      'Refresh token has already been used',
    );
  });
});

describe('validateRefreshTokenUnused with a minimal resolver', () => {
  it('should revoke the grant before rejecting reuse', async () => {
    const revoked: string[] = [];
    await expect(
      validateRefreshTokenUnused(
        { used: true, grantId: 'grant-1' },
        {
          async revokeTokensByGrantId(grantId: string) {
            revoked.push(grantId);
          },
        },
      ),
    ).rejects.toThrow('Refresh token has already been used');
    expect(revoked).toEqual(['grant-1']);
  });
});

describe('requireRefreshTokenSession', () => {
  it('should return the session', () => {
    expect(requireRefreshTokenSession({ subject: 'user-1' })).toEqual({ subject: 'user-1' });
  });

  it('should reject an ended session', () => {
    expect(() => requireRefreshTokenSession(null)).toThrow(
      expect.objectContaining({
        error: 'invalid_grant',
        errorDescription: 'The authentication session bound to this refresh token has ended',
      }),
    );
  });
});

describe('validateRefreshTokenSessionSubject', () => {
  it('should accept the same subject', () => {
    expect(validateRefreshTokenSessionSubject('user-1', 'user-1')).toBeUndefined();
  });

  it('should reject a different subject', () => {
    expect(() => validateRefreshTokenSessionSubject('user-2', 'user-1')).toThrow(
      expect.objectContaining({
        error: 'invalid_grant',
        errorDescription:
          'The authentication session bound to this refresh token belongs to another subject',
      }),
    );
  });
});

describe('validateRefreshTokenScopeNotEmpty', () => {
  it('should accept a non-empty scope list', () => {
    expect(validateRefreshTokenScopeNotEmpty(['openid'])).toBeUndefined();
  });

  it('should reject an empty scope list', () => {
    expect(() => validateRefreshTokenScopeNotEmpty([])).toThrow(
      expect.objectContaining({
        error: 'invalid_scope',
        errorDescription: 'Requested scope must not be empty',
      }),
    );
  });
});

describe('validateRefreshTokenScopeWithinGrant', () => {
  // RFC 6749 §6: the requested scope must not exceed the original grant
  it('should accept a subset of the original scope', () => {
    expect(
      validateRefreshTokenScopeWithinGrant(['openid'], ['openid', 'email']),
    ).toBeUndefined();
  });

  it('should reject a scope outside the original grant', () => {
    expect(() =>
      validateRefreshTokenScopeWithinGrant(['openid', 'phone'], ['openid', 'email']),
    ).toThrow(
      expect.objectContaining({
        error: 'invalid_scope',
        errorDescription: 'Requested scope exceeds original grant: phone',
      }),
    );
  });
});
