import { describe, it, expect } from 'vitest';
import {
  handleRevocationRequest,
  RevocationError,
  RevocationErrorCode,
  type RevocationTokenResolvers,
  type RevocationRequestContext,
} from './revocation.js';
import type { AccessTokenInfo } from './userinfo.js';
import type { RefreshTokenInfo } from './token-request.js';

const CLIENT_ID = 'client-1';
const NOW = () => Math.floor(Date.now() / 1000);

interface Recorder {
  revokedAccessTokens: string[];
  revokedRefreshTokens: string[];
  revokedGrants: string[];
}

function makeResolvers(
  access: Map<string, AccessTokenInfo>,
  refresh: Map<string, RefreshTokenInfo>,
): { resolvers: RevocationTokenResolvers; recorder: Recorder } {
  const recorder: Recorder = {
    revokedAccessTokens: [],
    revokedRefreshTokens: [],
    revokedGrants: [],
  };
  const resolvers: RevocationTokenResolvers = {
    async findAccessToken(token) {
      return access.get(token) ?? null;
    },
    async revokeAccessToken(token) {
      recorder.revokedAccessTokens.push(token);
      access.delete(token);
    },
    async findRefreshToken(token) {
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

function buildContext(
  resolvers: RevocationTokenResolvers,
  overrides: Partial<RevocationRequestContext> = {},
): RevocationRequestContext {
  return {
    params: { token: 'unused' },
    authenticatedClientId: CLIENT_ID,
    resolvers,
    ...overrides,
  };
}

describe('handleRevocationRequest', () => {
  describe('Validation', () => {
    it('should reject when token parameter is missing', async () => {
      const { resolvers } = makeResolvers(new Map(), new Map());
      const ctx = buildContext(resolvers, { params: {} });
      await expect(handleRevocationRequest(ctx)).rejects.toBeInstanceOf(
        RevocationError,
      );
      try {
        await handleRevocationRequest(ctx);
      } catch (error) {
        expect((error as RevocationError).error).toBe(
          RevocationErrorCode.InvalidRequest,
        );
        expect((error as RevocationError).statusCode).toBe(400);
      }
    });

    it('should reject when authenticatedClientId is empty', async () => {
      const { resolvers } = makeResolvers(new Map(), new Map());
      const ctx = buildContext(resolvers, {
        params: { token: 't' },
        authenticatedClientId: '',
      });
      await expect(handleRevocationRequest(ctx)).rejects.toBeInstanceOf(
        RevocationError,
      );
      try {
        await handleRevocationRequest(ctx);
      } catch (error) {
        expect((error as RevocationError).error).toBe(
          RevocationErrorCode.InvalidClient,
        );
        expect((error as RevocationError).statusCode).toBe(401);
      }
    });
  });

  describe('Access token revocation', () => {
    it('should revoke the access token when found', async () => {
      const access = new Map<string, AccessTokenInfo>([
        [
          'AT1',
          {
            sub: 'alice',
            scope: ['openid'],
            clientId: CLIENT_ID,
            expiresAt: NOW() + 60,
            grantId: 'g1',
          },
        ],
      ]);
      const { resolvers, recorder } = makeResolvers(access, new Map());
      const ctx = buildContext(resolvers, { params: { token: 'AT1' } });
      await handleRevocationRequest(ctx);
      expect(recorder.revokedAccessTokens).toEqual(['AT1']);
      expect(recorder.revokedRefreshTokens).toEqual([]);
      expect(recorder.revokedGrants).toEqual([]);
      expect(access.has('AT1')).toBe(false);
    });

    it('should NOT revoke associated refresh tokens by default (RFC 7009 MAY, not chosen)', async () => {
      const access = new Map<string, AccessTokenInfo>([
        [
          'AT2',
          {
            sub: 'alice',
            scope: ['openid'],
            clientId: CLIENT_ID,
            expiresAt: NOW() + 60,
            grantId: 'g2',
          },
        ],
      ]);
      const refresh = new Map<string, RefreshTokenInfo>([
        [
          'RT-pair',
          {
            subject: 'alice',
            clientId: CLIENT_ID,
            scope: ['openid'],
            expiresAt: NOW() + 86400,
            used: false,
            grantId: 'g2',
          },
        ],
      ]);
      const { resolvers, recorder } = makeResolvers(access, refresh);
      const ctx = buildContext(resolvers, { params: { token: 'AT2' } });
      await handleRevocationRequest(ctx);
      expect(recorder.revokedAccessTokens).toEqual(['AT2']);
      expect(recorder.revokedRefreshTokens).toEqual([]);
      expect(refresh.has('RT-pair')).toBe(true);
    });

    it('should silently succeed when access token does not exist', async () => {
      const { resolvers, recorder } = makeResolvers(new Map(), new Map());
      const ctx = buildContext(resolvers, { params: { token: 'unknown' } });
      await expect(handleRevocationRequest(ctx)).resolves.toBeUndefined();
      expect(recorder.revokedAccessTokens).toEqual([]);
      expect(recorder.revokedRefreshTokens).toEqual([]);
    });
  });

  describe('Refresh token revocation', () => {
    it('should revoke the refresh token when found', async () => {
      const refresh = new Map<string, RefreshTokenInfo>([
        [
          'RT1',
          {
            subject: 'alice',
            clientId: CLIENT_ID,
            scope: ['openid'],
            expiresAt: NOW() + 86400,
            used: false,
            grantId: 'g1',
          },
        ],
      ]);
      const { resolvers, recorder } = makeResolvers(new Map(), refresh);
      const ctx = buildContext(resolvers, {
        params: { token: 'RT1', token_type_hint: 'refresh_token' },
      });
      await handleRevocationRequest(ctx);
      expect(recorder.revokedRefreshTokens).toEqual(['RT1']);
    });

    it('should revoke all access tokens sharing the same grantId (RFC 7009 SHOULD)', async () => {
      const access = new Map<string, AccessTokenInfo>([
        [
          'AT-a',
          {
            sub: 'alice',
            scope: ['openid'],
            clientId: CLIENT_ID,
            expiresAt: NOW() + 60,
            grantId: 'shared-grant',
          },
        ],
        [
          'AT-b',
          {
            sub: 'alice',
            scope: ['openid'],
            clientId: CLIENT_ID,
            expiresAt: NOW() + 60,
            grantId: 'shared-grant',
          },
        ],
        [
          'AT-other-grant',
          {
            sub: 'alice',
            scope: ['openid'],
            clientId: CLIENT_ID,
            expiresAt: NOW() + 60,
            grantId: 'unrelated',
          },
        ],
      ]);
      const refresh = new Map<string, RefreshTokenInfo>([
        [
          'RT-shared',
          {
            subject: 'alice',
            clientId: CLIENT_ID,
            scope: ['openid'],
            expiresAt: NOW() + 86400,
            used: false,
            grantId: 'shared-grant',
          },
        ],
      ]);
      const { resolvers, recorder } = makeResolvers(access, refresh);
      const ctx = buildContext(resolvers, {
        params: { token: 'RT-shared', token_type_hint: 'refresh_token' },
      });
      await handleRevocationRequest(ctx);
      expect(recorder.revokedRefreshTokens).toEqual(['RT-shared']);
      expect(recorder.revokedGrants).toEqual(['shared-grant']);
      expect(access.has('AT-a')).toBe(false);
      expect(access.has('AT-b')).toBe(false);
      expect(access.has('AT-other-grant')).toBe(true);
    });

    it('should silently succeed when refresh token does not exist', async () => {
      const { resolvers, recorder } = makeResolvers(new Map(), new Map());
      const ctx = buildContext(resolvers, {
        params: { token: 'missing', token_type_hint: 'refresh_token' },
      });
      await expect(handleRevocationRequest(ctx)).resolves.toBeUndefined();
      expect(recorder.revokedRefreshTokens).toEqual([]);
    });
  });

  describe('Token type hint behavior', () => {
    it('should look up access tokens first when hint=access_token', async () => {
      let accessLookups = 0;
      let refreshLookups = 0;
      const resolvers: RevocationTokenResolvers = {
        async findAccessToken(token) {
          accessLookups++;
          if (token === 'shared') {
            return {
              sub: 'a',
              scope: ['openid'],
              clientId: CLIENT_ID,
              expiresAt: NOW() + 60,
            };
          }
          return null;
        },
        async revokeAccessToken() {},
        async findRefreshToken() {
          refreshLookups++;
          return null;
        },
        async revokeRefreshToken() {},
      };
      const ctx = buildContext(resolvers, {
        params: { token: 'shared', token_type_hint: 'access_token' },
      });
      await handleRevocationRequest(ctx);
      expect(accessLookups).toBe(1);
      expect(refreshLookups).toBe(0);
    });

    it('should fall back to refresh token search when hint=access_token misses', async () => {
      let refreshLookups = 0;
      const resolvers: RevocationTokenResolvers = {
        async findAccessToken() {
          return null;
        },
        async revokeAccessToken() {},
        async findRefreshToken(token) {
          refreshLookups++;
          if (token === 'shared') {
            return {
              subject: 'a',
              clientId: CLIENT_ID,
              scope: ['openid'],
              expiresAt: NOW() + 60,
              used: false,
              grantId: 'g',
            };
          }
          return null;
        },
        async revokeRefreshToken() {},
      };
      const ctx = buildContext(resolvers, {
        params: { token: 'shared', token_type_hint: 'access_token' },
      });
      await handleRevocationRequest(ctx);
      expect(refreshLookups).toBe(1);
    });

    it('should ignore unknown hint values without raising unsupported_token_type', async () => {
      const access = new Map<string, AccessTokenInfo>([
        [
          'AT',
          {
            sub: 'a',
            scope: ['openid'],
            clientId: CLIENT_ID,
            expiresAt: NOW() + 60,
          },
        ],
      ]);
      const { resolvers, recorder } = makeResolvers(access, new Map());
      const ctx = buildContext(resolvers, {
        params: { token: 'AT', token_type_hint: 'totally_made_up' },
      });
      await expect(handleRevocationRequest(ctx)).resolves.toBeUndefined();
      expect(recorder.revokedAccessTokens).toEqual(['AT']);
    });
  });

  // RFC 7009 §2.1: "verifies whether the token was issued to the client making
  // the revocation request. If this validation fails, the request is refused
  // and the client is informed of the error".
  describe('Cross-client safety', () => {
    it('should reject with invalid_grant when access token belongs to another client', async () => {
      const access = new Map<string, AccessTokenInfo>([
        [
          'AT',
          {
            sub: 'a',
            scope: ['openid'],
            clientId: 'attacker-client',
            expiresAt: NOW() + 60,
          },
        ],
      ]);
      const { resolvers, recorder } = makeResolvers(access, new Map());
      const ctx = buildContext(resolvers, { params: { token: 'AT' } });
      await expect(handleRevocationRequest(ctx)).rejects.toBeInstanceOf(
        RevocationError,
      );
      try {
        await handleRevocationRequest(ctx);
      } catch (error) {
        expect((error as RevocationError).error).toBe(
          RevocationErrorCode.InvalidGrant,
        );
        expect((error as RevocationError).statusCode).toBe(400);
      }
      expect(recorder.revokedAccessTokens).toEqual([]);
      expect(access.has('AT')).toBe(true);
    });

    it('should reject with invalid_grant when refresh token belongs to another client', async () => {
      const refresh = new Map<string, RefreshTokenInfo>([
        [
          'RT',
          {
            subject: 'a',
            clientId: 'attacker-client',
            scope: ['openid'],
            expiresAt: NOW() + 86400,
            used: false,
            grantId: 'g',
          },
        ],
      ]);
      const { resolvers, recorder } = makeResolvers(new Map(), refresh);
      const ctx = buildContext(resolvers, {
        params: { token: 'RT', token_type_hint: 'refresh_token' },
      });
      await expect(handleRevocationRequest(ctx)).rejects.toBeInstanceOf(
        RevocationError,
      );
      expect(recorder.revokedRefreshTokens).toEqual([]);
      expect(recorder.revokedGrants).toEqual([]);
      expect(refresh.has('RT')).toBe(true);
    });
  });

  describe('Optional resolvers', () => {
    it('should work without findRefreshToken when only access tokens are searched', async () => {
      const access = new Map<string, AccessTokenInfo>([
        [
          'AT',
          {
            sub: 'a',
            scope: ['openid'],
            clientId: CLIENT_ID,
            expiresAt: NOW() + 60,
          },
        ],
      ]);
      const resolvers: RevocationTokenResolvers = {
        async findAccessToken(token) {
          return access.get(token) ?? null;
        },
        async revokeAccessToken(token) {
          access.delete(token);
        },
      };
      const ctx = buildContext(resolvers, { params: { token: 'AT' } });
      await expect(handleRevocationRequest(ctx)).resolves.toBeUndefined();
      expect(access.has('AT')).toBe(false);
    });
  });
});
