import { describe, it, expect } from 'vitest';
import {
  handleIntrospectionRequest,
  IntrospectionError,
  IntrospectionErrorCode,
  type IntrospectionAccessTokenResolver,
  type IntrospectionRefreshTokenResolver,
  type IntrospectionRequestContext,
} from './introspection.js';
import type { AccessTokenInfo } from './userinfo.js';
import type { RefreshTokenInfo } from './token-request.js';

const ISSUER = 'https://op.example.com';
const CLIENT_ID = 'client-1';
const NOW = () => Math.floor(Date.now() / 1000);

function makeAccessTokenResolver(
  store: Map<string, AccessTokenInfo>,
): IntrospectionAccessTokenResolver {
  return {
    async findAccessToken(token) {
      return store.get(token) ?? null;
    },
  };
}

function makeRefreshTokenResolver(
  store: Map<string, RefreshTokenInfo>,
): IntrospectionRefreshTokenResolver {
  return {
    async resolve(token) {
      return store.get(token) ?? null;
    },
  };
}

function buildContext(
  overrides: Partial<IntrospectionRequestContext> = {},
): IntrospectionRequestContext {
  return {
    params: { token: 'unused' },
    authenticatedClientId: CLIENT_ID,
    accessTokenResolver: makeAccessTokenResolver(new Map()),
    refreshTokenResolver: makeRefreshTokenResolver(new Map()),
    ...overrides,
  };
}

describe('handleIntrospectionRequest', () => {
  describe('Validation', () => {
    it('should reject when token parameter is missing', async () => {
      const ctx = buildContext({ params: {} });
      await expect(handleIntrospectionRequest(ctx)).rejects.toBeInstanceOf(
        IntrospectionError,
      );
      try {
        await handleIntrospectionRequest(ctx);
      } catch (error) {
        expect((error as IntrospectionError).error).toBe(
          IntrospectionErrorCode.InvalidRequest,
        );
        expect((error as IntrospectionError).statusCode).toBe(400);
      }
    });

    it('should reject when authenticatedClientId is empty', async () => {
      const ctx = buildContext({
        params: { token: 't' },
        authenticatedClientId: '',
      });
      await expect(handleIntrospectionRequest(ctx)).rejects.toBeInstanceOf(
        IntrospectionError,
      );
      try {
        await handleIntrospectionRequest(ctx);
      } catch (error) {
        expect((error as IntrospectionError).error).toBe(
          IntrospectionErrorCode.InvalidClient,
        );
        expect((error as IntrospectionError).statusCode).toBe(401);
      }
    });
  });

  describe('Active access token', () => {
    it('should return active=true with scope, client_id, sub, exp, iat, aud, iss, token_type', async () => {
      const now = NOW();
      const store = new Map<string, AccessTokenInfo>([
        [
          'AT1',
          {
            sub: 'alice',
            scope: ['openid', 'profile'],
            clientId: CLIENT_ID,
            expiresAt: now + 1000,
            iat: now,
            audience: ['https://api.example.com'],
            issuer: ISSUER,
          },
        ],
      ]);
      const ctx = buildContext({
        params: { token: 'AT1' },
        accessTokenResolver: makeAccessTokenResolver(store),
      });
      const res = await handleIntrospectionRequest(ctx);
      expect(res).toMatchObject({
        active: true,
        scope: 'openid profile',
        client_id: CLIENT_ID,
        sub: 'alice',
        token_type: 'Bearer',
        iss: ISSUER,
        iat: now,
        exp: now + 1000,
        aud: ['https://api.example.com'],
      });
    });

    // RFC 7519 §4.1.5 / RFC 7662 §2.2: a token with an nbf ("not before") in the
    // future is not yet valid, so introspection MUST report it inactive. This applies
    // to both JWT and opaque tokens because introspection reads the stored token info.
    it('should echo nbf when the token carries a valid (past) nbf', async () => {
      const now = NOW();
      const store = new Map<string, AccessTokenInfo>([
        [
          'AT-nbf-ok',
          {
            sub: 'alice',
            scope: ['openid'],
            clientId: CLIENT_ID,
            expiresAt: now + 1000,
            iat: now,
            nbf: now,
          },
        ],
      ]);
      const ctx = buildContext({
        params: { token: 'AT-nbf-ok' },
        accessTokenResolver: makeAccessTokenResolver(store),
      });
      const res = await handleIntrospectionRequest(ctx);
      expect(res).toMatchObject({
        active: true,
        nbf: now,
      });
    });

    it('should return active=false when the token nbf is in the future', async () => {
      const now = NOW();
      const store = new Map<string, AccessTokenInfo>([
        [
          'AT-nbf-future',
          {
            sub: 'alice',
            scope: ['openid'],
            clientId: CLIENT_ID,
            expiresAt: now + 1000,
            iat: now,
            nbf: now + 500,
          },
        ],
      ]);
      const ctx = buildContext({
        params: { token: 'AT-nbf-future' },
        accessTokenResolver: makeAccessTokenResolver(store),
      });
      const res = await handleIntrospectionRequest(ctx);
      expect(res).toEqual({ active: false });
    });

    it('should return active=false when access token has expired', async () => {
      const store = new Map<string, AccessTokenInfo>([
        [
          'AT2',
          {
            sub: 'alice',
            scope: ['openid'],
            clientId: CLIENT_ID,
            expiresAt: NOW() - 1,
          },
        ],
      ]);
      const ctx = buildContext({
        params: { token: 'AT2' },
        accessTokenResolver: makeAccessTokenResolver(store),
      });
      const res = await handleIntrospectionRequest(ctx);
      expect(res).toEqual({ active: false });
    });

    it('should return active=false when access token does not exist', async () => {
      const ctx = buildContext({ params: { token: 'unknown' } });
      const res = await handleIntrospectionRequest(ctx);
      expect(res).toEqual({ active: false });
    });

    // RFC 7662 §2.1: caller is typically a protected resource that may need to
    // introspect tokens issued to other clients. Ownership match is NOT a
    // requirement of the spec, so cross-client introspection returns active=true.
    it('should return active=true even when access token belongs to a different client', async () => {
      const store = new Map<string, AccessTokenInfo>([
        [
          'AT3',
          {
            sub: 'bob',
            scope: ['openid'],
            clientId: 'other-client',
            expiresAt: NOW() + 1000,
          },
        ],
      ]);
      const ctx = buildContext({
        params: { token: 'AT3' },
        accessTokenResolver: makeAccessTokenResolver(store),
      });
      const res = await handleIntrospectionRequest(ctx);
      expect(res).toMatchObject({
        active: true,
        client_id: 'other-client',
        sub: 'bob',
      });
    });

    it('should omit optional claims that are not stored', async () => {
      const store = new Map<string, AccessTokenInfo>([
        [
          'AT-min',
          {
            sub: 'alice',
            scope: ['openid'],
            clientId: CLIENT_ID,
            expiresAt: NOW() + 60,
          },
        ],
      ]);
      const ctx = buildContext({
        params: { token: 'AT-min' },
        accessTokenResolver: makeAccessTokenResolver(store),
      });
      const res = await handleIntrospectionRequest(ctx);
      // active, scope, client_id, token_type, sub, exp は出るが iat/aud/iss は無い
      expect(res).toMatchObject({
        active: true,
        scope: 'openid',
        client_id: CLIENT_ID,
        sub: 'alice',
        token_type: 'Bearer',
      });
      expect((res as Record<string, unknown>).iat).toBeUndefined();
      expect((res as Record<string, unknown>).aud).toBeUndefined();
      expect((res as Record<string, unknown>).iss).toBeUndefined();
    });
  });

  describe('Active refresh token', () => {
    it('should return active=true with token_type=refresh_token', async () => {
      const now = NOW();
      const store = new Map<string, RefreshTokenInfo>([
        [
          'RT1',
          {
            subject: 'alice',
            clientId: CLIENT_ID,
            scope: ['openid', 'offline_access'],
            expiresAt: now + 86400,
            used: false,
            grantId: 'g1',
            iat: now,
            issuer: ISSUER,
          },
        ],
      ]);
      const ctx = buildContext({
        params: { token: 'RT1' },
        accessTokenResolver: makeAccessTokenResolver(new Map()),
        refreshTokenResolver: makeRefreshTokenResolver(store),
      });
      const res = await handleIntrospectionRequest(ctx);
      expect(res).toMatchObject({
        active: true,
        token_type: 'refresh_token',
        scope: 'openid offline_access',
        client_id: CLIENT_ID,
        sub: 'alice',
        iss: ISSUER,
        iat: now,
        exp: now + 86400,
      });
    });

    it('should return active=false when refresh token has been used (rotated)', async () => {
      const store = new Map<string, RefreshTokenInfo>([
        [
          'RT2',
          {
            subject: 'alice',
            clientId: CLIENT_ID,
            scope: ['openid'],
            expiresAt: NOW() + 86400,
            used: true,
            grantId: 'g1',
          },
        ],
      ]);
      const ctx = buildContext({
        params: { token: 'RT2' },
        accessTokenResolver: makeAccessTokenResolver(new Map()),
        refreshTokenResolver: makeRefreshTokenResolver(store),
      });
      const res = await handleIntrospectionRequest(ctx);
      expect(res).toEqual({ active: false });
    });

    it('should return active=false when refresh token has expired', async () => {
      const store = new Map<string, RefreshTokenInfo>([
        [
          'RT3',
          {
            subject: 'alice',
            clientId: CLIENT_ID,
            scope: ['openid'],
            expiresAt: NOW() - 1,
            used: false,
            grantId: 'g1',
          },
        ],
      ]);
      const ctx = buildContext({
        params: { token: 'RT3' },
        accessTokenResolver: makeAccessTokenResolver(new Map()),
        refreshTokenResolver: makeRefreshTokenResolver(store),
      });
      const res = await handleIntrospectionRequest(ctx);
      expect(res).toEqual({ active: false });
    });

    // RFC 7662 §2.1: same as access tokens, refresh tokens issued to other
    // clients are reported active=true to support the protected-resource model.
    it('should return active=true even when refresh token belongs to a different client', async () => {
      const store = new Map<string, RefreshTokenInfo>([
        [
          'RT4',
          {
            subject: 'bob',
            clientId: 'other-client',
            scope: ['openid'],
            expiresAt: NOW() + 86400,
            used: false,
            grantId: 'g2',
          },
        ],
      ]);
      const ctx = buildContext({
        params: { token: 'RT4' },
        accessTokenResolver: makeAccessTokenResolver(new Map()),
        refreshTokenResolver: makeRefreshTokenResolver(store),
      });
      const res = await handleIntrospectionRequest(ctx);
      expect(res).toMatchObject({
        active: true,
        client_id: 'other-client',
        sub: 'bob',
        token_type: 'refresh_token',
      });
    });
  });

  describe('Token type hint behavior', () => {
    it('should look up access tokens first when hint=access_token', async () => {
      let accessLookupCount = 0;
      let refreshLookupCount = 0;
      const accessResolver: IntrospectionAccessTokenResolver = {
        async findAccessToken(token) {
          accessLookupCount++;
          if (token === 'shared') {
            return {
              sub: 'alice',
              scope: ['openid'],
              clientId: CLIENT_ID,
              expiresAt: NOW() + 60,
            };
          }
          return null;
        },
      };
      const refreshResolver: IntrospectionRefreshTokenResolver = {
        async resolve() {
          refreshLookupCount++;
          return null;
        },
      };
      const ctx = buildContext({
        params: { token: 'shared', token_type_hint: 'access_token' },
        accessTokenResolver: accessResolver,
        refreshTokenResolver: refreshResolver,
      });
      const res = await handleIntrospectionRequest(ctx);
      expect((res as { active: boolean }).active).toBe(true);
      expect(accessLookupCount).toBe(1);
      expect(refreshLookupCount).toBe(0);
    });

    it('should look up refresh tokens first when hint=refresh_token', async () => {
      let accessLookupCount = 0;
      let refreshLookupCount = 0;
      const accessResolver: IntrospectionAccessTokenResolver = {
        async findAccessToken() {
          accessLookupCount++;
          return null;
        },
      };
      const refreshResolver: IntrospectionRefreshTokenResolver = {
        async resolve(token) {
          refreshLookupCount++;
          if (token === 'shared') {
            return {
              subject: 'alice',
              clientId: CLIENT_ID,
              scope: ['openid'],
              expiresAt: NOW() + 60,
              used: false,
              grantId: 'g',
            };
          }
          return null;
        },
      };
      const ctx = buildContext({
        params: { token: 'shared', token_type_hint: 'refresh_token' },
        accessTokenResolver: accessResolver,
        refreshTokenResolver: refreshResolver,
      });
      const res = await handleIntrospectionRequest(ctx);
      expect((res as { active: boolean }).active).toBe(true);
      expect(refreshLookupCount).toBe(1);
      expect(accessLookupCount).toBe(0);
    });

    it('should ignore unknown token_type_hint and fall back to access-first lookup', async () => {
      const access = new Map<string, AccessTokenInfo>([
        [
          'shared',
          {
            sub: 'alice',
            scope: ['openid'],
            clientId: CLIENT_ID,
            expiresAt: NOW() + 60,
          },
        ],
      ]);
      const ctx = buildContext({
        params: { token: 'shared', token_type_hint: 'totally_made_up' },
        accessTokenResolver: makeAccessTokenResolver(access),
      });
      const res = await handleIntrospectionRequest(ctx);
      expect((res as { active: boolean }).active).toBe(true);
    });

    it('should return active=false only after both lookups fail', async () => {
      const ctx = buildContext({
        params: { token: 'missing' },
      });
      const res = await handleIntrospectionRequest(ctx);
      expect(res).toEqual({ active: false });
    });
  });

  describe('Without refreshTokenResolver', () => {
    it('should still work and skip refresh token lookup', async () => {
      const access = new Map<string, AccessTokenInfo>([
        [
          'AT',
          {
            sub: 'alice',
            scope: ['openid'],
            clientId: CLIENT_ID,
            expiresAt: NOW() + 60,
          },
        ],
      ]);
      const ctx: IntrospectionRequestContext = {
        params: { token: 'AT' },
        authenticatedClientId: CLIENT_ID,
        accessTokenResolver: makeAccessTokenResolver(access),
      };
      const res = await handleIntrospectionRequest(ctx);
      expect((res as { active: boolean }).active).toBe(true);
    });
  });
});
