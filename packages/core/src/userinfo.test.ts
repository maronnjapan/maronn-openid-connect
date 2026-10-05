import { describe, it, expect, beforeAll } from 'vitest';
import {
  resolveUserInfoAccessToken,
  validateUserInfoTokenExpiration,
  validateUserInfoScope,
  validateUserInfoAudience,
  resolveUserInfoClaims,
  filterClaimsByScope,
  applyRequestedClaims,
  generateUserInfoJwt,
  UserInfoError,
  UserInfoErrorCode,
  SCOPE_CLAIMS_MAP,
} from './userinfo.js';
import type {
  AccessTokenInfo,
  AccessTokenResolver,
  UserClaims,
  UserClaimsResolver,
  UserInfoResponse,
} from './userinfo.js';
import { base64UrlToArrayBuffer, stringToArrayBuffer } from './crypto-utils.js';

// --- Helper: テスト用のAccessTokenResolver ---
function createAccessTokenResolver(
  tokenMap: Record<string, AccessTokenInfo>
): AccessTokenResolver {
  return {
    findAccessToken: async (token: string) => tokenMap[token] ?? null,
  };
}

// --- Helper: テスト用のUserClaimsResolver ---
function createUserClaimsResolver(
  claimsMap: Record<string, UserClaims>
): UserClaimsResolver {
  return {
    findUserClaims: async (sub: string) => claimsMap[sub] ?? null,
  };
}

// --- Helper: 有効なアクセストークン情報 ---
function createValidAccessTokenInfo(
  overrides?: Partial<AccessTokenInfo>
): AccessTokenInfo {
  return {
    sub: 'user-123',
    scope: ['openid', 'profile', 'email'],
    clientId: 'client-456',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

// --- Helper: 全クレームを持つユーザー ---
function createFullUserClaims(overrides?: Partial<UserClaims>): UserClaims {
  return {
    sub: 'user-123',
    // profile scope claims
    name: 'Jane Doe',
    family_name: 'Doe',
    given_name: 'Jane',
    middle_name: 'Marie',
    nickname: 'JD',
    preferred_username: 'j.doe',
    profile: 'https://example.com/janedoe',
    picture: 'https://example.com/janedoe/me.jpg',
    website: 'https://janedoe.example.com',
    gender: 'female',
    birthdate: '1990-10-31',
    zoneinfo: 'America/Los_Angeles',
    locale: 'en-US',
    updated_at: 1311280970,
    // email scope claims
    email: 'janedoe@example.com',
    email_verified: true,
    // address scope claims
    address: {
      formatted: '123 Main St\nAnytown, CA 12345\nUSA',
      street_address: '123 Main St',
      locality: 'Anytown',
      region: 'CA',
      postal_code: '12345',
      country: 'USA',
    },
    // phone scope claims
    phone_number: '+1 (555) 555-5555',
    phone_number_verified: true,
    ...overrides,
  };
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

// OIDC Core 1.0 Section 5.3.1: the access token is sent to the UserInfo Endpoint as a Bearer token
describe('resolveUserInfoAccessToken', () => {
  const accessTokenResolver = createAccessTokenResolver({
    'valid-token': createValidAccessTokenInfo(),
  });

  it('should reject when access token is empty', async () => {
    await expect(resolveUserInfoAccessToken('', accessTokenResolver)).rejects.toThrow(
      UserInfoError
    );
    await expect(resolveUserInfoAccessToken('', accessTokenResolver)).rejects.toMatchObject({
      error: UserInfoErrorCode.InvalidToken,
      errorDescription: 'Access token is required',
    });
  });

  // RFC 6750 Section 3.1: an unknown access token is invalid_token (HTTP 401)
  it('should return invalid_token error when access token is not found', async () => {
    await expect(
      resolveUserInfoAccessToken('unknown-token', accessTokenResolver)
    ).rejects.toBeInstanceOf(UserInfoError);
    await expect(
      resolveUserInfoAccessToken('unknown-token', accessTokenResolver)
    ).rejects.toMatchObject({
      error: UserInfoErrorCode.InvalidToken,
      errorDescription: 'Access token is invalid',
      statusCode: 401,
    });
  });
});

// RFC 6750 Section 3.1: an expired access token is invalid_token (HTTP 401)
describe('validateUserInfoTokenExpiration', () => {
  // When now is omitted, expiresAt is compared with the current Unix time in seconds
  it('should accept an access token that has not expired', () => {
    const tokenInfo = createValidAccessTokenInfo({
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(() => validateUserInfoTokenExpiration(tokenInfo)).not.toThrow();
  });

  it('should return invalid_token error when access token is expired', () => {
    const expiredToken = createValidAccessTokenInfo({
      expiresAt: Math.floor(Date.now() / 1000) - 100,
    });
    const error = captureError(() => validateUserInfoTokenExpiration(expiredToken));
    expect(error).toBeInstanceOf(UserInfoError);
    expect(error).toMatchObject({
      error: UserInfoErrorCode.InvalidToken,
      errorDescription: 'The access token expired',
    });
  });
});

// OIDC Core 1.0 Section 5.3.1: the access token must be obtained from an OpenID Connect
// Authentication Request (openid scope). RFC 6750 Section 3.1: insufficient_scope is HTTP 403.
describe('validateUserInfoScope', () => {
  it('should return insufficient_scope error when openid scope is missing', () => {
    const noOpenidToken = createValidAccessTokenInfo({
      scope: ['profile', 'email'],
    });
    const error = captureError(() => validateUserInfoScope(noOpenidToken));
    expect(error).toBeInstanceOf(UserInfoError);
    expect(error).toMatchObject({
      error: UserInfoErrorCode.InsufficientScope,
      errorDescription: 'The openid scope is required',
      statusCode: 403,
    });
  });
});

// RFC 9068 §4: the resource server (UserInfo) must validate that the access token's
// aud includes an identifier for itself. The generated OP always passes expectedAudience
// (the UserInfo endpoint URL) so validation is on by default for both JWT and opaque tokens.
describe('validateUserInfoAudience', () => {
  const USERINFO_AUD = 'https://op.example.com/userinfo';

  it('should accept a token whose audience includes the UserInfo endpoint', () => {
    const tokenInfo = createValidAccessTokenInfo({
      audience: [USERINFO_AUD, 'https://api.example.com'],
    });
    expect(() => validateUserInfoAudience(tokenInfo, USERINFO_AUD)).not.toThrow();
  });

  it('should reject with invalid_token when audience excludes the UserInfo endpoint', () => {
    const tokenInfo = createValidAccessTokenInfo({
      audience: ['https://api.example.com'],
    });
    const error = captureError(() => validateUserInfoAudience(tokenInfo, USERINFO_AUD));
    expect(error).toBeInstanceOf(UserInfoError);
    expect(error).toMatchObject({
      error: UserInfoErrorCode.InvalidToken,
      errorDescription: 'The access token is not intended for the UserInfo endpoint',
      statusCode: 401,
    });
  });

  it('should skip audience validation only when expectedAudience is not provided', () => {
    // The check needs the resource server's own identifier to compare against; when the
    // caller supplies none there is nothing to validate. The generated OP always passes it.
    const tokenInfo = createValidAccessTokenInfo({
      audience: ['https://api.example.com'],
    });
    expect(() => validateUserInfoAudience(tokenInfo, undefined)).not.toThrow();
  });

  it('should reject with invalid_token when the token has no stored audience', () => {
    // No lenient opaque escape hatch: this OP stores aud (incl. the UserInfo endpoint) for
    // both JWT and opaque access tokens, so a token missing aud is not one this OP issued.
    const tokenInfo = createValidAccessTokenInfo({ audience: undefined });
    const error = captureError(() => validateUserInfoAudience(tokenInfo, USERINFO_AUD));
    expect(error).toBeInstanceOf(UserInfoError);
    expect(error).toMatchObject({
      error: UserInfoErrorCode.InvalidToken,
      errorDescription: 'The access token is not intended for the UserInfo endpoint',
      statusCode: 401,
    });
  });
});

describe('resolveUserInfoClaims', () => {
  it('should return invalid_token error when user is not found', async () => {
    const tokenInfo = createValidAccessTokenInfo();
    const userClaimsResolver = createUserClaimsResolver({});
    await expect(
      resolveUserInfoClaims(tokenInfo, userClaimsResolver)
    ).rejects.toBeInstanceOf(UserInfoError);
    await expect(
      resolveUserInfoClaims(tokenInfo, userClaimsResolver)
    ).rejects.toMatchObject({
      error: UserInfoErrorCode.InvalidToken,
      errorDescription: 'User not found for the given access token',
    });
  });

  // OIDC Core 1.0 Section 5.3.2: sub in the UserInfo Response MUST exactly match sub in the ID Token
  it('should return sub matching the access token subject', async () => {
    const tokenInfo = createValidAccessTokenInfo({ sub: 'user-abc' });
    const userClaimsResolver = createUserClaimsResolver({
      'user-abc': createFullUserClaims({ sub: 'user-abc' }),
    });
    const userClaims = await resolveUserInfoClaims(tokenInfo, userClaimsResolver);
    expect(userClaims.sub).toBe('user-abc');
  });
});

describe('filterClaimsByScope', () => {
  const fullClaims = createFullUserClaims();

  it('should return only sub when only openid scope is present', () => {
    const result = filterClaimsByScope(fullClaims, ['openid']);
    expect(result).toEqual({ sub: 'user-123' });
  });

  it('should include profile claims for profile scope', () => {
    const result = filterClaimsByScope(fullClaims, ['openid', 'profile']);
    expect(result.sub).toBe('user-123');
    expect(result.name).toBe('Jane Doe');
    expect(result.given_name).toBe('Jane');
    expect(result.family_name).toBe('Doe');
    expect(result.updated_at).toBe(1311280970);
  });

  it('should include email claims for email scope', () => {
    const result = filterClaimsByScope(fullClaims, ['openid', 'email']);
    expect(result.sub).toBe('user-123');
    expect(result.email).toBe('janedoe@example.com');
    expect(result.email_verified).toBe(true);
    // Should not include profile claims
    expect(result.name).toBeUndefined();
  });

  it('should include address claim for address scope', () => {
    const result = filterClaimsByScope(fullClaims, ['openid', 'address']);
    expect(result.sub).toBe('user-123');
    expect(result.address).toBeDefined();
    expect(result.address?.street_address).toBe('123 Main St');
  });

  it('should include phone claims for phone scope', () => {
    const result = filterClaimsByScope(fullClaims, ['openid', 'phone']);
    expect(result.sub).toBe('user-123');
    expect(result.phone_number).toBe('+1 (555) 555-5555');
    expect(result.phone_number_verified).toBe(true);
  });

  it('should not include undefined claims in result', () => {
    const sparseUser: UserClaims = { sub: 'sparse' };
    const result = filterClaimsByScope(sparseUser, [
      'openid',
      'profile',
      'email',
    ]);
    expect(result.sub).toBe('sparse');
    expect(Object.keys(result)).toEqual(['sub']);
  });

  describe('Required Claims', () => {
    // OIDC Core 1.0 Section 5.3.2: sub claim MUST always be returned
    it('should always include sub claim', () => {
      const result = filterClaimsByScope(fullClaims, ['openid', 'profile', 'email']);
      expect(result.sub).toBe('user-123');
    });
  });

  describe('Scope-based Claims Filtering', () => {
    // OIDC Core 1.0 Section 5.4: profile scope
    it('should include profile claims when profile scope is granted', () => {
      const result = filterClaimsByScope(fullClaims, ['openid', 'profile']);
      expect(result.name).toBe('Jane Doe');
      expect(result.family_name).toBe('Doe');
      expect(result.given_name).toBe('Jane');
      expect(result.middle_name).toBe('Marie');
      expect(result.nickname).toBe('JD');
      expect(result.preferred_username).toBe('j.doe');
      expect(result.profile).toBe('https://example.com/janedoe');
      expect(result.picture).toBe('https://example.com/janedoe/me.jpg');
      expect(result.website).toBe('https://janedoe.example.com');
      expect(result.gender).toBe('female');
      expect(result.birthdate).toBe('1990-10-31');
      expect(result.zoneinfo).toBe('America/Los_Angeles');
      expect(result.locale).toBe('en-US');
      expect(result.updated_at).toBe(1311280970);
    });

    // OIDC Core 1.0 Section 5.4: email scope
    it('should include email claims when email scope is granted', () => {
      const result = filterClaimsByScope(fullClaims, ['openid', 'email']);
      expect(result.email).toBe('janedoe@example.com');
      expect(result.email_verified).toBe(true);
    });

    // OIDC Core 1.0 Section 5.4: address scope
    it('should include address claim when address scope is granted', () => {
      const result = filterClaimsByScope(fullClaims, ['openid', 'address']);
      expect(result.address).toEqual({
        formatted: '123 Main St\nAnytown, CA 12345\nUSA',
        street_address: '123 Main St',
        locality: 'Anytown',
        region: 'CA',
        postal_code: '12345',
        country: 'USA',
      });
    });

    // OIDC Core 1.0 Section 5.4: phone scope
    it('should include phone claims when phone scope is granted', () => {
      const result = filterClaimsByScope(fullClaims, ['openid', 'phone']);
      expect(result.phone_number).toBe('+1 (555) 555-5555');
      expect(result.phone_number_verified).toBe(true);
    });

    it('should not include profile claims when profile scope is not granted', () => {
      const result = filterClaimsByScope(fullClaims, ['openid']);
      expect(result.sub).toBe('user-123');
      expect(result.name).toBeUndefined();
      expect(result.email).toBeUndefined();
      expect(result.address).toBeUndefined();
      expect(result.phone_number).toBeUndefined();
    });

    it('should not include email claims when email scope is not granted', () => {
      const result = filterClaimsByScope(fullClaims, ['openid', 'profile']);
      expect(result.email).toBeUndefined();
      expect(result.email_verified).toBeUndefined();
    });

    it('should not include address claim when address scope is not granted', () => {
      const result = filterClaimsByScope(fullClaims, ['openid', 'profile']);
      expect(result.address).toBeUndefined();
    });

    it('should not include phone claims when phone scope is not granted', () => {
      const result = filterClaimsByScope(fullClaims, ['openid', 'profile']);
      expect(result.phone_number).toBeUndefined();
      expect(result.phone_number_verified).toBeUndefined();
    });

    // All scopes combined
    it('should include all claims when all scopes are granted', () => {
      const result = filterClaimsByScope(fullClaims, [
        'openid',
        'profile',
        'email',
        'address',
        'phone',
      ]);
      expect(result.sub).toBe('user-123');
      expect(result.name).toBe('Jane Doe');
      expect(result.email).toBe('janedoe@example.com');
      expect(result.address).toEqual({
        formatted: '123 Main St\nAnytown, CA 12345\nUSA',
        street_address: '123 Main St',
        locality: 'Anytown',
        region: 'CA',
        postal_code: '12345',
        country: 'USA',
      });
      expect(result.phone_number).toBe('+1 (555) 555-5555');
    });

    // Claims not set on user should not appear even if scope is granted
    it('should omit claims that user does not have even when scope is granted', () => {
      const sparseUser: UserClaims = {
        sub: 'user-sparse',
        name: 'Sparse User',
        // no other claims
      };
      const result = filterClaimsByScope(sparseUser, [
        'openid',
        'profile',
        'email',
        'phone',
      ]);
      expect(result.sub).toBe('user-sparse');
      expect(result.name).toBe('Sparse User');
      expect(result.family_name).toBeUndefined();
      expect(result.email).toBeUndefined();
      expect(result.phone_number).toBeUndefined();
    });
  });
});

// OIDC Core 1.0 Section 5.5: claims request parameter
// Tests that do not chain filterClaimsByScope pass { sub } as the scoped response,
// which is what filterClaimsByScope returns when only the openid scope is granted.
describe('applyRequestedClaims', () => {
  const fullClaims = createFullUserClaims();

  // The claim is added even though the granted scope (openid only) does not cover it
  it('should include requested claims from claims parameter', () => {
    const scopedResponse = filterClaimsByScope(fullClaims, ['openid']);
    const result = applyRequestedClaims(scopedResponse, fullClaims, {
      userinfo: {
        email: { essential: true },
        given_name: null,
      },
    });
    expect(result.sub).toBe('user-123');
    expect(result.email).toBe('janedoe@example.com');
    expect(result.given_name).toBe('Jane');
  });

  it('should include claims from both scope and claims parameter', () => {
    const scopedResponse = filterClaimsByScope(fullClaims, ['openid', 'profile']);
    const result = applyRequestedClaims(scopedResponse, fullClaims, {
      userinfo: {
        email: { essential: true },
      },
    });
    // From profile scope
    expect(result.name).toBe('Jane Doe');
    // From claims parameter
    expect(result.email).toBe('janedoe@example.com');
  });

  it('should not error when essential claim is not available', () => {
    const sparseUser: UserClaims = {
      sub: 'user-no-email',
    };
    // OIDC Core: Not returning essential claim is not an error
    const result = applyRequestedClaims({ sub: 'user-no-email' }, sparseUser, {
      userinfo: {
        email: { essential: true },
      },
    });
    expect(result.sub).toBe('user-no-email');
    expect(result.email).toBeUndefined();
  });

  it('should ignore claims parameter when userinfo key is absent', () => {
    const result = applyRequestedClaims({ sub: 'user-123' }, fullClaims, {});
    expect(result.sub).toBe('user-123');
    expect(result.email).toBeUndefined();
  });

  // sub is already fixed by the access token subject, so a claims.userinfo request for sub
  // must not replace it. userClaims.sub differs from the scoped response on purpose so that
  // an overwrite would be visible.
  it('should not overwrite sub even when sub is requested in claims parameter', () => {
    const result = applyRequestedClaims(
      { sub: 'user-123' },
      createFullUserClaims({ sub: 'user-other' }),
      { userinfo: { sub: null } }
    );
    expect(result).toEqual({ sub: 'user-123' });
  });

  // OIDC Core 1.0 Section 5.5.1: Individual Claims Requests
  // `value` / `values` request the claim to be returned with specific value(s).
  describe('value / values matching (OIDC Core Section 5.5.1)', () => {
    it('should return email when requested value matches the actual value', () => {
      const result = applyRequestedClaims({ sub: 'user-123' }, fullClaims, {
        userinfo: {
          email: { value: 'janedoe@example.com' },
        },
      });
      expect(result.email).toBe('janedoe@example.com');
    });

    it('should omit email without error when requested value does not match', () => {
      // OIDC Core Section 5.5.1: not returning a requested claim is not an error
      const result = applyRequestedClaims({ sub: 'user-123' }, fullClaims, {
        userinfo: {
          email: { value: 'someone-else@example.com' },
        },
      });
      expect(result.sub).toBe('user-123');
      expect(result.email).toBeUndefined();
    });

    it('should return claim when the actual value is included in requested values', () => {
      const result = applyRequestedClaims({ sub: 'user-123' }, fullClaims, {
        userinfo: {
          email: { values: ['a@example.com', 'janedoe@example.com'] },
        },
      });
      expect(result.email).toBe('janedoe@example.com');
    });

    it('should omit claim without error when the actual value is not included in requested values', () => {
      // OIDC Core Section 5.5.1: not returning a requested claim is not an error
      const result = applyRequestedClaims({ sub: 'user-123' }, fullClaims, {
        userinfo: {
          email: { values: ['a@example.com', 'b@example.com'] },
        },
      });
      expect(result.sub).toBe('user-123');
      expect(result.email).toBeUndefined();
    });

    it('should omit essential claim without error when it is not available', () => {
      const sparseUser: UserClaims = { sub: 'user-no-email' };
      // OIDC Core Section 5.5.1: MUST NOT error even for essential claims
      const result = applyRequestedClaims({ sub: 'user-no-email' }, sparseUser, {
        userinfo: {
          // essential without value constraint
          email: { essential: true },
        },
      });
      expect(result.sub).toBe('user-no-email');
      expect(result.email).toBeUndefined();
    });

    it('should return claim when the request entry is null (no constraint)', () => {
      const result = applyRequestedClaims({ sub: 'user-123' }, fullClaims, {
        userinfo: {
          email: null,
        },
      });
      expect(result.email).toBe('janedoe@example.com');
    });

    it('should not let value constraints affect scope-based claims', () => {
      const scopedResponse = filterClaimsByScope(fullClaims, ['openid', 'email']);
      const result = applyRequestedClaims(scopedResponse, fullClaims, {
        userinfo: {
          // value constraint on given_name only; email comes from scope
          given_name: { value: 'Nonexistent' },
        },
      });
      // email is returned from the email scope, unaffected by given_name constraint
      expect(result.email).toBe('janedoe@example.com');
      // given_name omitted because value did not match
      expect(result.given_name).toBeUndefined();
    });

    // OIDC Core Section 5.5.1: value / values are JSON values, so object
    // claims like `address` must be compared structurally (deep equality).
    describe('object claim matching (e.g. address)', () => {
      const matchingAddress = {
        formatted: '123 Main St\nAnytown, CA 12345\nUSA',
        street_address: '123 Main St',
        locality: 'Anytown',
        region: 'CA',
        postal_code: '12345',
        country: 'USA',
      };

      it('should return address when requested value deeply equals the actual value', () => {
        const result = applyRequestedClaims({ sub: 'user-123' }, fullClaims, {
          userinfo: {
            // key order intentionally differs to verify structural compare
            address: {
              value: {
                country: 'USA',
                region: 'CA',
                postal_code: '12345',
                locality: 'Anytown',
                street_address: '123 Main St',
                formatted: '123 Main St\nAnytown, CA 12345\nUSA',
              },
            },
          },
        });
        expect(result.address).toEqual(matchingAddress);
      });

      it('should omit address without error when requested value does not deeply equal', () => {
        const result = applyRequestedClaims({ sub: 'user-123' }, fullClaims, {
          userinfo: {
            address: {
              value: { ...matchingAddress, locality: 'Othertown' },
            },
          },
        });
        expect(result.sub).toBe('user-123');
        expect(result.address).toBeUndefined();
      });

      it('should return address when actual value is included in requested values', () => {
        const result = applyRequestedClaims({ sub: 'user-123' }, fullClaims, {
          userinfo: {
            address: {
              values: [
                { ...matchingAddress, locality: 'Othertown' },
                matchingAddress,
              ],
            },
          },
        });
        expect(result.address).toEqual(matchingAddress);
      });

      it('should omit address without error when actual value is not included in requested values', () => {
        const result = applyRequestedClaims({ sub: 'user-123' }, fullClaims, {
          userinfo: {
            address: {
              values: [
                { ...matchingAddress, locality: 'Othertown' },
                { ...matchingAddress, country: 'JP' },
              ],
            },
          },
        });
        expect(result.sub).toBe('user-123');
        expect(result.address).toBeUndefined();
      });
    });
  });
});

// OIDC Core 1.0 Section 5.3.3: UserInfo errors follow RFC 6750 Section 3.1
// (invalid_token is HTTP 401, insufficient_scope is HTTP 403)
describe('UserInfoError', () => {
  it('should return 401 status for invalid_token errors', () => {
    const error = new UserInfoError(UserInfoErrorCode.InvalidToken, 'Access token is invalid');
    expect(error.statusCode).toBe(401);
  });

  it('should return 403 status for insufficient_scope errors', () => {
    const error = new UserInfoError(
      UserInfoErrorCode.InsufficientScope,
      'The openid scope is required'
    );
    expect(error.statusCode).toBe(403);
  });

  it('should include error code and error description', () => {
    const error = new UserInfoError(UserInfoErrorCode.InvalidToken, 'Access token is invalid');
    expect(error.error).toBe('invalid_token');
    expect(error.errorDescription).toBe('Access token is invalid');
  });
});

describe('SCOPE_CLAIMS_MAP', () => {
  // OIDC Core 1.0 Section 5.4
  it('should map profile scope to standard profile claims', () => {
    expect(SCOPE_CLAIMS_MAP.profile).toEqual([
      'name',
      'family_name',
      'given_name',
      'middle_name',
      'nickname',
      'preferred_username',
      'profile',
      'picture',
      'website',
      'gender',
      'birthdate',
      'zoneinfo',
      'locale',
      'updated_at',
    ]);
  });

  it('should map email scope to email and email_verified', () => {
    expect(SCOPE_CLAIMS_MAP.email).toEqual(['email', 'email_verified']);
  });

  it('should map address scope to address', () => {
    expect(SCOPE_CLAIMS_MAP.address).toEqual(['address']);
  });

  it('should map phone scope to phone_number and phone_number_verified', () => {
    expect(SCOPE_CLAIMS_MAP.phone).toEqual([
      'phone_number',
      'phone_number_verified',
    ]);
  });
});

// OIDC Core 1.0 Section 5.3.2: Successful UserInfo Response
// "If the UserInfo Response is signed and/or encrypted, then the Claims are
//  returned in a JWT and the content-type MUST be application/jwt."
describe('generateUserInfoJwt', () => {
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
      ['sign', 'verify'],
    );
  });

  function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
    const parts = jwt.split('.');
    const header = JSON.parse(new TextDecoder().decode(base64UrlToArrayBuffer(parts[0]!)));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToArrayBuffer(parts[1]!)));
    return { header, payload };
  }

  const baseResponse: UserInfoResponse = {
    sub: 'user-123',
    name: 'Alice',
    email: 'alice@example.com',
    email_verified: true,
  };

  describe('JWT structure', () => {
    it('should generate a valid JWT with three parts', async () => {
      const jwt = await generateUserInfoJwt(baseResponse, {
        issuer: 'https://op.example.com',
        audience: 'client-1',
        privateKey: rsaKeyPair.privateKey,
      });
      expect(jwt.split('.').length).toBe(3);
    });

    it('should set alg claim to RS256 when signing with RSASSA-PKCS1-v1_5/SHA-256', async () => {
      const jwt = await generateUserInfoJwt(baseResponse, {
        issuer: 'https://op.example.com',
        audience: 'client-1',
        privateKey: rsaKeyPair.privateKey,
      });
      const { header } = decodeJwt(jwt);
      expect(header.alg).toBe('RS256');
    });

    it('should set typ claim to JWT', async () => {
      const jwt = await generateUserInfoJwt(baseResponse, {
        issuer: 'https://op.example.com',
        audience: 'client-1',
        privateKey: rsaKeyPair.privateKey,
      });
      const { header } = decodeJwt(jwt);
      expect(header.typ).toBe('JWT');
    });

    it('should include kid in header when keyId is provided', async () => {
      const jwt = await generateUserInfoJwt(baseResponse, {
        issuer: 'https://op.example.com',
        audience: 'client-1',
        privateKey: rsaKeyPair.privateKey,
        keyId: 'key-1',
      });
      const { header } = decodeJwt(jwt);
      expect(header.kid).toBe('key-1');
    });

    it('should not include kid when keyId is omitted', async () => {
      const jwt = await generateUserInfoJwt(baseResponse, {
        issuer: 'https://op.example.com',
        audience: 'client-1',
        privateKey: rsaKeyPair.privateKey,
      });
      const { header } = decodeJwt(jwt);
      expect(header.kid).toBeUndefined();
    });
  });

  describe('Required claims', () => {
    it('should include iss claim', async () => {
      const jwt = await generateUserInfoJwt(baseResponse, {
        issuer: 'https://op.example.com',
        audience: 'client-1',
        privateKey: rsaKeyPair.privateKey,
      });
      const { payload } = decodeJwt(jwt);
      expect(payload.iss).toBe('https://op.example.com');
    });

    it('should include aud claim matching the client_id', async () => {
      const jwt = await generateUserInfoJwt(baseResponse, {
        issuer: 'https://op.example.com',
        audience: 'client-xyz',
        privateKey: rsaKeyPair.privateKey,
      });
      const { payload } = decodeJwt(jwt);
      expect(payload.aud).toBe('client-xyz');
    });

    it('should include sub claim from UserInfoResponse', async () => {
      const jwt = await generateUserInfoJwt(baseResponse, {
        issuer: 'https://op.example.com',
        audience: 'client-1',
        privateKey: rsaKeyPair.privateKey,
      });
      const { payload } = decodeJwt(jwt);
      expect(payload.sub).toBe('user-123');
    });

    it('should include iat and exp claims', async () => {
      const jwt = await generateUserInfoJwt(baseResponse, {
        issuer: 'https://op.example.com',
        audience: 'client-1',
        privateKey: rsaKeyPair.privateKey,
      });
      const { payload } = decodeJwt(jwt);
      const now = Math.floor(Date.now() / 1000);
      expect(typeof payload.iat).toBe('number');
      expect(payload.iat as number).toBeGreaterThanOrEqual(now - 5);
      expect(payload.iat as number).toBeLessThanOrEqual(now + 5);
      expect(typeof payload.exp).toBe('number');
      expect(payload.exp as number).toBeGreaterThan(payload.iat as number);
    });

    it('should default exp to 1 hour after iat when expiresIn is omitted', async () => {
      const jwt = await generateUserInfoJwt(baseResponse, {
        issuer: 'https://op.example.com',
        audience: 'client-1',
        privateKey: rsaKeyPair.privateKey,
      });
      const { payload } = decodeJwt(jwt);
      expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
    });

    it('should set exp based on expiresIn option', async () => {
      const jwt = await generateUserInfoJwt(baseResponse, {
        issuer: 'https://op.example.com',
        audience: 'client-1',
        privateKey: rsaKeyPair.privateKey,
        expiresIn: 60,
      });
      const { payload } = decodeJwt(jwt);
      expect((payload.exp as number) - (payload.iat as number)).toBe(60);
    });
  });

  describe('Additional claims', () => {
    it('should include additional claims from UserInfoResponse', async () => {
      const jwt = await generateUserInfoJwt(baseResponse, {
        issuer: 'https://op.example.com',
        audience: 'client-1',
        privateKey: rsaKeyPair.privateKey,
      });
      const { payload } = decodeJwt(jwt);
      expect(payload.name).toBe('Alice');
      expect(payload.email).toBe('alice@example.com');
      expect(payload.email_verified).toBe(true);
    });

    it('should preserve nested address claim', async () => {
      const response: UserInfoResponse = {
        sub: 'user-1',
        address: { country: 'JP', locality: 'Tokyo' },
      };
      const jwt = await generateUserInfoJwt(response, {
        issuer: 'https://op.example.com',
        audience: 'client-1',
        privateKey: rsaKeyPair.privateKey,
      });
      const { payload } = decodeJwt(jwt);
      expect(payload.address).toEqual({ country: 'JP', locality: 'Tokyo' });
    });
  });

  describe('Signature', () => {
    it('should produce a verifiable RS256 signature', async () => {
      const jwt = await generateUserInfoJwt(baseResponse, {
        issuer: 'https://op.example.com',
        audience: 'client-1',
        privateKey: rsaKeyPair.privateKey,
      });
      const parts = jwt.split('.');
      const signingInput = `${parts[0]}.${parts[1]}`;
      const signatureBuffer = base64UrlToArrayBuffer(parts[2]!);
      const dataBuffer = stringToArrayBuffer(signingInput);
      const isValid = await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        rsaKeyPair.publicKey,
        signatureBuffer,
        dataBuffer,
      );
      expect(isValid).toBe(true);
    });
  });
});
