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
  type ResolvedRevocationToken,
  type RevocationTokenResolvers,
} from './revocation.js';
import type { AccessTokenInfo } from './userinfo.js';
import type { RefreshTokenInfo } from './token-request.js';

const CLIENT_ID = 'client-1';
const NOW = 1_700_000_000;

interface Recorder {
  /** `access:<token>` / `refresh:<token>` for each store lookup, in call order */
  lookups: string[];
  revokedAccessTokens: string[];
  revokedRefreshTokens: string[];
  revokedGrants: string[];
}

function makeResolvers(
  access: Map<string, AccessTokenInfo>,
  refresh: Map<string, RefreshTokenInfo>,
): { resolvers: RevocationTokenResolvers; recorder: Recorder } {
  const recorder: Recorder = {
    lookups: [],
    revokedAccessTokens: [],
    revokedRefreshTokens: [],
    revokedGrants: [],
  };
  const resolvers: RevocationTokenResolvers = {
    async findAccessToken(token) {
      recorder.lookups.push(`access:${token}`);
      return access.get(token) ?? null;
    },
    async revokeAccessToken(token) {
      recorder.revokedAccessTokens.push(token);
      access.delete(token);
    },
    async findRefreshToken(token) {
      recorder.lookups.push(`refresh:${token}`);
      return refresh.get(token) ?? null;
    },
    async revokeRefreshToken(token) {
      recorder.revokedRefreshTokens.push(token);
      refresh.delete(token);
    },
    async revokeAccessTokensByGrantId(grantId) {
      recorder.revokedGrants.push(grantId);
      for (const [token, info] of access) {
        if (info.grantId === grantId) access.delete(token);
      }
    },
  };
  return { resolvers, recorder };
}

function accessToken(overrides: Partial<AccessTokenInfo> = {}): AccessTokenInfo {
  return {
    sub: 'alice',
    scope: ['openid'],
    clientId: CLIENT_ID,
    expiresAt: NOW + 60,
    ...overrides,
  };
}

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

/** Returns the RevocationError thrown by a step, or undefined when it does not throw. */
function captureError(fn: () => unknown): RevocationError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as RevocationError;
  }
}

// RFC 7009 §2.1: token is REQUIRED.
describe('requireRevocationToken', () => {
  it('should reject when token parameter is missing', () => {
    const error = captureError(() => requireRevocationToken({}));

    expect(error).toBeInstanceOf(RevocationError);
    expect(error?.error).toBe(RevocationErrorCode.InvalidRequest);
    expect(error?.errorDescription).toBe('Missing required parameter: token');
    expect(error?.statusCode).toBe(400);
    expect(error?.wwwAuthenticate).toBeUndefined();
  });
});

// RFC 7009 §2.1: the revocation endpoint must identify the requesting client.
describe('requireRevocationClient', () => {
  it('should reject when authenticatedClientId is empty', () => {
    const error = captureError(() => requireRevocationClient(''));

    expect(error).toBeInstanceOf(RevocationError);
    expect(error?.error).toBe(RevocationErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client authentication required');
    expect(error?.statusCode).toBe(401);
    expect(error?.wwwAuthenticate).toBe('Basic realm="Client Authentication"');
  });
});

describe('resolveRevocationTarget', () => {
  // RFC 7009 §2.1: token_type_hint only reorders the lookup. When the hinted
  // store misses, the other store is still searched.
  describe('Token type hint behavior', () => {
    it('should look up access tokens first when hint=access_token', async () => {
      const shared = accessToken({ sub: 'a' });
      const { resolvers, recorder } = makeResolvers(new Map([['shared', shared]]), new Map());

      const resolved = await resolveRevocationTarget({
        token: 'shared',
        tokenTypeHint: 'access_token',
        resolvers,
      });

      expect(resolved).toEqual({ tokenType: 'access_token', accessToken: shared });
      expect(recorder.lookups).toEqual(['access:shared']);
    });

    it('should fall back to refresh token search when hint=access_token misses', async () => {
      const shared = refreshToken({ subject: 'a', expiresAt: NOW + 60, grantId: 'g' });
      const { resolvers, recorder } = makeResolvers(new Map(), new Map([['shared', shared]]));

      const resolved = await resolveRevocationTarget({
        token: 'shared',
        tokenTypeHint: 'access_token',
        resolvers,
      });

      expect(resolved).toEqual({ tokenType: 'refresh_token', refreshToken: shared });
      expect(recorder.lookups).toEqual(['access:shared', 'refresh:shared']);
    });

    // RFC 7009 §2.1: the server MAY ignore token_type_hint. An unrecognized value
    // falls back to the default lookup order instead of raising
    // unsupported_token_type (§2.2.1), which is for token types the server cannot revoke.
    it('should ignore unknown hint values without raising unsupported_token_type', async () => {
      const stored = accessToken({ sub: 'a' });
      const { resolvers, recorder } = makeResolvers(new Map([['AT', stored]]), new Map());

      const resolved = await resolveRevocationTarget({
        token: 'AT',
        tokenTypeHint: 'totally_made_up',
        resolvers,
      });

      expect(resolved).toEqual({ tokenType: 'access_token', accessToken: stored });
      expect(recorder.lookups).toEqual(['access:AT']);
    });
  });

  // RFC 7009 §2.2: an invalid token, including one that does not exist, is not an
  // error. The step reports it as null and the endpoint still answers 200.
  describe('Unknown token', () => {
    it('should return null without revoking anything when access token does not exist', async () => {
      const { resolvers, recorder } = makeResolvers(new Map(), new Map());

      const resolved = await resolveRevocationTarget({ token: 'unknown', resolvers });

      expect(resolved).toBeNull();
      expect(recorder.revokedAccessTokens).toEqual([]);
      expect(recorder.revokedRefreshTokens).toEqual([]);
    });

    it('should return null without revoking anything when refresh token does not exist', async () => {
      const { resolvers, recorder } = makeResolvers(new Map(), new Map());

      const resolved = await resolveRevocationTarget({
        token: 'missing',
        tokenTypeHint: 'refresh_token',
        resolvers,
      });

      expect(resolved).toBeNull();
      expect(recorder.lookups).toEqual(['refresh:missing', 'access:missing']);
      expect(recorder.revokedRefreshTokens).toEqual([]);
    });
  });

  describe('Optional resolvers', () => {
    it('should work without findRefreshToken when only access tokens are searched', async () => {
      const stored = accessToken({ sub: 'a' });
      const access = new Map([['AT', stored]]);
      const resolvers: RevocationTokenResolvers = {
        async findAccessToken(token) {
          return access.get(token) ?? null;
        },
        async revokeAccessToken(token) {
          access.delete(token);
        },
      };

      const resolved = await resolveRevocationTarget({ token: 'AT', resolvers });
      expect(resolved).toEqual({ tokenType: 'access_token', accessToken: stored });

      await revokeResolvedToken('AT', resolved!, resolvers);
      expect(access.has('AT')).toBe(false);
    });
  });
});

// RFC 7009 §2.1: "verifies whether the token was issued to the client making
// the revocation request. If this validation fails, the request is refused
// and the client is informed of the error".
describe('validateRevocationTokenClient', () => {
  describe('Cross-client safety', () => {
    it('should reject with invalid_grant when access token belongs to another client', async () => {
      const access = new Map([['AT', accessToken({ sub: 'a', clientId: 'attacker-client' })]]);
      const { resolvers, recorder } = makeResolvers(access, new Map());
      const resolved = await resolveRevocationTarget({ token: 'AT', resolvers });

      const error = captureError(() => validateRevocationTokenClient(resolved!, CLIENT_ID));

      expect(error).toBeInstanceOf(RevocationError);
      expect(error?.error).toBe(RevocationErrorCode.InvalidGrant);
      expect(error?.errorDescription).toBe('Token was not issued to the requesting client');
      expect(error?.statusCode).toBe(400);
      expect(error?.wwwAuthenticate).toBeUndefined();
      expect(recorder.revokedAccessTokens).toEqual([]);
      expect(access.has('AT')).toBe(true);
    });

    it('should reject with invalid_grant when refresh token belongs to another client', async () => {
      const refresh = new Map([
        ['RT', refreshToken({ subject: 'a', clientId: 'attacker-client', grantId: 'g' })],
      ]);
      const { resolvers, recorder } = makeResolvers(new Map(), refresh);
      const resolved = await resolveRevocationTarget({
        token: 'RT',
        tokenTypeHint: 'refresh_token',
        resolvers,
      });

      const error = captureError(() => validateRevocationTokenClient(resolved!, CLIENT_ID));

      expect(error).toBeInstanceOf(RevocationError);
      expect(error?.error).toBe(RevocationErrorCode.InvalidGrant);
      expect(error?.errorDescription).toBe('Token was not issued to the requesting client');
      expect(error?.statusCode).toBe(400);
      expect(recorder.revokedRefreshTokens).toEqual([]);
      expect(recorder.revokedGrants).toEqual([]);
      expect(refresh.has('RT')).toBe(true);
    });
  });
});

describe('revokeResolvedToken', () => {
  it('should revoke the access token when found', async () => {
    const stored = accessToken({ grantId: 'g1' });
    const access = new Map([['AT1', stored]]);
    const { resolvers, recorder } = makeResolvers(access, new Map());
    const resolved = await resolveRevocationTarget({ token: 'AT1', resolvers });
    expect(resolved).toEqual({ tokenType: 'access_token', accessToken: stored });

    await revokeResolvedToken('AT1', resolved!, resolvers);

    expect(recorder.revokedAccessTokens).toEqual(['AT1']);
    expect(recorder.revokedRefreshTokens).toEqual([]);
    expect(access.has('AT1')).toBe(false);
  });

  it('should revoke the refresh token when found', async () => {
    const stored = refreshToken({ grantId: 'g1' });
    const refresh = new Map([['RT1', stored]]);
    const { resolvers, recorder } = makeResolvers(new Map(), refresh);
    const resolved = await resolveRevocationTarget({
      token: 'RT1',
      tokenTypeHint: 'refresh_token',
      resolvers,
    });
    expect(resolved).toEqual({ tokenType: 'refresh_token', refreshToken: stored });

    await revokeResolvedToken('RT1', resolved!, resolvers);

    expect(recorder.revokedRefreshTokens).toEqual(['RT1']);
    expect(recorder.revokedAccessTokens).toEqual([]);
    expect(refresh.has('RT1')).toBe(false);
  });
});

// RFC 7009 §2.1: revoking a refresh token SHOULD also invalidate the access tokens
// of the same authorization grant. Revoking an access token MAY also revoke the
// refresh token of the same grant; this implementation does not do so.
describe('revokeGrantAccessTokens', () => {
  it('should revoke all access tokens sharing the same grantId (RFC 7009 SHOULD)', async () => {
    const access = new Map([
      ['AT-a', accessToken({ grantId: 'shared-grant' })],
      ['AT-b', accessToken({ grantId: 'shared-grant' })],
      ['AT-other-grant', accessToken({ grantId: 'unrelated' })],
    ]);
    const presented = refreshToken({ grantId: 'shared-grant' });
    const { resolvers, recorder } = makeResolvers(access, new Map([['RT-shared', presented]]));
    const resolved: ResolvedRevocationToken = {
      tokenType: 'refresh_token',
      refreshToken: presented,
    };

    await revokeResolvedToken('RT-shared', resolved, resolvers);
    await revokeGrantAccessTokens(resolved, resolvers);

    expect(recorder.revokedRefreshTokens).toEqual(['RT-shared']);
    expect(recorder.revokedGrants).toEqual(['shared-grant']);
    expect(access.has('AT-a')).toBe(false);
    expect(access.has('AT-b')).toBe(false);
    expect(access.has('AT-other-grant')).toBe(true);
  });

  it('should NOT revoke associated refresh tokens by default (RFC 7009 MAY, not chosen)', async () => {
    const presented = accessToken({ grantId: 'g2' });
    const refresh = new Map([['RT-pair', refreshToken({ grantId: 'g2' })]]);
    const { resolvers, recorder } = makeResolvers(new Map([['AT2', presented]]), refresh);
    const resolved: ResolvedRevocationToken = {
      tokenType: 'access_token',
      accessToken: presented,
    };

    await revokeResolvedToken('AT2', resolved, resolvers);
    await revokeGrantAccessTokens(resolved, resolvers);

    expect(recorder.revokedAccessTokens).toEqual(['AT2']);
    expect(recorder.revokedRefreshTokens).toEqual([]);
    expect(recorder.revokedGrants).toEqual([]);
    expect(refresh.has('RT-pair')).toBe(true);
  });
});
