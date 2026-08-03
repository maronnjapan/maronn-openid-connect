/**
 * Token Revocation（RFC 7009）の機能単位ステップ関数のテスト。
 *
 * handleRevocationRequest はこれらのステップ関数の合成であり、CLI 生成コードは
 * 各ステップを個別に呼び出して、利用者が検証処理を消したり足したりできるように
 * する。合成後の網羅的な振る舞いは revocation.test.ts が担保し、本ファイルは
 * 各ステップ関数の入出力契約（成功値と代表的なエラー）を固定する。
 */
import { describe, it, expect } from 'vitest';
import {
  requireRevocationClient,
  requireRevocationToken,
  resolveRevocationTarget,
  revokeGrantAccessTokens,
  revokeResolvedToken,
  validateRevocationTokenClient,
  RevocationError,
  RevocationErrorCode,
} from './revocation.js';
import type { RevocationTokenResolvers } from './revocation.js';
import type { AccessTokenInfo } from './userinfo.js';
import type { RefreshTokenInfo } from './token-request.js';

const NOW = 1_700_000_000;

const defaultAccessToken: AccessTokenInfo = {
  sub: 'user-123',
  scope: ['openid'],
  clientId: 'client123',
  expiresAt: NOW + 3600,
  grantId: 'grant-123',
};

const defaultRefreshToken: RefreshTokenInfo = {
  subject: 'user-123',
  clientId: 'client123',
  scope: ['openid', 'offline_access'],
  expiresAt: NOW + 86400,
  used: false,
  grantId: 'grant-123',
  originalIssuedAt: NOW - 100,
};

interface RecordingResolvers extends RevocationTokenResolvers {
  revokedAccessTokens: string[];
  revokedRefreshTokens: string[];
  revokedGrantIds: string[];
}

function createResolvers(options: {
  accessTokens?: Record<string, AccessTokenInfo>;
  refreshTokens?: Record<string, RefreshTokenInfo>;
  withRefreshSupport?: boolean;
  withGrantCascade?: boolean;
}): RecordingResolvers {
  const {
    accessTokens = {},
    refreshTokens = {},
    withRefreshSupport = true,
    withGrantCascade = true,
  } = options;
  const revokedAccessTokens: string[] = [];
  const revokedRefreshTokens: string[] = [];
  const revokedGrantIds: string[] = [];

  const resolvers: RecordingResolvers = {
    revokedAccessTokens,
    revokedRefreshTokens,
    revokedGrantIds,
    findAccessToken: async (token) => accessTokens[token] ?? null,
    revokeAccessToken: async (token) => {
      revokedAccessTokens.push(token);
    },
  };

  if (withRefreshSupport) {
    resolvers.findRefreshToken = async (token) => refreshTokens[token] ?? null;
    resolvers.revokeRefreshToken = async (token) => {
      revokedRefreshTokens.push(token);
    };
  }

  if (withGrantCascade) {
    resolvers.revokeAccessTokensByGrantId = async (grantId) => {
      revokedGrantIds.push(grantId);
    };
  }

  return resolvers;
}

/** 同期ステップが投げた RevocationError を取り出す（投げなければ undefined） */
function captureError(fn: () => unknown): RevocationError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as RevocationError;
  }
}

describe('requireRevocationToken', () => {
  it('should return the token parameter when present', () => {
    const result = requireRevocationToken({ token: 'token-abc' });

    expect(result).toBe('token-abc');
  });

  it('should reject a missing token with invalid_request', () => {
    const error = captureError(() => requireRevocationToken({}));

    expect(error).toBeInstanceOf(RevocationError);
    expect(error?.error).toBe(RevocationErrorCode.InvalidRequest);
    expect(error?.errorDescription).toBe('Missing required parameter: token');
  });
});

describe('requireRevocationClient', () => {
  it('should return the authenticated client id', () => {
    const result = requireRevocationClient('client123');

    expect(result).toBe('client123');
  });

  it('should reject an unauthenticated caller with invalid_client', () => {
    const error = captureError(() => requireRevocationClient(''));

    expect(error).toBeInstanceOf(RevocationError);
    expect(error?.error).toBe(RevocationErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client authentication required');
  });
});

describe('resolveRevocationTarget', () => {
  it('should resolve an access token when no hint is given', async () => {
    const result = await resolveRevocationTarget({
      token: 'at-1',
      resolvers: createResolvers({ accessTokens: { 'at-1': defaultAccessToken } }),
    });

    expect(result).toEqual({ tokenType: 'access_token', accessToken: defaultAccessToken });
  });

  it('should fall back to the refresh token store when no access token matches', async () => {
    const result = await resolveRevocationTarget({
      token: 'rt-1',
      resolvers: createResolvers({ refreshTokens: { 'rt-1': defaultRefreshToken } }),
    });

    expect(result).toEqual({ tokenType: 'refresh_token', refreshToken: defaultRefreshToken });
  });

  it('should search the refresh token store first for token_type_hint=refresh_token', async () => {
    const result = await resolveRevocationTarget({
      token: 'shared',
      tokenTypeHint: 'refresh_token',
      resolvers: createResolvers({
        accessTokens: { shared: defaultAccessToken },
        refreshTokens: { shared: defaultRefreshToken },
      }),
    });

    expect(result).toEqual({ tokenType: 'refresh_token', refreshToken: defaultRefreshToken });
  });

  it('should return null for an unknown token', async () => {
    const result = await resolveRevocationTarget({
      token: 'unknown',
      resolvers: createResolvers({}),
    });

    expect(result).toBeNull();
  });

  it('should return null for a refresh token when the resolvers cannot revoke refresh tokens', async () => {
    const result = await resolveRevocationTarget({
      token: 'rt-1',
      tokenTypeHint: 'refresh_token',
      resolvers: createResolvers({
        refreshTokens: { 'rt-1': defaultRefreshToken },
        withRefreshSupport: false,
      }),
    });

    expect(result).toBeNull();
  });
});

describe('validateRevocationTokenClient', () => {
  it('should accept an access token issued to the authenticated client', () => {
    const error = captureError(() =>
      validateRevocationTokenClient(
        { tokenType: 'access_token', accessToken: defaultAccessToken },
        'client123',
      ),
    );

    expect(error).toBeUndefined();
  });

  it('should reject an access token issued to another client with invalid_grant', () => {
    const error = captureError(() =>
      validateRevocationTokenClient(
        { tokenType: 'access_token', accessToken: defaultAccessToken },
        'other-client',
      ),
    );

    expect(error).toBeInstanceOf(RevocationError);
    expect(error?.error).toBe(RevocationErrorCode.InvalidGrant);
    expect(error?.errorDescription).toBe('Token was not issued to the requesting client');
  });

  it('should reject a refresh token issued to another client with invalid_grant', () => {
    const error = captureError(() =>
      validateRevocationTokenClient(
        { tokenType: 'refresh_token', refreshToken: defaultRefreshToken },
        'other-client',
      ),
    );

    expect(error).toBeInstanceOf(RevocationError);
    expect(error?.error).toBe(RevocationErrorCode.InvalidGrant);
  });
});

describe('revokeResolvedToken', () => {
  it('should revoke the presented access token', async () => {
    const resolvers = createResolvers({ accessTokens: { 'at-1': defaultAccessToken } });

    await revokeResolvedToken(
      'at-1',
      { tokenType: 'access_token', accessToken: defaultAccessToken },
      resolvers,
    );

    expect(resolvers.revokedAccessTokens).toEqual(['at-1']);
    expect(resolvers.revokedRefreshTokens).toEqual([]);
  });

  it('should revoke the presented refresh token', async () => {
    const resolvers = createResolvers({ refreshTokens: { 'rt-1': defaultRefreshToken } });

    await revokeResolvedToken(
      'rt-1',
      { tokenType: 'refresh_token', refreshToken: defaultRefreshToken },
      resolvers,
    );

    expect(resolvers.revokedRefreshTokens).toEqual(['rt-1']);
    expect(resolvers.revokedAccessTokens).toEqual([]);
  });
});

describe('revokeGrantAccessTokens', () => {
  it('should revoke every access token of the grant when a refresh token was revoked', async () => {
    const resolvers = createResolvers({ refreshTokens: { 'rt-1': defaultRefreshToken } });

    await revokeGrantAccessTokens(
      { tokenType: 'refresh_token', refreshToken: defaultRefreshToken },
      resolvers,
    );

    expect(resolvers.revokedGrantIds).toEqual(['grant-123']);
  });

  it('should not cascade when the revoked token was an access token', async () => {
    const resolvers = createResolvers({ accessTokens: { 'at-1': defaultAccessToken } });

    await revokeGrantAccessTokens(
      { tokenType: 'access_token', accessToken: defaultAccessToken },
      resolvers,
    );

    expect(resolvers.revokedGrantIds).toEqual([]);
  });

  it('should do nothing when the resolvers do not support grant cascade', async () => {
    const resolvers = createResolvers({
      refreshTokens: { 'rt-1': defaultRefreshToken },
      withGrantCascade: false,
    });

    await revokeGrantAccessTokens(
      { tokenType: 'refresh_token', refreshToken: defaultRefreshToken },
      resolvers,
    );

    expect(resolvers.revokedGrantIds).toEqual([]);
  });
});
