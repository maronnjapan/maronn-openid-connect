/**
 * client_credentials グラント（RFC 6749 §4.4 / OAuth 2.1 §4.2）のステップ関数のテスト。
 *
 * CLI 生成コードはこれらのステップを個別に呼び出すので、関数ごとに入出力と
 * エラーコード（RFC 6749 §5.2、RFC 8707 §2）を固定する。
 */
import { describe, it, expect } from 'vitest';
import {
  CLIENT_CREDENTIALS_FORBIDDEN_SCOPES,
  CLIENT_CREDENTIALS_GRANT_TYPE,
  buildClientCredentialsTokenResponse,
  buildValidatedClientCredentialsRequest,
  resolveClientCredentialsAudience,
  resolveClientCredentialsScope,
  validateClientCredentialsConfidentialClient,
  validateClientCredentialsGrantAllowed,
  validateClientCredentialsScopeAllowed,
  validateClientCredentialsScopeRegistered,
} from './client-credentials-grant.js';
import { TokenError, TokenErrorCode } from './token-error.js';

function captureError(fn: () => unknown): TokenError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as TokenError;
  }
}

describe('CLIENT_CREDENTIALS_GRANT_TYPE', () => {
  it('should be the grant_type value of RFC 6749 §4.4.2', () => {
    expect(CLIENT_CREDENTIALS_GRANT_TYPE).toBe('client_credentials');
  });
});

describe('validateClientCredentialsGrantAllowed', () => {
  it('should accept a client that registered client_credentials', () => {
    expect(() =>
      validateClientCredentialsGrantAllowed({ grantTypes: ['client_credentials'] })
    ).not.toThrow();
  });

  // RFC 7591 §2: grant_types の既定値は ["authorization_code"] なので、未登録のクライアントは使えない
  it('should reject a client without registered grant types with unauthorized_client', () => {
    const error = captureError(() => validateClientCredentialsGrantAllowed({}));

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.UnauthorizedClient);
    expect(error?.errorDescription).toBe(
      'Client is not authorized to use grant_type: client_credentials'
    );
    expect(error?.statusCode).toBe(400);
  });

  it('should reject a client that registered other grant types only with unauthorized_client', () => {
    const error = captureError(() =>
      validateClientCredentialsGrantAllowed({ grantTypes: ['authorization_code', 'refresh_token'] })
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.UnauthorizedClient);
  });
});

describe('validateClientCredentialsConfidentialClient', () => {
  it('should accept a client without registered authentication methods (client_secret_basic by default)', () => {
    expect(() => validateClientCredentialsConfidentialClient({})).not.toThrow();
  });

  it.each([
    ['client_secret_basic'],
    ['client_secret_post'],
    ['private_key_jwt'],
  ] as const)('should accept a confidential client authenticating with %s', (method) => {
    expect(() =>
      validateClientCredentialsConfidentialClient({ tokenEndpointAuthMethods: [method] })
    ).not.toThrow();
  });

  // RFC 6749 §4.4: The client credentials grant type MUST only be used by confidential clients.
  it('should reject a public client with unauthorized_client', () => {
    const error = captureError(() =>
      validateClientCredentialsConfidentialClient({ tokenEndpointAuthMethods: ['none'] })
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.UnauthorizedClient);
    expect(error?.errorDescription).toBe(
      'The client_credentials grant is only available to confidential clients'
    );
  });
});

describe('validateClientCredentialsScopeAllowed', () => {
  it('should list openid and offline_access as the scopes the grant never issues', () => {
    expect(CLIENT_CREDENTIALS_FORBIDDEN_SCOPES).toEqual(['openid', 'offline_access']);
  });

  it('should accept scopes of a resource server', () => {
    expect(() => validateClientCredentialsScopeAllowed(['reports.read', 'reports.write'])).not.toThrow();
  });

  it('should accept an empty scope', () => {
    expect(() => validateClientCredentialsScopeAllowed([])).not.toThrow();
  });

  // openid のトークンは UserInfo エンドポイントで使えてしまうので、エンドユーザーのいないグラントでは発行しない
  it('should reject openid with invalid_scope', () => {
    const error = captureError(() => validateClientCredentialsScopeAllowed(['openid', 'reports.read']));

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidScope);
    expect(error?.errorDescription).toBe(
      'Scope is not available for the client_credentials grant: openid'
    );
  });

  // RFC 6749 §4.4.3: このグラントはリフレッシュトークンを返さない
  it('should reject offline_access with invalid_scope', () => {
    const error = captureError(() => validateClientCredentialsScopeAllowed(['reports.read', 'offline_access']));

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidScope);
    expect(error?.errorDescription).toBe(
      'Scope is not available for the client_credentials grant: offline_access'
    );
  });
});

describe('validateClientCredentialsScopeRegistered', () => {
  it('should accept scopes the client registered', () => {
    expect(() =>
      validateClientCredentialsScopeRegistered(['reports.read'], ['reports.read', 'reports.write'])
    ).not.toThrow();
  });

  it('should accept an empty request for a client without registered scopes', () => {
    expect(() => validateClientCredentialsScopeRegistered([], undefined)).not.toThrow();
  });

  it('should reject a scope the client did not register with invalid_scope', () => {
    const error = captureError(() =>
      validateClientCredentialsScopeRegistered(['reports.read', 'admin'], ['reports.read'])
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidScope);
    expect(error?.errorDescription).toBe('Client is not registered for scope: admin');
  });

  // 同意画面のないグラントなので、スコープを登録していないクライアントには何も発行しない
  it('should reject every scope for a client without registered scopes with invalid_scope', () => {
    const error = captureError(() => validateClientCredentialsScopeRegistered(['reports.read'], undefined));

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidScope);
    expect(error?.errorDescription).toBe('Client is not registered for scope: reports.read');
  });
});

describe('resolveClientCredentialsScope', () => {
  it('should return the requested scopes without duplicates', () => {
    const scope = resolveClientCredentialsScope('reports.read reports.write reports.read', {
      scope: ['reports.read', 'reports.write'],
    });

    expect(scope).toEqual(['reports.read', 'reports.write']);
  });

  it('should return a subset of the registered scopes', () => {
    const scope = resolveClientCredentialsScope('reports.read', {
      scope: ['reports.read', 'reports.write'],
    });

    expect(scope).toEqual(['reports.read']);
  });

  // RFC 6749 §3.3: scope を省いたリクエストは、あらかじめ決めた既定値で処理する
  it('should default to the registered scopes when scope is omitted', () => {
    const scope = resolveClientCredentialsScope(undefined, {
      scope: ['reports.read', 'reports.write'],
    });

    expect(scope).toEqual(['reports.read', 'reports.write']);
  });

  it('should leave openid and offline_access out of the default', () => {
    const scope = resolveClientCredentialsScope(undefined, {
      scope: ['openid', 'profile', 'offline_access', 'reports.read'],
    });

    expect(scope).toEqual(['profile', 'reports.read']);
  });

  it('should default to an empty scope for a client without registered scopes', () => {
    expect(resolveClientCredentialsScope(undefined, {})).toEqual([]);
  });

  it.each(['', '   '])('should reject the empty scope value %j with invalid_scope', (value) => {
    const error = captureError(() => resolveClientCredentialsScope(value, { scope: ['reports.read'] }));

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidScope);
    expect(error?.errorDescription).toBe('Requested scope must not be empty');
  });

  it('should reject openid even when the client registered it', () => {
    const error = captureError(() =>
      resolveClientCredentialsScope('openid reports.read', { scope: ['openid', 'reports.read'] })
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidScope);
    expect(error?.errorDescription).toBe(
      'Scope is not available for the client_credentials grant: openid'
    );
  });

  it('should reject a scope outside the registered scopes with invalid_scope', () => {
    const error = captureError(() =>
      resolveClientCredentialsScope('reports.read admin', { scope: ['reports.read'] })
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidScope);
    expect(error?.errorDescription).toBe('Client is not registered for scope: admin');
  });

  it('should reject a requested scope for a client without registered scopes', () => {
    const error = captureError(() => resolveClientCredentialsScope('reports.read', {}));

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidScope);
  });
});

describe('resolveClientCredentialsAudience', () => {
  const allowed = ['https://api.example.com', 'https://billing.example.com'];

  it('should return undefined when audience is omitted', () => {
    expect(resolveClientCredentialsAudience(undefined, allowed)).toBeUndefined();
  });

  it('should return the requested audience when it is allowed', () => {
    expect(resolveClientCredentialsAudience('https://api.example.com', allowed)).toEqual([
      'https://api.example.com',
    ]);
  });

  it('should return several audiences without duplicates', () => {
    expect(
      resolveClientCredentialsAudience(
        'https://api.example.com https://billing.example.com https://api.example.com',
        allowed,
      )
    ).toEqual(['https://api.example.com', 'https://billing.example.com']);
  });

  // RFC 8707 §2: 許可していないリソースは invalid_target
  it('should reject an audience that is not allowed with invalid_target', () => {
    const error = captureError(() =>
      resolveClientCredentialsAudience('https://api.example.com https://other.example.com', allowed)
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidTarget);
    expect(error?.errorDescription).toBe(
      'Requested audience is not allowed: https://other.example.com'
    );
    expect(error?.statusCode).toBe(400);
  });

  it('should reject every audience when none is allowed', () => {
    const error = captureError(() => resolveClientCredentialsAudience('https://api.example.com', []));

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidTarget);
  });

  it.each(['', '  '])('should reject the empty audience value %j with invalid_target', (value) => {
    const error = captureError(() => resolveClientCredentialsAudience(value, allowed));

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidTarget);
    expect(error?.errorDescription).toBe('Requested audience must not be empty');
  });
});

describe('buildValidatedClientCredentialsRequest', () => {
  // RFC 9068 §2.2: リソースオーナーのいないグラントでは sub がクライアントを示す
  it('should use the client id as the subject', () => {
    const request = buildValidatedClientCredentialsRequest('service-1', ['reports.read'], [
      'https://api.example.com',
    ]);

    expect(request).toEqual({
      grantType: 'client_credentials',
      clientId: 'service-1',
      subject: 'service-1',
      scope: ['reports.read'],
      audience: ['https://api.example.com'],
    });
  });

  it('should keep the audience undefined when none was requested', () => {
    const request = buildValidatedClientCredentialsRequest('service-1', [], undefined);

    expect(request.audience).toBeUndefined();
    expect(request.scope).toEqual([]);
  });
});

describe('buildClientCredentialsTokenResponse', () => {
  it('should return access_token, token_type, expires_in and scope', () => {
    const response = buildClientCredentialsTokenResponse({
      accessToken: 'access-token-value',
      expiresIn: 3600,
      scope: ['reports.read', 'reports.write'],
    });

    expect(response).toEqual({
      access_token: 'access-token-value',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'reports.read reports.write',
    });
  });

  it('should leave scope out when no scope was issued', () => {
    const response = buildClientCredentialsTokenResponse({
      accessToken: 'access-token-value',
      expiresIn: 3600,
      scope: [],
    });

    expect(response).toEqual({
      access_token: 'access-token-value',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });

  // RFC 6749 §4.4.3: A refresh token SHOULD NOT be included.
  it('should never include a refresh_token or an id_token', () => {
    const response = buildClientCredentialsTokenResponse({
      accessToken: 'access-token-value',
      expiresIn: 3600,
      scope: ['reports.read'],
    });

    expect(response).not.toHaveProperty('refresh_token');
    expect(response).not.toHaveProperty('id_token');
  });
});
