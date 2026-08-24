/**
 * トークンリクエスト検証の機能単位ステップ関数のテスト。
 *
 * validateTokenRequest はこれらのステップ関数と grant 別関数
 * （validateAuthorizationCodeGrant / validateRefreshTokenGrant）の合成であり、
 * CLI 生成コードは各ステップを個別に呼び出して、利用者が検証処理を
 * 消したり足したりできるようにする。合成後の網羅的な振る舞いは
 * token-request.test.ts が担保し、本ファイルは各ステップ関数の
 * 入出力契約（成功値と代表的なエラー）を固定する。
 */
import { describe, it, expect } from 'vitest';
import {
  buildValidatedAuthorizationCodeRequest,
  buildValidatedRefreshTokenRequest,
  consumeAuthorizationCode,
  resolveAuthorizationCode,
  validateGrantTypeSupported,
  resolveAuthenticatedTokenClient,
  resolveRefreshToken,
  validateAuthorizationCodeClient,
  validateAuthorizationCodeExpiration,
  validateAuthorizationCodeRedirectUri,
  validateAuthorizationCodeUnused,
  validateClientGrantType,
  validateRefreshTokenClient,
  validateRefreshTokenExpiration,
  validateRefreshTokenIdleTimeout,
  validateRefreshTokenSession,
  validateRefreshTokenScope,
  validateRefreshTokenUnused,
  verifyAuthorizationCodePkce,
  TokenError,
  TokenErrorCode,
} from './token-request.js';
import type {
  AuthenticationSessionInfo,
  AuthenticationSessionResolver,
  AuthorizationCodeInfo,
  AuthorizationCodeResolver,
  RefreshTokenInfo,
  RefreshTokenResolver,
  TokenClientInfo,
  TokenClientResolver,
} from './token-request.js';

function createClientResolver(clients: TokenClientInfo[]): TokenClientResolver {
  return {
    findClient: async (clientId: string): Promise<TokenClientInfo | null> => {
      return clients.find((c) => c.clientId === clientId) ?? null;
    },
  };
}

const defaultClient: TokenClientInfo = {
  clientId: 'client123',
  clientSecret: 'secret',
};

const defaultAuthorizationCode: AuthorizationCodeInfo = {
  code: 'authorization-code',
  grantId: 'grant-123',
  clientId: 'client123',
  redirectUri: 'https://client.example.org/cb',
  redirectUriExplicit: true,
  scope: ['openid', 'profile'],
  subject: 'subject-123',
  authTime: 1_699_999_000,
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
  it('should return authorization_code for grant_type=authorization_code', () => {
    const result = validateGrantTypeSupported('authorization_code');

    expect(result).toBe('authorization_code');
  });

  it('should return refresh_token for grant_type=refresh_token', () => {
    const result = validateGrantTypeSupported('refresh_token');

    expect(result).toBe('refresh_token');
  });

  it('should reject missing grant_type with invalid_request', () => {
    const error = captureError(() => validateGrantTypeSupported(undefined));

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidRequest);
  });

  it('should reject an unknown grant_type with unsupported_grant_type', () => {
    const error = captureError(() =>
      validateGrantTypeSupported('client_credentials')
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.UnsupportedGrantType);
  });

  it('should reject a grant_type excluded from supportedGrantTypes', () => {
    // 機能トグル: OP が refresh_token を提供しない構成では
    // 実装として扱える grant_type でも unsupported_grant_type で拒否する（RFC 6749 §5.2）
    const error = captureError(() =>
      validateGrantTypeSupported('refresh_token', ['authorization_code'])
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.UnsupportedGrantType);
  });
});

describe('resolveAuthenticatedTokenClient', () => {
  it('should return the client for the authenticated client id', async () => {
    const result = await resolveAuthenticatedTokenClient(
      'client123',
      createClientResolver([defaultClient])
    );

    expect(result).toEqual(defaultClient);
  });

  it('should reject an empty authenticated client id with invalid_client', async () => {
    const error = await resolveAuthenticatedTokenClient(
      '',
      createClientResolver([defaultClient])
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TokenError);
    const tokenError = error as TokenError;
    expect(tokenError.error).toBe(TokenErrorCode.InvalidClient);
    expect(tokenError.errorDescription).toBe('Client authentication required');
  });

  it('should reject an unknown client with invalid_client', async () => {
    const error = await resolveAuthenticatedTokenClient(
      'unknown-client',
      createClientResolver([defaultClient])
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TokenError);
    const tokenError = error as TokenError;
    expect(tokenError.error).toBe(TokenErrorCode.InvalidClient);
    expect(tokenError.errorDescription).toBe('Client authentication failed');
  });
});

describe('validateClientGrantType', () => {
  it('should pass when the client grantTypes includes the grant', () => {
    const client: TokenClientInfo = {
      clientId: 'client123',
      clientSecret: 'secret',
      grantTypes: ['authorization_code', 'refresh_token'],
    };

    const error = captureError(() =>
      validateClientGrantType(client, 'refresh_token')
    );

    expect(error).toBe(undefined);
  });

  it('should default to authorization_code only when grantTypes is not registered', () => {
    // OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: 既定は ["authorization_code"]
    const error = captureError(() =>
      validateClientGrantType(defaultClient, 'authorization_code')
    );

    expect(error).toBe(undefined);
  });

  it('should reject a grant_type not registered for the client with unauthorized_client', () => {
    const error = captureError(() =>
      validateClientGrantType(defaultClient, 'refresh_token')
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.UnauthorizedClient);
  });
});

describe('resolveAuthorizationCode', () => {
  it('should return the code value and resolved authorization code', async () => {
    const resolver: AuthorizationCodeResolver = {
      findAuthorizationCode: async (code) =>
        code === 'authorization-code' ? defaultAuthorizationCode : null,
      revokeAuthorizationCode: async () => {},
    };

    const result = await resolveAuthorizationCode(
      { grant_type: 'authorization_code', code: 'authorization-code' },
      resolver
    );

    expect(result).toEqual({
      code: 'authorization-code',
      authorizationCode: defaultAuthorizationCode,
    });
  });

  it('should reject a missing code with invalid_request', async () => {
    const resolver: AuthorizationCodeResolver = {
      findAuthorizationCode: async () => defaultAuthorizationCode,
      revokeAuthorizationCode: async () => {},
    };

    const error = await resolveAuthorizationCode(
      { grant_type: 'authorization_code' },
      resolver
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidRequest,
      errorDescription: 'Missing required parameter: code',
    });
  });

  it('should reject an unknown code with invalid_grant', async () => {
    const resolver: AuthorizationCodeResolver = {
      findAuthorizationCode: async () => null,
      revokeAuthorizationCode: async () => {},
    };

    const error = await resolveAuthorizationCode(
      { grant_type: 'authorization_code', code: 'unknown-code' },
      resolver
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Authorization code not found',
    });
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

  it('should reject an authorization code issued to another client', () => {
    const error = captureError(() =>
      validateAuthorizationCodeClient(defaultAuthorizationCode, 'other-client')
    );

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Authorization code was issued to a different client',
    });
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
  it('should pass when the explicit redirect_uri matches the authorization request', () => {
    const error = captureError(() =>
      validateAuthorizationCodeRedirectUri(
        defaultAuthorizationCode,
        'https://client.example.org/cb'
      )
    );

    expect(error).toBe(undefined);
  });

  it('should reject a missing redirect_uri when it was explicit at authorization time', () => {
    const error = captureError(() =>
      validateAuthorizationCodeRedirectUri(defaultAuthorizationCode, undefined)
    );

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription:
        'redirect_uri is required because it was included in the authorization request',
    });
  });

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

describe('verifyAuthorizationCodePkce', () => {
  it('should return true for a matching S256 code_verifier', async () => {
    const result = await verifyAuthorizationCodePkce(
      defaultAuthorizationCode,
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    );

    expect(result).toBe(true);
  });

  it('should return false when the authorization code has no PKCE binding', async () => {
    const result = await verifyAuthorizationCodePkce(
      {
        ...defaultAuthorizationCode,
        codeChallenge: undefined,
        codeChallengeMethod: undefined,
      },
      undefined
    );

    expect(result).toBe(false);
  });

  it('should reject a mismatched code_verifier', async () => {
    const error = await verifyAuthorizationCodePkce(
      defaultAuthorizationCode,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'code_verifier validation failed',
    });
  });
});

describe('consumeAuthorizationCode', () => {
  it('should mark the resolved authorization code as used', async () => {
    let consumedCode: string | undefined;
    const resolver: AuthorizationCodeResolver = {
      findAuthorizationCode: async () => defaultAuthorizationCode,
      revokeAuthorizationCode: async (code) => {
        consumedCode = code;
      },
    };

    await consumeAuthorizationCode('authorization-code', resolver);

    expect(consumedCode).toBe('authorization-code');
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
      subject: 'subject-123',
      authTime: 1_699_999_000,
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

  // OIDC Core 1.0 §2: sub is REQUIRED in the ID Token, and §3.1.3.3 requires the
  // authorization_code token response to include an ID Token. The validated
  // request must therefore carry the subject fixed at authorization time.
  it('should return the subject stored on the authorization code', () => {
    const result = buildValidatedAuthorizationCodeRequest(
      'authorization-code',
      { ...defaultAuthorizationCode, subject: 'end-user-42' },
      'client123',
      true
    );

    expect(result).toMatchObject({
      grantType: 'authorization_code',
      subject: 'end-user-42',
    });
  });

  // OIDC Core 1.0 §2: auth_time is REQUIRED when max_age was requested or the
  // client registered require_auth_time, so the value recorded at authorization
  // must reach the token endpoint through the validated request.
  it('should return the authTime stored on the authorization code', () => {
    const result = buildValidatedAuthorizationCodeRequest(
      'authorization-code',
      { ...defaultAuthorizationCode, authTime: 1_699_999_000 },
      'client123',
      true
    );

    expect(result).toMatchObject({
      grantType: 'authorization_code',
      authTime: 1_699_999_000,
    });
  });

  it('should return undefined authTime when the authorization code has none', () => {
    const { authTime: _omitted, ...withoutAuthTime } = {
      ...defaultAuthorizationCode,
    };
    const result = buildValidatedAuthorizationCodeRequest(
      'authorization-code',
      withoutAuthTime,
      'client123',
      true
    );

    expect(result).toMatchObject({
      grantType: 'authorization_code',
      authTime: undefined,
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

  it('should reject a missing refresh_token with invalid_request', async () => {
    const resolver: RefreshTokenResolver = {
      resolve: async () => defaultRefreshToken,
      revokeRefreshToken: async () => {},
    };

    const error = await resolveRefreshToken(
      { grant_type: 'refresh_token' },
      resolver
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidRequest,
      errorDescription: 'Missing required parameter: refresh_token',
    });
  });

  it('should reject a missing resolver with invalid_request', async () => {
    const error = await resolveRefreshToken(
      { grant_type: 'refresh_token', refresh_token: 'refresh-token' },
      undefined
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidRequest,
      errorDescription: 'Refresh token resolver not provided',
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

describe('validateRefreshTokenClient', () => {
  it('should reject a refresh token issued to another client', () => {
    const error = captureError(() =>
      validateRefreshTokenClient(defaultRefreshToken, 'other-client')
    );

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidGrant,
      errorDescription: 'Refresh token was issued to a different client',
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

describe('validateRefreshTokenScope', () => {
  it('should return a deduplicated subset requested by the client', () => {
    const result = validateRefreshTokenScope(
      'openid profile openid',
      defaultRefreshToken.scope
    );

    expect(result).toEqual(['openid', 'profile']);
  });

  it('should reject a scope outside the original grant', () => {
    const error = captureError(() =>
      validateRefreshTokenScope('openid admin', defaultRefreshToken.scope)
    );

    expect(error).toMatchObject({
      error: TokenErrorCode.InvalidScope,
      errorDescription: 'Requested scope exceeds original grant: admin',
    });
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
