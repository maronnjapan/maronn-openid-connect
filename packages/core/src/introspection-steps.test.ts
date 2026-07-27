/**
 * Token Introspection（RFC 7662）の機能単位ステップ関数のテスト。
 *
 * handleIntrospectionRequest はこれらのステップ関数の合成であり、CLI 生成コードは
 * 各ステップを個別に呼び出して、利用者が検証処理を消したり足したりできるように
 * する。合成後の網羅的な振る舞いは introspection.test.ts が担保し、本ファイルは
 * 各ステップ関数の入出力契約（成功値と代表的なエラー）を固定する。
 */
import { describe, it, expect } from 'vitest';
import {
  buildIntrospectionResponse,
  isIntrospectionTokenActive,
  requireIntrospectionClient,
  requireIntrospectionToken,
  resolveIntrospectionToken,
  INACTIVE_INTROSPECTION_RESPONSE,
  IntrospectionError,
  IntrospectionErrorCode,
} from './introspection';
import type {
  IntrospectionAccessTokenResolver,
  IntrospectionRefreshTokenResolver,
} from './introspection';
import type { AccessTokenInfo } from './userinfo';
import type { RefreshTokenInfo } from './token-request';

const NOW = 1_700_000_000;

const defaultAccessToken: AccessTokenInfo = {
  sub: 'user-123',
  scope: ['openid', 'profile'],
  clientId: 'client123',
  expiresAt: NOW + 3600,
  iat: NOW - 10,
  nbf: NOW - 10,
  audience: ['https://op.example.com/userinfo'],
  issuer: 'https://op.example.com',
  jti: 'jti-1',
};

const defaultRefreshToken: RefreshTokenInfo = {
  subject: 'user-123',
  clientId: 'client123',
  scope: ['openid', 'offline_access'],
  expiresAt: NOW + 86400,
  used: false,
  grantId: 'grant-123',
  originalIssuedAt: NOW - 100,
  iat: NOW - 100,
  issuer: 'https://op.example.com',
};

function createAccessTokenResolver(
  tokens: Record<string, AccessTokenInfo>,
): IntrospectionAccessTokenResolver {
  return { findAccessToken: async (token) => tokens[token] ?? null };
}

function createRefreshTokenResolver(
  tokens: Record<string, RefreshTokenInfo>,
): IntrospectionRefreshTokenResolver {
  return { resolve: async (token) => tokens[token] ?? null };
}

/** 同期ステップが投げた IntrospectionError を取り出す（投げなければ undefined） */
function captureError(fn: () => unknown): IntrospectionError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as IntrospectionError;
  }
}

describe('requireIntrospectionToken', () => {
  it('should return the token parameter when present', () => {
    const result = requireIntrospectionToken({ token: 'token-abc' });

    expect(result).toBe('token-abc');
  });

  it('should reject a missing token with invalid_request', () => {
    const error = captureError(() => requireIntrospectionToken({}));

    expect(error).toBeInstanceOf(IntrospectionError);
    expect(error?.error).toBe(IntrospectionErrorCode.InvalidRequest);
    expect(error?.errorDescription).toBe('Missing required parameter: token');
  });

  it('should reject an empty token with invalid_request', () => {
    const error = captureError(() => requireIntrospectionToken({ token: '' }));

    expect(error).toBeInstanceOf(IntrospectionError);
    expect(error?.error).toBe(IntrospectionErrorCode.InvalidRequest);
  });
});

describe('requireIntrospectionClient', () => {
  it('should return the authenticated client id', () => {
    const result = requireIntrospectionClient('client123');

    expect(result).toBe('client123');
  });

  it('should reject an unauthenticated caller with invalid_client', () => {
    const error = captureError(() => requireIntrospectionClient(''));

    expect(error).toBeInstanceOf(IntrospectionError);
    expect(error?.error).toBe(IntrospectionErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client authentication required');
  });
});

describe('resolveIntrospectionToken', () => {
  it('should resolve an access token when no hint is given', async () => {
    const result = await resolveIntrospectionToken({
      token: 'at-1',
      accessTokenResolver: createAccessTokenResolver({ 'at-1': defaultAccessToken }),
      refreshTokenResolver: createRefreshTokenResolver({}),
    });

    expect(result).toEqual({ tokenType: 'access_token', accessToken: defaultAccessToken });
  });

  it('should fall back to the refresh token store when no access token matches', async () => {
    const result = await resolveIntrospectionToken({
      token: 'rt-1',
      accessTokenResolver: createAccessTokenResolver({}),
      refreshTokenResolver: createRefreshTokenResolver({ 'rt-1': defaultRefreshToken }),
    });

    expect(result).toEqual({ tokenType: 'refresh_token', refreshToken: defaultRefreshToken });
  });

  it('should search the refresh token store first for token_type_hint=refresh_token', async () => {
    const sharedValue = 'shared-token';
    const result = await resolveIntrospectionToken({
      token: sharedValue,
      tokenTypeHint: 'refresh_token',
      accessTokenResolver: createAccessTokenResolver({ [sharedValue]: defaultAccessToken }),
      refreshTokenResolver: createRefreshTokenResolver({ [sharedValue]: defaultRefreshToken }),
    });

    expect(result).toEqual({ tokenType: 'refresh_token', refreshToken: defaultRefreshToken });
  });

  it('should search the access token store first for an unknown hint', async () => {
    const sharedValue = 'shared-token';
    const result = await resolveIntrospectionToken({
      token: sharedValue,
      tokenTypeHint: 'unknown_type',
      accessTokenResolver: createAccessTokenResolver({ [sharedValue]: defaultAccessToken }),
      refreshTokenResolver: createRefreshTokenResolver({ [sharedValue]: defaultRefreshToken }),
    });

    expect(result).toEqual({ tokenType: 'access_token', accessToken: defaultAccessToken });
  });

  it('should return null when neither store knows the token', async () => {
    const result = await resolveIntrospectionToken({
      token: 'unknown',
      accessTokenResolver: createAccessTokenResolver({}),
      refreshTokenResolver: createRefreshTokenResolver({}),
    });

    expect(result).toBeNull();
  });

  it('should return null for a refresh token when no refresh token resolver is configured', async () => {
    const result = await resolveIntrospectionToken({
      token: 'rt-1',
      tokenTypeHint: 'refresh_token',
      accessTokenResolver: createAccessTokenResolver({}),
    });

    expect(result).toBeNull();
  });
});

describe('isIntrospectionTokenActive', () => {
  it('should report a live access token active', () => {
    const result = isIntrospectionTokenActive(
      { tokenType: 'access_token', accessToken: defaultAccessToken },
      NOW,
    );

    expect(result).toBe(true);
  });

  it('should report an expired access token inactive', () => {
    const result = isIntrospectionTokenActive(
      { tokenType: 'access_token', accessToken: { ...defaultAccessToken, expiresAt: NOW } },
      NOW,
    );

    expect(result).toBe(false);
  });

  it('should report an access token whose nbf is in the future inactive', () => {
    const result = isIntrospectionTokenActive(
      { tokenType: 'access_token', accessToken: { ...defaultAccessToken, nbf: NOW + 1 } },
      NOW,
    );

    expect(result).toBe(false);
  });

  it('should report a live refresh token active', () => {
    const result = isIntrospectionTokenActive(
      { tokenType: 'refresh_token', refreshToken: defaultRefreshToken },
      NOW,
    );

    expect(result).toBe(true);
  });

  it('should report a rotated refresh token inactive', () => {
    const result = isIntrospectionTokenActive(
      { tokenType: 'refresh_token', refreshToken: { ...defaultRefreshToken, used: true } },
      NOW,
    );

    expect(result).toBe(false);
  });

  it('should report an expired refresh token inactive', () => {
    const result = isIntrospectionTokenActive(
      { tokenType: 'refresh_token', refreshToken: { ...defaultRefreshToken, expiresAt: NOW } },
      NOW,
    );

    expect(result).toBe(false);
  });
});

describe('buildIntrospectionResponse', () => {
  it('should build the RFC 7662 claims of an access token', () => {
    const result = buildIntrospectionResponse({
      tokenType: 'access_token',
      accessToken: defaultAccessToken,
    });

    expect(result).toEqual({
      active: true,
      scope: 'openid profile',
      client_id: 'client123',
      token_type: 'Bearer',
      sub: 'user-123',
      exp: NOW + 3600,
      iat: NOW - 10,
      nbf: NOW - 10,
      aud: ['https://op.example.com/userinfo'],
      iss: 'https://op.example.com',
      jti: 'jti-1',
    });
  });

  it('should build the RFC 7662 claims of a refresh token', () => {
    const result = buildIntrospectionResponse({
      tokenType: 'refresh_token',
      refreshToken: defaultRefreshToken,
    });

    expect(result).toEqual({
      active: true,
      scope: 'openid offline_access',
      client_id: 'client123',
      token_type: 'refresh_token',
      sub: 'user-123',
      exp: NOW + 86400,
      iat: NOW - 100,
      iss: 'https://op.example.com',
    });
  });

  it('should omit optional access token claims that were never stored', () => {
    const result = buildIntrospectionResponse({
      tokenType: 'access_token',
      accessToken: {
        sub: 'user-123',
        scope: ['openid'],
        clientId: 'client123',
        expiresAt: NOW + 60,
      },
    });

    expect(result).toEqual({
      active: true,
      scope: 'openid',
      client_id: 'client123',
      token_type: 'Bearer',
      sub: 'user-123',
      exp: NOW + 60,
    });
  });
});

describe('INACTIVE_INTROSPECTION_RESPONSE', () => {
  it('should expose only the active member', () => {
    expect(INACTIVE_INTROSPECTION_RESPONSE).toEqual({ active: false });
  });
});
