/**
 * UserInfo リクエスト処理の機能単位ステップ関数のテスト。
 *
 * handleUserInfoRequest はこれらのステップ関数の合成であり、CLI 生成コードは
 * 各ステップを個別に呼び出して、利用者が検証処理を消したり足したりできるように
 * する。合成後の網羅的な振る舞いは userinfo.test.ts が担保し、本ファイルは
 * 各ステップ関数の入出力契約（成功値と代表的なエラー）を固定する。
 */
import { describe, it, expect } from 'vitest';
import {
  applyRequestedClaims,
  resolveUserInfoAccessToken,
  resolveUserInfoClaims,
  validateUserInfoAudience,
  validateUserInfoScope,
  validateUserInfoTokenExpiration,
  UserInfoError,
  UserInfoErrorCode,
} from './userinfo.js';
import type {
  AccessTokenInfo,
  AccessTokenResolver,
  UserClaims,
  UserClaimsResolver,
} from './userinfo.js';

const NOW = 1_700_000_000;

const defaultTokenInfo: AccessTokenInfo = {
  sub: 'user-123',
  scope: ['openid', 'profile'],
  clientId: 'client123',
  expiresAt: NOW + 3600,
  audience: ['https://op.example.com/userinfo'],
};

const defaultUserClaims: UserClaims = {
  sub: 'user-123',
  name: 'Taro Yamada',
  email: 'taro@example.com',
  email_verified: true,
};

function createAccessTokenResolver(
  tokens: Record<string, AccessTokenInfo>,
): AccessTokenResolver {
  return {
    findAccessToken: async (token: string) => tokens[token] ?? null,
  };
}

function createUserClaimsResolver(
  users: Record<string, UserClaims>,
): UserClaimsResolver {
  return {
    findUserClaims: async (sub: string) => users[sub] ?? null,
  };
}

/** 同期ステップが投げた UserInfoError を取り出す（投げなければ undefined） */
function captureError(fn: () => unknown): UserInfoError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as UserInfoError;
  }
}

/** 非同期ステップが投げた UserInfoError を取り出す（投げなければ undefined） */
async function captureAsyncError(
  fn: () => Promise<unknown>,
): Promise<UserInfoError | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as UserInfoError;
  }
}

describe('resolveUserInfoAccessToken', () => {
  it('should return the stored access token info for a known token', async () => {
    const resolver = createAccessTokenResolver({ 'token-abc': defaultTokenInfo });

    const result = await resolveUserInfoAccessToken('token-abc', resolver);

    expect(result).toEqual(defaultTokenInfo);
  });

  it('should reject a missing access token with invalid_token', async () => {
    const resolver = createAccessTokenResolver({});

    const error = await captureAsyncError(() =>
      resolveUserInfoAccessToken('', resolver),
    );

    expect(error).toBeInstanceOf(UserInfoError);
    expect(error?.error).toBe(UserInfoErrorCode.InvalidToken);
    expect(error?.errorDescription).toBe('Access token is required');
  });

  it('should reject an unknown access token with invalid_token', async () => {
    const resolver = createAccessTokenResolver({ 'token-abc': defaultTokenInfo });

    const error = await captureAsyncError(() =>
      resolveUserInfoAccessToken('token-unknown', resolver),
    );

    expect(error).toBeInstanceOf(UserInfoError);
    expect(error?.error).toBe(UserInfoErrorCode.InvalidToken);
    expect(error?.errorDescription).toBe('Access token is invalid');
  });
});

describe('validateUserInfoTokenExpiration', () => {
  it('should accept a token whose expiresAt is in the future', () => {
    const error = captureError(() =>
      validateUserInfoTokenExpiration(defaultTokenInfo, NOW),
    );

    expect(error).toBeUndefined();
  });

  it('should accept a token whose expiresAt equals now', () => {
    const error = captureError(() =>
      validateUserInfoTokenExpiration({ ...defaultTokenInfo, expiresAt: NOW }, NOW),
    );

    expect(error).toBeUndefined();
  });

  it('should reject an expired token with invalid_token', () => {
    const error = captureError(() =>
      validateUserInfoTokenExpiration({ ...defaultTokenInfo, expiresAt: NOW - 1 }, NOW),
    );

    expect(error).toBeInstanceOf(UserInfoError);
    expect(error?.error).toBe(UserInfoErrorCode.InvalidToken);
    expect(error?.errorDescription).toBe('The access token expired');
  });
});

describe('validateUserInfoScope', () => {
  it('should accept a token that carries the openid scope', () => {
    const error = captureError(() => validateUserInfoScope(defaultTokenInfo));

    expect(error).toBeUndefined();
  });

  it('should reject a token without the openid scope with insufficient_scope', () => {
    const error = captureError(() =>
      validateUserInfoScope({ ...defaultTokenInfo, scope: ['profile'] }),
    );

    expect(error).toBeInstanceOf(UserInfoError);
    expect(error?.error).toBe(UserInfoErrorCode.InsufficientScope);
    expect(error?.errorDescription).toBe('The openid scope is required');
  });
});

describe('validateUserInfoAudience', () => {
  it('should accept a token whose audience contains the expected audience', () => {
    const error = captureError(() =>
      validateUserInfoAudience(defaultTokenInfo, 'https://op.example.com/userinfo'),
    );

    expect(error).toBeUndefined();
  });

  it('should skip validation when no expected audience is given', () => {
    const error = captureError(() =>
      validateUserInfoAudience({ ...defaultTokenInfo, audience: undefined }, undefined),
    );

    expect(error).toBeUndefined();
  });

  it('should reject a token whose audience omits the expected audience', () => {
    const error = captureError(() =>
      validateUserInfoAudience(
        { ...defaultTokenInfo, audience: ['https://api.example.org'] },
        'https://op.example.com/userinfo',
      ),
    );

    expect(error).toBeInstanceOf(UserInfoError);
    expect(error?.error).toBe(UserInfoErrorCode.InvalidToken);
    expect(error?.errorDescription).toBe(
      'The access token is not intended for the UserInfo endpoint',
    );
  });

  it('should reject a token that stores no audience at all', () => {
    const error = captureError(() =>
      validateUserInfoAudience(
        { ...defaultTokenInfo, audience: undefined },
        'https://op.example.com/userinfo',
      ),
    );

    expect(error).toBeInstanceOf(UserInfoError);
    expect(error?.error).toBe(UserInfoErrorCode.InvalidToken);
  });
});

describe('resolveUserInfoClaims', () => {
  it('should return the claims of the token subject', async () => {
    const resolver = createUserClaimsResolver({ 'user-123': defaultUserClaims });

    const result = await resolveUserInfoClaims(defaultTokenInfo, resolver);

    expect(result).toEqual(defaultUserClaims);
  });

  it('should reject an unknown subject with invalid_token', async () => {
    const resolver = createUserClaimsResolver({});

    const error = await captureAsyncError(() =>
      resolveUserInfoClaims(defaultTokenInfo, resolver),
    );

    expect(error).toBeInstanceOf(UserInfoError);
    expect(error?.error).toBe(UserInfoErrorCode.InvalidToken);
    expect(error?.errorDescription).toBe(
      'User not found for the given access token',
    );
  });
});

describe('applyRequestedClaims', () => {
  it('should return the response unchanged when no claims parameter is given', () => {
    const result = applyRequestedClaims(
      { sub: 'user-123' },
      defaultUserClaims,
      undefined,
    );

    expect(result).toEqual({ sub: 'user-123' });
  });

  it('should add a claim requested with a null entry', () => {
    const result = applyRequestedClaims({ sub: 'user-123' }, defaultUserClaims, {
      userinfo: { email: null },
    });

    expect(result).toEqual({ sub: 'user-123', email: 'taro@example.com' });
  });

  it('should not overwrite sub with a requested claim', () => {
    const result = applyRequestedClaims({ sub: 'user-123' }, defaultUserClaims, {
      userinfo: { sub: { value: 'attacker' } },
    });

    expect(result).toEqual({ sub: 'user-123' });
  });

  it('should omit a claim whose requested value does not match', () => {
    const result = applyRequestedClaims({ sub: 'user-123' }, defaultUserClaims, {
      userinfo: { email: { value: 'other@example.com' } },
    });

    expect(result).toEqual({ sub: 'user-123' });
  });

  it('should add a claim whose requested value matches', () => {
    const result = applyRequestedClaims({ sub: 'user-123' }, defaultUserClaims, {
      userinfo: { email: { value: 'taro@example.com' } },
    });

    expect(result).toEqual({ sub: 'user-123', email: 'taro@example.com' });
  });

  it('should ignore id_token members of the claims parameter', () => {
    const result = applyRequestedClaims({ sub: 'user-123' }, defaultUserClaims, {
      id_token: { email: null },
    });

    expect(result).toEqual({ sub: 'user-123' });
  });

  it('should not mutate the response passed in', () => {
    const response = { sub: 'user-123' };

    applyRequestedClaims(response, defaultUserClaims, { userinfo: { email: null } });

    expect(response).toEqual({ sub: 'user-123' });
  });

  // OIDC Core 1.0 Section 5.5.1: an unfulfillable requested claim MUST NOT raise an
  // error, so declining names outside the OP's declared vocabulary is spec compliant.
  it('should omit a claim name outside the default allowlist', () => {
    const leakyUserClaims = {
      ...defaultUserClaims,
      password_hash: '$2b$12$notarealhash',
    } as UserClaims;

    const result = applyRequestedClaims({ sub: 'user-123' }, leakyUserClaims, {
      userinfo: { password_hash: null },
    });

    expect(result).toEqual({ sub: 'user-123' });
  });

  it('should omit a claim name outside an explicitly supplied allowlist', () => {
    const result = applyRequestedClaims(
      { sub: 'user-123' },
      defaultUserClaims,
      { userinfo: { email: null } },
      new Set(['sub']),
    );

    expect(result).toEqual({ sub: 'user-123' });
  });

  it('should add a claim name inside an explicitly supplied allowlist', () => {
    const result = applyRequestedClaims(
      { sub: 'user-123' },
      defaultUserClaims,
      { userinfo: { email: null } },
      new Set(['sub', 'email']),
    );

    expect(result).toEqual({ sub: 'user-123', email: 'taro@example.com' });
  });
});
