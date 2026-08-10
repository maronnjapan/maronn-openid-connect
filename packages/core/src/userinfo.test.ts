import { describe, it, expect, beforeAll } from 'vitest';
import {
  handleUserInfoRequest,
  generateUserInfoJwt,
  UserInfoError,
  UserInfoErrorCode,
  filterClaimsByScope,
  SCOPE_CLAIMS_MAP,
  DEFAULT_REQUESTABLE_CLAIMS,
} from './userinfo.js';
import type {
  AccessTokenInfo,
  AccessTokenResolver,
  UserClaims,
  UserClaimsResolver,
  UserInfoRequestContext,
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

// --- Helper: コンテキスト作成 ---
function createValidContext(
  overrides?: Partial<UserInfoRequestContext>
): UserInfoRequestContext {
  const tokenInfo = createValidAccessTokenInfo();
  const userClaims = createFullUserClaims();

  return {
    accessToken: 'valid-token',
    accessTokenResolver: createAccessTokenResolver({
      'valid-token': tokenInfo,
    }),
    userClaimsResolver: createUserClaimsResolver({
      'user-123': userClaims,
    }),
    ...overrides,
  };
}

describe('handleUserInfoRequest', () => {
  describe('Access Token Validation', () => {
    it('should reject when access token is empty', async () => {
      const context = createValidContext({ accessToken: '' });
      await expect(handleUserInfoRequest(context)).rejects.toThrow(
        UserInfoError
      );
      await expect(handleUserInfoRequest(context)).rejects.toThrow(
        'Access token is required'
      );
    });

    it('should return invalid_token error when access token is not found', async () => {
      const context = createValidContext({
        accessToken: 'unknown-token',
      });
      await expect(handleUserInfoRequest(context)).rejects.toBeInstanceOf(UserInfoError);
      await expect(handleUserInfoRequest(context)).rejects.toMatchObject({
        error: UserInfoErrorCode.InvalidToken,
        statusCode: 401,
      });
    });

    it('should return invalid_token error when access token is expired', async () => {
      const expiredToken = createValidAccessTokenInfo({
        expiresAt: Math.floor(Date.now() / 1000) - 100,
      });
      const context = createValidContext({
        accessToken: 'expired-token',
        accessTokenResolver: createAccessTokenResolver({
          'expired-token': expiredToken,
        }),
      });
      await expect(handleUserInfoRequest(context)).rejects.toBeInstanceOf(UserInfoError);
      await expect(handleUserInfoRequest(context)).rejects.toMatchObject({
        error: UserInfoErrorCode.InvalidToken,
        errorDescription: expect.stringContaining('expired'),
      });
    });

    it('should return insufficient_scope error when openid scope is missing', async () => {
      const noOpenidToken = createValidAccessTokenInfo({
        scope: ['profile', 'email'],
      });
      const context = createValidContext({
        accessToken: 'no-openid-token',
        accessTokenResolver: createAccessTokenResolver({
          'no-openid-token': noOpenidToken,
        }),
      });
      await expect(handleUserInfoRequest(context)).rejects.toBeInstanceOf(UserInfoError);
      await expect(handleUserInfoRequest(context)).rejects.toMatchObject({
        error: UserInfoErrorCode.InsufficientScope,
        statusCode: 403,
      });
    });
  });

  // RFC 9068 §4: the resource server (UserInfo) must validate that the access token's
  // aud includes an identifier for itself. The generated OP always supplies expectedAudience
  // (the UserInfo endpoint URL) so validation is on by default for both JWT and opaque tokens.
  describe('Access Token Audience Validation (RFC 9068 §4)', () => {
    const USERINFO_AUD = 'https://op.example.com/userinfo';

    function contextWithAudience(audience: string[] | undefined, expectedAudience?: string) {
      const tokenInfo = createValidAccessTokenInfo({ audience });
      return createValidContext({
        accessToken: 'aud-token',
        accessTokenResolver: createAccessTokenResolver({ 'aud-token': tokenInfo }),
        expectedAudience,
      });
    }

    it('should accept a token whose audience includes the UserInfo endpoint', async () => {
      const context = contextWithAudience([USERINFO_AUD, 'https://api.example.com'], USERINFO_AUD);
      const response = await handleUserInfoRequest(context);
      expect(response.sub).toBe('user-123');
    });

    it('should reject with invalid_token when audience excludes the UserInfo endpoint', async () => {
      const context = contextWithAudience(['https://api.example.com'], USERINFO_AUD);
      await expect(handleUserInfoRequest(context)).rejects.toMatchObject({
        error: UserInfoErrorCode.InvalidToken,
        statusCode: 401,
      });
    });

    it('should skip audience validation only when expectedAudience is not provided', async () => {
      // The check needs the resource server's own identifier to compare against; when the
      // caller supplies none there is nothing to validate. The generated OP always passes it.
      const context = contextWithAudience(['https://api.example.com'], undefined);
      const response = await handleUserInfoRequest(context);
      expect(response.sub).toBe('user-123');
    });

    it('should reject with invalid_token when the token has no stored audience', async () => {
      // No lenient opaque escape hatch: this OP stores aud (incl. the UserInfo endpoint) for
      // both JWT and opaque access tokens, so a token missing aud is not one this OP issued.
      const context = contextWithAudience(undefined, USERINFO_AUD);
      await expect(handleUserInfoRequest(context)).rejects.toMatchObject({
        error: UserInfoErrorCode.InvalidToken,
        statusCode: 401,
      });
    });
  });

  describe('User Claims Resolution', () => {
    it('should return invalid_token error when user is not found', async () => {
      const context = createValidContext({
        userClaimsResolver: createUserClaimsResolver({}),
      });
      await expect(handleUserInfoRequest(context)).rejects.toBeInstanceOf(UserInfoError);
      await expect(handleUserInfoRequest(context)).rejects.toMatchObject({
        error: UserInfoErrorCode.InvalidToken,
      });
    });
  });

  describe('Required Claims', () => {
    // OIDC Core 1.0 Section 5.3: sub claim is REQUIRED
    it('should always include sub claim', async () => {
      const context = createValidContext();
      const response = await handleUserInfoRequest(context);
      expect(response.sub).toBe('user-123');
    });

    // OIDC Core 1.0 Section 5.3.4: sub MUST match ID Token
    it('should return sub matching the access token subject', async () => {
      const tokenInfo = createValidAccessTokenInfo({ sub: 'user-abc' });
      const userClaims = createFullUserClaims({ sub: 'user-abc' });
      const context = createValidContext({
        accessToken: 'token-abc',
        accessTokenResolver: createAccessTokenResolver({
          'token-abc': tokenInfo,
        }),
        userClaimsResolver: createUserClaimsResolver({
          'user-abc': userClaims,
        }),
      });
      const response = await handleUserInfoRequest(context);
      expect(response.sub).toBe('user-abc');
    });
  });

  describe('Scope-based Claims Filtering', () => {
    // OIDC Core 1.0 Section 5.4: profile scope
    it('should include profile claims when profile scope is granted', async () => {
      const tokenInfo = createValidAccessTokenInfo({
        scope: ['openid', 'profile'],
      });
      const context = createValidContext({
        accessToken: 'profile-token',
        accessTokenResolver: createAccessTokenResolver({
          'profile-token': tokenInfo,
        }),
      });
      const response = await handleUserInfoRequest(context);
      expect(response.name).toBe('Jane Doe');
      expect(response.family_name).toBe('Doe');
      expect(response.given_name).toBe('Jane');
      expect(response.middle_name).toBe('Marie');
      expect(response.nickname).toBe('JD');
      expect(response.preferred_username).toBe('j.doe');
      expect(response.profile).toBe('https://example.com/janedoe');
      expect(response.picture).toBe('https://example.com/janedoe/me.jpg');
      expect(response.website).toBe('https://janedoe.example.com');
      expect(response.gender).toBe('female');
      expect(response.birthdate).toBe('1990-10-31');
      expect(response.zoneinfo).toBe('America/Los_Angeles');
      expect(response.locale).toBe('en-US');
      expect(response.updated_at).toBe(1311280970);
    });

    // OIDC Core 1.0 Section 5.4: email scope
    it('should include email claims when email scope is granted', async () => {
      const tokenInfo = createValidAccessTokenInfo({
        scope: ['openid', 'email'],
      });
      const context = createValidContext({
        accessToken: 'email-token',
        accessTokenResolver: createAccessTokenResolver({
          'email-token': tokenInfo,
        }),
      });
      const response = await handleUserInfoRequest(context);
      expect(response.email).toBe('janedoe@example.com');
      expect(response.email_verified).toBe(true);
    });

    // OIDC Core 1.0 Section 5.4: address scope
    it('should include address claim when address scope is granted', async () => {
      const tokenInfo = createValidAccessTokenInfo({
        scope: ['openid', 'address'],
      });
      const context = createValidContext({
        accessToken: 'address-token',
        accessTokenResolver: createAccessTokenResolver({
          'address-token': tokenInfo,
        }),
      });
      const response = await handleUserInfoRequest(context);
      expect(response.address).toEqual({
        formatted: '123 Main St\nAnytown, CA 12345\nUSA',
        street_address: '123 Main St',
        locality: 'Anytown',
        region: 'CA',
        postal_code: '12345',
        country: 'USA',
      });
    });

    // OIDC Core 1.0 Section 5.4: phone scope
    it('should include phone claims when phone scope is granted', async () => {
      const tokenInfo = createValidAccessTokenInfo({
        scope: ['openid', 'phone'],
      });
      const context = createValidContext({
        accessToken: 'phone-token',
        accessTokenResolver: createAccessTokenResolver({
          'phone-token': tokenInfo,
        }),
      });
      const response = await handleUserInfoRequest(context);
      expect(response.phone_number).toBe('+1 (555) 555-5555');
      expect(response.phone_number_verified).toBe(true);
    });

    it('should not include profile claims when profile scope is not granted', async () => {
      const tokenInfo = createValidAccessTokenInfo({
        scope: ['openid'],
      });
      const context = createValidContext({
        accessToken: 'openid-only-token',
        accessTokenResolver: createAccessTokenResolver({
          'openid-only-token': tokenInfo,
        }),
      });
      const response = await handleUserInfoRequest(context);
      expect(response.sub).toBe('user-123');
      expect(response.name).toBeUndefined();
      expect(response.email).toBeUndefined();
      expect(response.address).toBeUndefined();
      expect(response.phone_number).toBeUndefined();
    });

    it('should not include email claims when email scope is not granted', async () => {
      const tokenInfo = createValidAccessTokenInfo({
        scope: ['openid', 'profile'],
      });
      const context = createValidContext({
        accessToken: 'no-email-token',
        accessTokenResolver: createAccessTokenResolver({
          'no-email-token': tokenInfo,
        }),
      });
      const response = await handleUserInfoRequest(context);
      expect(response.email).toBeUndefined();
      expect(response.email_verified).toBeUndefined();
    });

    it('should not include address claim when address scope is not granted', async () => {
      const tokenInfo = createValidAccessTokenInfo({
        scope: ['openid', 'profile'],
      });
      const context = createValidContext({
        accessToken: 'no-address-token',
        accessTokenResolver: createAccessTokenResolver({
          'no-address-token': tokenInfo,
        }),
      });
      const response = await handleUserInfoRequest(context);
      expect(response.address).toBeUndefined();
    });

    it('should not include phone claims when phone scope is not granted', async () => {
      const tokenInfo = createValidAccessTokenInfo({
        scope: ['openid', 'profile'],
      });
      const context = createValidContext({
        accessToken: 'no-phone-token',
        accessTokenResolver: createAccessTokenResolver({
          'no-phone-token': tokenInfo,
        }),
      });
      const response = await handleUserInfoRequest(context);
      expect(response.phone_number).toBeUndefined();
      expect(response.phone_number_verified).toBeUndefined();
    });

    // All scopes combined
    it('should include all claims when all scopes are granted', async () => {
      const tokenInfo = createValidAccessTokenInfo({
        scope: ['openid', 'profile', 'email', 'address', 'phone'],
      });
      const context = createValidContext({
        accessToken: 'all-scopes-token',
        accessTokenResolver: createAccessTokenResolver({
          'all-scopes-token': tokenInfo,
        }),
      });
      const response = await handleUserInfoRequest(context);
      expect(response.sub).toBe('user-123');
      expect(response.name).toBe('Jane Doe');
      expect(response.email).toBe('janedoe@example.com');
      expect(response.address).toBeDefined();
      expect(response.phone_number).toBe('+1 (555) 555-5555');
    });

    // Claims not set on user should not appear even if scope is granted
    it('should omit claims that user does not have even when scope is granted', async () => {
      const sparseUser: UserClaims = {
        sub: 'user-sparse',
        name: 'Sparse User',
        // no other claims
      };
      const tokenInfo = createValidAccessTokenInfo({
        sub: 'user-sparse',
        scope: ['openid', 'profile', 'email', 'phone'],
      });
      const context = createValidContext({
        accessToken: 'sparse-token',
        accessTokenResolver: createAccessTokenResolver({
          'sparse-token': tokenInfo,
        }),
        userClaimsResolver: createUserClaimsResolver({
          'user-sparse': sparseUser,
        }),
      });
      const response = await handleUserInfoRequest(context);
      expect(response.sub).toBe('user-sparse');
      expect(response.name).toBe('Sparse User');
      expect(response.family_name).toBeUndefined();
      expect(response.email).toBeUndefined();
      expect(response.phone_number).toBeUndefined();
    });
  });

  describe('Claims Request Parameter', () => {
    // OIDC Core 1.0 Section 5.5: claims request parameter
    it('should include requested claims from claims parameter', async () => {
      const tokenInfo = createValidAccessTokenInfo({
        scope: ['openid'],
      });
      const context = createValidContext({
        accessToken: 'claims-param-token',
        accessTokenResolver: createAccessTokenResolver({
          'claims-param-token': tokenInfo,
        }),
        claimsParameter: {
          userinfo: {
            email: { essential: true },
            given_name: null,
          },
        },
      });
      const response = await handleUserInfoRequest(context);
      expect(response.sub).toBe('user-123');
      expect(response.email).toBe('janedoe@example.com');
      expect(response.given_name).toBe('Jane');
    });

    it('should include claims from both scope and claims parameter', async () => {
      const tokenInfo = createValidAccessTokenInfo({
        scope: ['openid', 'profile'],
      });
      const context = createValidContext({
        accessToken: 'both-token',
        accessTokenResolver: createAccessTokenResolver({
          'both-token': tokenInfo,
        }),
        claimsParameter: {
          userinfo: {
            email: { essential: true },
          },
        },
      });
      const response = await handleUserInfoRequest(context);
      // From profile scope
      expect(response.name).toBe('Jane Doe');
      // From claims parameter
      expect(response.email).toBe('janedoe@example.com');
    });

    it('should not error when essential claim is not available', async () => {
      const sparseUser: UserClaims = {
        sub: 'user-no-email',
      };
      const tokenInfo = createValidAccessTokenInfo({
        sub: 'user-no-email',
        scope: ['openid'],
      });
      const context = createValidContext({
        accessToken: 'no-essential-token',
        accessTokenResolver: createAccessTokenResolver({
          'no-essential-token': tokenInfo,
        }),
        userClaimsResolver: createUserClaimsResolver({
          'user-no-email': sparseUser,
        }),
        claimsParameter: {
          userinfo: {
            email: { essential: true },
          },
        },
      });
      // OIDC Core: Not returning essential claim is not an error
      const response = await handleUserInfoRequest(context);
      expect(response.sub).toBe('user-no-email');
      expect(response.email).toBeUndefined();
    });

    it('should ignore claims parameter when userinfo key is absent', async () => {
      const tokenInfo = createValidAccessTokenInfo({
        scope: ['openid'],
      });
      const context = createValidContext({
        accessToken: 'no-userinfo-key-token',
        accessTokenResolver: createAccessTokenResolver({
          'no-userinfo-key-token': tokenInfo,
        }),
        claimsParameter: {},
      });
      const response = await handleUserInfoRequest(context);
      expect(response.sub).toBe('user-123');
      expect(response.email).toBeUndefined();
    });

    // OIDC Core 1.0 Section 5.5.1: Individual Claims Requests
    // `value` / `values` request the claim to be returned with specific value(s).
    describe('value / values matching (OIDC Core Section 5.5.1)', () => {
      it('should return email when requested value matches the actual value', async () => {
        const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
        const context = createValidContext({
          accessToken: 'value-match-token',
          accessTokenResolver: createAccessTokenResolver({
            'value-match-token': tokenInfo,
          }),
          claimsParameter: {
            userinfo: {
              email: { value: 'janedoe@example.com' },
            },
          },
        });
        const response = await handleUserInfoRequest(context);
        expect(response.email).toBe('janedoe@example.com');
      });

      it('should omit email without error when requested value does not match', async () => {
        const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
        const context = createValidContext({
          accessToken: 'value-mismatch-token',
          accessTokenResolver: createAccessTokenResolver({
            'value-mismatch-token': tokenInfo,
          }),
          claimsParameter: {
            userinfo: {
              email: { value: 'someone-else@example.com' },
            },
          },
        });
        // OIDC Core Section 5.5.1: not returning a requested claim is not an error
        const response = await handleUserInfoRequest(context);
        expect(response.sub).toBe('user-123');
        expect(response.email).toBeUndefined();
      });

      it('should return claim when the actual value is included in requested values', async () => {
        const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
        const context = createValidContext({
          accessToken: 'values-include-token',
          accessTokenResolver: createAccessTokenResolver({
            'values-include-token': tokenInfo,
          }),
          claimsParameter: {
            userinfo: {
              email: { values: ['a@example.com', 'janedoe@example.com'] },
            },
          },
        });
        const response = await handleUserInfoRequest(context);
        expect(response.email).toBe('janedoe@example.com');
      });

      it('should omit claim without error when the actual value is not included in requested values', async () => {
        const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
        const context = createValidContext({
          accessToken: 'values-exclude-token',
          accessTokenResolver: createAccessTokenResolver({
            'values-exclude-token': tokenInfo,
          }),
          claimsParameter: {
            userinfo: {
              email: { values: ['a@example.com', 'b@example.com'] },
            },
          },
        });
        // OIDC Core Section 5.5.1: not returning a requested claim is not an error
        const response = await handleUserInfoRequest(context);
        expect(response.sub).toBe('user-123');
        expect(response.email).toBeUndefined();
      });

      it('should omit essential claim without error when it is not available', async () => {
        const sparseUser: UserClaims = { sub: 'user-no-email' };
        const tokenInfo = createValidAccessTokenInfo({
          sub: 'user-no-email',
          scope: ['openid'],
        });
        const context = createValidContext({
          accessToken: 'essential-no-value-token',
          accessTokenResolver: createAccessTokenResolver({
            'essential-no-value-token': tokenInfo,
          }),
          userClaimsResolver: createUserClaimsResolver({
            'user-no-email': sparseUser,
          }),
          claimsParameter: {
            userinfo: {
              // essential without value constraint
              email: { essential: true },
            },
          },
        });
        // OIDC Core Section 5.5.1: MUST NOT error even for essential claims
        const response = await handleUserInfoRequest(context);
        expect(response.sub).toBe('user-no-email');
        expect(response.email).toBeUndefined();
      });

      it('should return claim as before when the request entry is null (no constraint)', async () => {
        const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
        const context = createValidContext({
          accessToken: 'null-entry-token',
          accessTokenResolver: createAccessTokenResolver({
            'null-entry-token': tokenInfo,
          }),
          claimsParameter: {
            userinfo: {
              email: null,
            },
          },
        });
        const response = await handleUserInfoRequest(context);
        expect(response.email).toBe('janedoe@example.com');
      });

      it('should not let value constraints affect scope-based claims', async () => {
        const tokenInfo = createValidAccessTokenInfo({
          scope: ['openid', 'email'],
        });
        const context = createValidContext({
          accessToken: 'scope-not-affected-token',
          accessTokenResolver: createAccessTokenResolver({
            'scope-not-affected-token': tokenInfo,
          }),
          claimsParameter: {
            userinfo: {
              // value constraint on given_name only; email comes from scope
              given_name: { value: 'Nonexistent' },
            },
          },
        });
        const response = await handleUserInfoRequest(context);
        // email is returned from the email scope, unaffected by given_name constraint
        expect(response.email).toBe('janedoe@example.com');
        // given_name omitted because value did not match
        expect(response.given_name).toBeUndefined();
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

        it('should return address when requested value deeply equals the actual value', async () => {
          const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
          const context = createValidContext({
            accessToken: 'address-value-match-token',
            accessTokenResolver: createAccessTokenResolver({
              'address-value-match-token': tokenInfo,
            }),
            claimsParameter: {
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
            },
          });
          const response = await handleUserInfoRequest(context);
          expect(response.address).toEqual(matchingAddress);
        });

        it('should omit address without error when requested value does not deeply equal', async () => {
          const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
          const context = createValidContext({
            accessToken: 'address-value-mismatch-token',
            accessTokenResolver: createAccessTokenResolver({
              'address-value-mismatch-token': tokenInfo,
            }),
            claimsParameter: {
              userinfo: {
                address: {
                  value: { ...matchingAddress, locality: 'Othertown' },
                },
              },
            },
          });
          const response = await handleUserInfoRequest(context);
          expect(response.sub).toBe('user-123');
          expect(response.address).toBeUndefined();
        });

        it('should return address when actual value is included in requested values', async () => {
          const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
          const context = createValidContext({
            accessToken: 'address-values-include-token',
            accessTokenResolver: createAccessTokenResolver({
              'address-values-include-token': tokenInfo,
            }),
            claimsParameter: {
              userinfo: {
                address: {
                  values: [
                    { ...matchingAddress, locality: 'Othertown' },
                    matchingAddress,
                  ],
                },
              },
            },
          });
          const response = await handleUserInfoRequest(context);
          expect(response.address).toEqual(matchingAddress);
        });

        it('should omit address without error when actual value is not included in requested values', async () => {
          const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
          const context = createValidContext({
            accessToken: 'address-values-exclude-token',
            accessTokenResolver: createAccessTokenResolver({
              'address-values-exclude-token': tokenInfo,
            }),
            claimsParameter: {
              userinfo: {
                address: {
                  values: [
                    { ...matchingAddress, locality: 'Othertown' },
                    { ...matchingAddress, country: 'JP' },
                  ],
                },
              },
            },
          });
          const response = await handleUserInfoRequest(context);
          expect(response.sub).toBe('user-123');
          expect(response.address).toBeUndefined();
        });
      });
    });

    // OIDC Core 1.0 Section 5.5.1: the OP MUST NOT return an error when a requested
    // claim cannot be provided, so restricting the readable claim names to the OP's
    // declared vocabulary is always spec compliant.
    // The `claims` member names are RP-controlled, so reading them off the resolver's
    // return value without a check would expose whatever surplus fields the user's
    // findUserClaims() happens to carry (a DB row, an internal model).
    describe('Claim Name Allowlist (OIDC Core Section 5.5.1)', () => {
      it('should return a standard claim requested via the claims parameter', async () => {
        const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
        const context = createValidContext({
          accessToken: 'allowlist-standard-token',
          accessTokenResolver: createAccessTokenResolver({
            'allowlist-standard-token': tokenInfo,
          }),
          claimsParameter: { userinfo: { email: null } },
        });

        const response = await handleUserInfoRequest(context);

        expect(response).toEqual({
          sub: 'user-123',
          email: 'janedoe@example.com',
        });
      });

      it('should not return a non-standard property present on the resolved user claims', async () => {
        // A resolver that returns its internal user model verbatim — the most natural
        // PoC implementation — must not turn `claims` into an arbitrary field reader.
        const leakyUserClaims = {
          sub: 'user-123',
          email: 'janedoe@example.com',
          password_hash: '$2b$12$notarealhash',
        } as UserClaims;
        const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
        const context = createValidContext({
          accessToken: 'allowlist-surplus-token',
          accessTokenResolver: createAccessTokenResolver({
            'allowlist-surplus-token': tokenInfo,
          }),
          userClaimsResolver: createUserClaimsResolver({
            'user-123': leakyUserClaims,
          }),
          claimsParameter: {
            userinfo: { email: null, password_hash: null },
          },
        });

        const response = await handleUserInfoRequest(context);

        expect(response).toEqual({
          sub: 'user-123',
          email: 'janedoe@example.com',
        });
      });

      it('should not return a prototype chain property when requested as a claim', async () => {
        const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
        const context = createValidContext({
          accessToken: 'allowlist-prototype-token',
          accessTokenResolver: createAccessTokenResolver({
            'allowlist-prototype-token': tokenInfo,
          }),
          claimsParameter: {
            userinfo: { constructor: null, toString: null },
          },
        });

        const response = await handleUserInfoRequest(context);

        expect(response).toEqual({ sub: 'user-123' });
      });

      it('should not alter the response prototype when __proto__ is requested as a claim', async () => {
        // `{ __proto__: null }` in an object literal sets the prototype instead of
        // creating an own key, so define the key explicitly to reproduce what a
        // JSON-parsed `claims` parameter carrying "__proto__" looks like.
        const requestedUserinfoClaims: Record<string, null> = {};
        Object.defineProperty(requestedUserinfoClaims, '__proto__', {
          value: null,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
        const context = createValidContext({
          accessToken: 'allowlist-proto-token',
          accessTokenResolver: createAccessTokenResolver({
            'allowlist-proto-token': tokenInfo,
          }),
          claimsParameter: { userinfo: requestedUserinfoClaims },
        });

        const response = await handleUserInfoRequest(context);

        expect(response).toEqual({ sub: 'user-123' });
        expect(Object.getPrototypeOf(response)).toBe(Object.prototype);
      });

      it('should return only claims within an explicitly supplied allowlist', async () => {
        const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
        const context = createValidContext({
          accessToken: 'allowlist-explicit-token',
          accessTokenResolver: createAccessTokenResolver({
            'allowlist-explicit-token': tokenInfo,
          }),
          allowedClaimNames: new Set(['sub', 'email']),
          claimsParameter: { userinfo: { email: null, name: null } },
        });

        const response = await handleUserInfoRequest(context);

        expect(response).toEqual({
          sub: 'user-123',
          email: 'janedoe@example.com',
        });
      });

      // OIDC Core 1.0 Section 5.5.1: "the OP MUST NOT return an error" when the
      // requested Claim cannot be returned — including when the OP declines to.
      it('should not return an error when a requested claim is not allowed', async () => {
        const tokenInfo = createValidAccessTokenInfo({ scope: ['openid'] });
        const context = createValidContext({
          accessToken: 'allowlist-no-error-token',
          accessTokenResolver: createAccessTokenResolver({
            'allowlist-no-error-token': tokenInfo,
          }),
          allowedClaimNames: new Set(['sub']),
          claimsParameter: {
            userinfo: { email: { essential: true } },
          },
        });

        await expect(handleUserInfoRequest(context)).resolves.toEqual({
          sub: 'user-123',
        });
      });
    });
  });

  describe('Error Responses', () => {
    it('should return 401 status for invalid_token errors', async () => {
      const context = createValidContext({
        accessToken: 'unknown-token',
      });
      await expect(handleUserInfoRequest(context)).rejects.toMatchObject({ statusCode: 401 });
    });

    it('should return 403 status for insufficient_scope errors', async () => {
      const noOpenidToken = createValidAccessTokenInfo({
        scope: ['profile'],
      });
      const context = createValidContext({
        accessToken: 'no-openid',
        accessTokenResolver: createAccessTokenResolver({
          'no-openid': noOpenidToken,
        }),
      });
      await expect(handleUserInfoRequest(context)).rejects.toMatchObject({ statusCode: 403 });
    });

    it('should include error code in UserInfoError', async () => {
      const context = createValidContext({
        accessToken: 'bad-token',
      });
      await expect(handleUserInfoRequest(context)).rejects.toMatchObject({
        error: expect.anything(),
        errorDescription: expect.anything(),
      });
    });
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

// OIDC Core 1.0 Section 5.1 / 5.1.2: claim names are a vocabulary the OP defines and
// publishes. The default requestable set is exactly `sub` plus every claim the OP can
// already return through a scope (SCOPE_CLAIMS_MAP), so enabling the allowlist does not
// remove any claim that was previously reachable via the `claims` parameter.
describe('DEFAULT_REQUESTABLE_CLAIMS', () => {
  it('should contain sub followed by every scope-mapped claim name', () => {
    expect([...DEFAULT_REQUESTABLE_CLAIMS]).toEqual([
      'sub',
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
      'email',
      'email_verified',
      'address',
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
