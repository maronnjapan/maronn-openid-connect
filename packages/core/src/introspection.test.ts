import { describe, it, expect } from 'vitest';
import {
  buildIntrospectionResponse,
  INACTIVE_INTROSPECTION_RESPONSE,
  IntrospectionError,
  IntrospectionErrorCode,
  isIntrospectionTokenActive,
  requireIntrospectionClient,
  requireIntrospectionToken,
  resolveIntrospectionToken,
  type IntrospectionAccessTokenResolver,
  type IntrospectionRefreshTokenResolver,
} from './introspection.js';
import type { AccessTokenInfo } from './userinfo.js';
import type { RefreshTokenInfo } from './token-request.js';

const ISSUER = 'https://op.example.com';
const CLIENT_ID = 'client-1';
const NOW = 1_700_000_000;

// Each resolver appends `access:<token>` / `refresh:<token>` to `lookups`, so a
// test can assert which stores were searched and in which order.
function makeAccessTokenResolver(
  store: Map<string, AccessTokenInfo>,
  lookups: string[] = [],
): IntrospectionAccessTokenResolver {
  return {
    async findAccessToken(token) {
      lookups.push(`access:${token}`);
      return store.get(token) ?? null;
    },
  };
}

function makeRefreshTokenResolver(
  store: Map<string, RefreshTokenInfo>,
  lookups: string[] = [],
): IntrospectionRefreshTokenResolver {
  return {
    async resolve(token) {
      lookups.push(`refresh:${token}`);
      return store.get(token) ?? null;
    },
  };
}

/** An access token that is still valid at NOW; each test overrides what it checks. */
function accessToken(overrides: Partial<AccessTokenInfo> = {}): AccessTokenInfo {
  return {
    sub: 'alice',
    scope: ['openid'],
    clientId: CLIENT_ID,
    expiresAt: NOW + 60,
    ...overrides,
  };
}

/** An unused refresh token that is still valid at NOW; each test overrides what it checks. */
function refreshToken(overrides: Partial<RefreshTokenInfo> = {}): RefreshTokenInfo {
  return {
    subject: 'alice',
    clientId: CLIENT_ID,
    scope: ['openid'],
    expiresAt: NOW + 86400,
    used: false,
    grantId: 'g1',
    originalIssuedAt: NOW,
    authTime: NOW,
    ...overrides,
  };
}

/** Returns the IntrospectionError thrown by a step, or undefined when it does not throw. */
function captureError(fn: () => unknown): IntrospectionError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as IntrospectionError;
  }
}

// RFC 7662 §2.1: token is REQUIRED.
describe('requireIntrospectionToken', () => {
  it('should reject when token parameter is missing', () => {
    const error = captureError(() => requireIntrospectionToken({}));

    expect(error).toBeInstanceOf(IntrospectionError);
    expect(error?.error).toBe(IntrospectionErrorCode.InvalidRequest);
    expect(error?.errorDescription).toBe('Missing required parameter: token');
    expect(error?.statusCode).toBe(400);
    expect(error?.wwwAuthenticate).toBeUndefined();
  });
});

// RFC 7662 §2.1: the introspection endpoint requires client authentication.
describe('requireIntrospectionClient', () => {
  it('should reject when authenticatedClientId is empty', () => {
    const error = captureError(() => requireIntrospectionClient(''));

    expect(error).toBeInstanceOf(IntrospectionError);
    expect(error?.error).toBe(IntrospectionErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client authentication required');
    expect(error?.statusCode).toBe(401);
    expect(error?.wwwAuthenticate).toBe('Basic realm="Client Authentication"');
  });
});

describe('resolveIntrospectionToken', () => {
  // RFC 7662 §2.1: token_type_hint only reorders the lookup. When the hinted
  // store misses, the other store is still searched.
  describe('Token type hint behavior', () => {
    it('should look up access tokens first when hint=access_token', async () => {
      const lookups: string[] = [];
      const shared = accessToken();

      const result = await resolveIntrospectionToken({
        token: 'shared',
        tokenTypeHint: 'access_token',
        accessTokenResolver: makeAccessTokenResolver(new Map([['shared', shared]]), lookups),
        refreshTokenResolver: makeRefreshTokenResolver(new Map(), lookups),
      });

      expect(result).toEqual({ tokenType: 'access_token', accessToken: shared });
      expect(lookups).toEqual(['access:shared']);
    });

    it('should look up refresh tokens first when hint=refresh_token', async () => {
      const lookups: string[] = [];
      const shared = refreshToken({ grantId: 'g' });

      const result = await resolveIntrospectionToken({
        token: 'shared',
        tokenTypeHint: 'refresh_token',
        accessTokenResolver: makeAccessTokenResolver(new Map(), lookups),
        refreshTokenResolver: makeRefreshTokenResolver(new Map([['shared', shared]]), lookups),
      });

      expect(result).toEqual({ tokenType: 'refresh_token', refreshToken: shared });
      expect(lookups).toEqual(['refresh:shared']);
    });

    it('should ignore unknown token_type_hint and fall back to access-first lookup', async () => {
      const lookups: string[] = [];
      const shared = accessToken();

      const result = await resolveIntrospectionToken({
        token: 'shared',
        tokenTypeHint: 'totally_made_up',
        accessTokenResolver: makeAccessTokenResolver(new Map([['shared', shared]]), lookups),
        refreshTokenResolver: makeRefreshTokenResolver(new Map(), lookups),
      });

      expect(result).toEqual({ tokenType: 'access_token', accessToken: shared });
      expect(lookups).toEqual(['access:shared']);
    });

    it('should return null only after both lookups fail', async () => {
      const lookups: string[] = [];

      const result = await resolveIntrospectionToken({
        token: 'missing',
        accessTokenResolver: makeAccessTokenResolver(new Map(), lookups),
        refreshTokenResolver: makeRefreshTokenResolver(new Map(), lookups),
      });

      expect(result).toBeNull();
      expect(lookups).toEqual(['access:missing', 'refresh:missing']);
    });
  });

  describe('Unknown token', () => {
    it('should return null when access token does not exist', async () => {
      // Lookup is by exact token value: another stored token does not match.
      const result = await resolveIntrospectionToken({
        token: 'unknown',
        accessTokenResolver: makeAccessTokenResolver(new Map([['AT-other', accessToken()]])),
        refreshTokenResolver: makeRefreshTokenResolver(new Map()),
      });

      expect(result).toBeNull();
    });
  });

  describe('Without refreshTokenResolver', () => {
    it('should resolve access tokens and skip refresh token lookup', async () => {
      const lookups: string[] = [];
      const stored = accessToken();

      const result = await resolveIntrospectionToken({
        token: 'AT',
        accessTokenResolver: makeAccessTokenResolver(new Map([['AT', stored]]), lookups),
      });

      expect(result).toEqual({ tokenType: 'access_token', accessToken: stored });
      expect(lookups).toEqual(['access:AT']);
    });
  });
});

describe('isIntrospectionTokenActive', () => {
  describe('Access token', () => {
    it('should return true for an access token that has not expired', () => {
      const result = isIntrospectionTokenActive(
        { tokenType: 'access_token', accessToken: accessToken({ expiresAt: NOW + 1000 }) },
        NOW,
      );

      expect(result).toBe(true);
    });

    // RFC 7519 §4.1.5 / RFC 7662 §2.2: a token with an nbf ("not before") in the
    // future is not yet valid, so introspection MUST report it inactive. This applies
    // to both JWT and opaque tokens because introspection reads the stored token info.
    it('should return true when the access token nbf is not in the future', () => {
      const result = isIntrospectionTokenActive(
        {
          tokenType: 'access_token',
          accessToken: accessToken({ expiresAt: NOW + 1000, iat: NOW, nbf: NOW }),
        },
        NOW,
      );

      expect(result).toBe(true);
    });

    it('should return false when the access token nbf is in the future', () => {
      const result = isIntrospectionTokenActive(
        {
          tokenType: 'access_token',
          accessToken: accessToken({ expiresAt: NOW + 1000, iat: NOW, nbf: NOW + 500 }),
        },
        NOW,
      );

      expect(result).toBe(false);
    });

    it('should return false when access token has expired', () => {
      const result = isIntrospectionTokenActive(
        { tokenType: 'access_token', accessToken: accessToken({ expiresAt: NOW - 1 }) },
        NOW,
      );

      expect(result).toBe(false);
    });
  });

  describe('Refresh token', () => {
    it('should return true for an unused refresh token that has not expired', () => {
      const result = isIntrospectionTokenActive(
        { tokenType: 'refresh_token', refreshToken: refreshToken({ expiresAt: NOW + 86400 }) },
        NOW,
      );

      expect(result).toBe(true);
    });

    it('should return false when refresh token has been used (rotated)', () => {
      const result = isIntrospectionTokenActive(
        { tokenType: 'refresh_token', refreshToken: refreshToken({ used: true }) },
        NOW,
      );

      expect(result).toBe(false);
    });

    it('should return false when refresh token has expired', () => {
      const result = isIntrospectionTokenActive(
        { tokenType: 'refresh_token', refreshToken: refreshToken({ expiresAt: NOW - 1 }) },
        NOW,
      );

      expect(result).toBe(false);
    });
  });
});

// RFC 7662 §2.2: the response for an active token carries the stored claims.
describe('buildIntrospectionResponse', () => {
  describe('Access token', () => {
    it('should return active=true with scope, client_id, sub, exp, iat, aud, iss, token_type', () => {
      const response = buildIntrospectionResponse({
        tokenType: 'access_token',
        accessToken: {
          sub: 'alice',
          scope: ['openid', 'profile'],
          clientId: CLIENT_ID,
          expiresAt: NOW + 1000,
          iat: NOW,
          audience: ['https://api.example.com'],
          issuer: ISSUER,
        },
      });

      expect(response).toEqual({
        active: true,
        scope: 'openid profile',
        client_id: CLIENT_ID,
        sub: 'alice',
        token_type: 'Bearer',
        iss: ISSUER,
        iat: NOW,
        exp: NOW + 1000,
        aud: ['https://api.example.com'],
      });
    });

    // RFC 7662 §2.2: nbf is an OPTIONAL response member, echoed when stored.
    it('should echo nbf when the token carries one', () => {
      const response = buildIntrospectionResponse({
        tokenType: 'access_token',
        accessToken: accessToken({ expiresAt: NOW + 1000, iat: NOW, nbf: NOW }),
      });

      expect(response).toEqual({
        active: true,
        scope: 'openid',
        client_id: CLIENT_ID,
        sub: 'alice',
        token_type: 'Bearer',
        iat: NOW,
        nbf: NOW,
        exp: NOW + 1000,
      });
    });

    it('should omit optional claims that are not stored', () => {
      const response = buildIntrospectionResponse({
        tokenType: 'access_token',
        accessToken: accessToken({ expiresAt: NOW + 60 }),
      });

      // active, scope, client_id, token_type, sub, exp は出るが iat/nbf/aud/iss/jti は無い
      expect(response).toEqual({
        active: true,
        scope: 'openid',
        client_id: CLIENT_ID,
        sub: 'alice',
        token_type: 'Bearer',
        exp: NOW + 60,
      });
    });

    // RFC 7662 §2.1: caller is typically a protected resource that may need to
    // introspect tokens issued to other clients. Ownership match is NOT a
    // requirement of the spec, so the response reports the token's own client_id.
    it('should return active=true even when access token belongs to a different client', () => {
      const response = buildIntrospectionResponse({
        tokenType: 'access_token',
        accessToken: accessToken({ sub: 'bob', clientId: 'other-client', expiresAt: NOW + 1000 }),
      });

      expect(response).toEqual({
        active: true,
        scope: 'openid',
        client_id: 'other-client',
        sub: 'bob',
        token_type: 'Bearer',
        exp: NOW + 1000,
      });
    });
  });

  describe('Refresh token', () => {
    it('should return active=true with token_type=refresh_token', () => {
      const response = buildIntrospectionResponse({
        tokenType: 'refresh_token',
        refreshToken: refreshToken({
          scope: ['openid', 'offline_access'],
          expiresAt: NOW + 86400,
          iat: NOW,
          issuer: ISSUER,
        }),
      });

      expect(response).toEqual({
        active: true,
        token_type: 'refresh_token',
        scope: 'openid offline_access',
        client_id: CLIENT_ID,
        sub: 'alice',
        iss: ISSUER,
        iat: NOW,
        exp: NOW + 86400,
      });
    });

    // RFC 7662 §2.1: same as access tokens, refresh tokens issued to other
    // clients are reported active=true to support the protected-resource model.
    it('should return active=true even when refresh token belongs to a different client', () => {
      const response = buildIntrospectionResponse({
        tokenType: 'refresh_token',
        refreshToken: refreshToken({ subject: 'bob', clientId: 'other-client', grantId: 'g2' }),
      });

      expect(response).toEqual({
        active: true,
        token_type: 'refresh_token',
        scope: 'openid',
        client_id: 'other-client',
        sub: 'bob',
        exp: NOW + 86400,
      });
    });
  });
});

// RFC 7662 §2.2: a token that is inactive or unknown is answered with "active"
// set to false and nothing else, so the response does not reveal why.
describe('INACTIVE_INTROSPECTION_RESPONSE', () => {
  it('should consist of active=false only', () => {
    expect(INACTIVE_INTROSPECTION_RESPONSE).toStrictEqual({ active: false });
  });
});
