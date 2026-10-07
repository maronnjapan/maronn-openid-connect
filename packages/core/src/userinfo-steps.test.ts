/**
 * UserInfo リクエスト処理の機能単位ステップ関数と部品関数のテスト。
 *
 * CLI 生成コードはこれらのステップを個別に呼び出して、利用者が検証処理を
 * 消したり足したりできるようにする。ステップごとの網羅的な振る舞いは
 * userinfo.test.ts が担保し、本ファイルは部品関数をリテラルの引数で
 * 検証するほか、ステップ関数の入出力契約のうち userinfo.test.ts と
 * 重複しないもの（成功値、有効期限の境界など）を固定する。
 */
import { describe, it, expect } from 'vitest';
import {
  applyRequestedClaims,
  resolveUserInfoAccessToken,
  resolveUserInfoClaims,
  validateUserInfoAudience,
  validateUserInfoScope,
  validateUserInfoTokenExpiration,
  matchesRequestedClaimValue,
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

describe('resolveUserInfoAccessToken', () => {
  it('should return the stored access token info for a known token', async () => {
    const resolver = createAccessTokenResolver({ 'token-abc': defaultTokenInfo });

    const result = await resolveUserInfoAccessToken('token-abc', resolver);

    expect(result).toEqual(defaultTokenInfo);
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
});

describe('validateUserInfoAudience', () => {
  it('should skip validation when no expected audience is given', () => {
    const error = captureError(() =>
      validateUserInfoAudience({ ...defaultTokenInfo, audience: undefined }, undefined),
    );

    expect(error).toBeUndefined();
  });
});

describe('resolveUserInfoClaims', () => {
  // OIDC Core 1.0 Section 5.3.2: sub in the UserInfo Response MUST exactly match sub in the ID Token
  it('should return the claims of the token subject', async () => {
    const resolver = createUserClaimsResolver({ 'user-123': defaultUserClaims });

    const result = await resolveUserInfoClaims(defaultTokenInfo, resolver);

    expect(result).toEqual(defaultUserClaims);
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

  // OIDC Core Section 5.5.1: not returning a requested claim is not an error
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
});

describe('matchesRequestedClaimValue', () => {
  it('should match any value for a null entry', () => {
    expect(matchesRequestedClaimValue('alice@example.com', null)).toBe(true);
  });

  // OIDC Core 1.0 §5.5.1: value constrains the claim to one value
  it('should match an equal value', () => {
    expect(matchesRequestedClaimValue('alice', { value: 'alice' })).toBe(true);
  });

  it('should not match a different value', () => {
    expect(matchesRequestedClaimValue('bob', { value: 'alice' })).toBe(false);
  });

  it('should match a value listed in values', () => {
    expect(matchesRequestedClaimValue('urn:loa:2', { values: ['urn:loa:1', 'urn:loa:2'] })).toBe(true);
  });

  it('should compare object claims by structure', () => {
    expect(
      matchesRequestedClaimValue({ country: 'JP' }, { value: { country: 'JP' } }),
    ).toBe(true);
  });
});
