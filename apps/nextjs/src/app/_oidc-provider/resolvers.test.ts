import type { AccessTokenInfo, AuthorizationCodeInfo, RefreshTokenInfo } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { requestTo } from '../../test-support/context';
import { createEmptyDatabase } from './db/memory/database';
import { createProviderStores } from './db/memory/stores';
import { registerUser } from './db/memory/users';
import { createStoreResolvers } from './resolvers';

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function codeInfo(code: string, grantId: string): AuthorizationCodeInfo {
  return {
    code,
    grantId,
    clientId: 'client-1',
    redirectUri: 'https://rp.example.com/callback',
    redirectUriExplicit: true,
    scope: ['openid'],
    expiresAt: FUTURE,
    used: false,
  };
}

function accessTokenInfo(grantId: string): AccessTokenInfo {
  return { sub: 'alice', scope: ['openid'], clientId: 'client-1', expiresAt: FUTURE, grantId };
}

function refreshTokenInfo(grantId: string): RefreshTokenInfo {
  return {
    subject: 'alice',
    clientId: 'client-1',
    scope: ['openid', 'offline_access'],
    expiresAt: FUTURE,
    used: false,
    grantId,
    originalIssuedAt: FUTURE - 3600,
    authTime: FUTURE - 3600,
  };
}

function setUp() {
  const db = createEmptyDatabase();
  const stores = createProviderStores(db);
  return { db, stores, resolvers: createStoreResolvers(stores) };
}

describe('createStoreResolvers', () => {
  describe('authorizationCodeResolver', () => {
    it('should find a stored authorization code', async () => {
      const { stores, resolvers } = setUp();
      await stores.authCodeStore.set('code-1', codeInfo('code-1', 'grant-1'));

      expect(await resolvers.authorizationCodeResolver.findAuthorizationCode('code-1')).toEqual(
        codeInfo('code-1', 'grant-1'),
      );
    });

    it('should return null for an unknown authorization code', async () => {
      const { resolvers } = setUp();

      expect(await resolvers.authorizationCodeResolver.findAuthorizationCode('unknown')).toBeNull();
    });

    // OAuth 2.1 §4.1.2: a used code stays readable so a replay can be detected.
    it('should mark a revoked authorization code used instead of deleting it', async () => {
      const { stores, resolvers } = setUp();
      await stores.authCodeStore.set('code-1', codeInfo('code-1', 'grant-1'));

      await resolvers.authorizationCodeResolver.revokeAuthorizationCode('code-1');

      expect(await resolvers.authorizationCodeResolver.findAuthorizationCode('code-1')).toMatchObject({
        code: 'code-1',
        used: true,
      });
    });

    it('should revoke the access and refresh tokens of the grant only', async () => {
      const { db, stores, resolvers } = setUp();
      await stores.accessTokenStore.set('at-1', accessTokenInfo('grant-1'));
      await stores.accessTokenStore.set('at-2', accessTokenInfo('grant-2'));
      await stores.refreshTokenStore.set('rt-1', refreshTokenInfo('grant-1'));
      await stores.refreshTokenStore.set('rt-2', refreshTokenInfo('grant-2'));

      await resolvers.authorizationCodeResolver.revokeTokensByGrantId?.('grant-1');

      expect([...db.accessTokens.keys()]).toEqual(['at-2']);
      expect([...db.refreshTokens.keys()]).toEqual(['rt-2']);
    });
  });

  describe('accessTokenResolver', () => {
    it('should find a stored access token and return null for an unknown one', async () => {
      const { stores, resolvers } = setUp();
      await stores.accessTokenStore.set('at-1', accessTokenInfo('grant-1'));

      expect(await resolvers.accessTokenResolver.findAccessToken('at-1')).toEqual(accessTokenInfo('grant-1'));
      expect(await resolvers.accessTokenResolver.findAccessToken('unknown')).toBeNull();
    });
  });

  describe('refreshTokenResolver', () => {
    it('should resolve a stored refresh token and return null for an unknown one', async () => {
      const { stores, resolvers } = setUp();
      await stores.refreshTokenStore.set('rt-1', refreshTokenInfo('grant-1'));

      expect(await resolvers.refreshTokenResolver.resolve('rt-1')).toEqual(refreshTokenInfo('grant-1'));
      expect(await resolvers.refreshTokenResolver.resolve('unknown')).toBeNull();
    });

    // OAuth 2.1 §4.3.1: a rotated refresh token stays readable as used.
    it('should mark a revoked refresh token used', async () => {
      const { stores, resolvers } = setUp();
      await stores.refreshTokenStore.set('rt-1', refreshTokenInfo('grant-1'));

      await resolvers.refreshTokenResolver.revokeRefreshToken('rt-1');

      expect(await resolvers.refreshTokenResolver.resolve('rt-1')).toMatchObject({ used: true });
    });
  });

  describe('userClaimsResolver', () => {
    it('should return the claims of a registered user without the password', async () => {
      const { db, resolvers } = setUp();
      await registerUser(db, { sub: 'alice', email: 'alice@example.com', password: 'secret' });

      expect(await resolvers.userClaimsResolver.findUserClaims('alice')).toEqual({
        sub: 'alice',
        email: 'alice@example.com',
      });
      expect(await resolvers.userClaimsResolver.findUserClaims('unknown')).toBeNull();
    });
  });

  // OIDC Core 1.0 §3.1.2.1 / §3.1.2.3: the browser session behind SSO, prompt=none and max_age.
  describe('sessionResolver', () => {
    it('should resolve the browser session of the session_id cookie with its session id', async () => {
      const { stores, resolvers } = setUp();
      await stores.browserSessionStore.set('sid-1', { subject: 'alice', authTime: 1700000000 });
      const request = requestTo('/authorize', { headers: { Cookie: 'session_id=sid-1' } });

      expect(await resolvers.sessionResolver.resolve(request)).toEqual({
        subject: 'alice',
        authTime: 1700000000,
        sessionId: 'sid-1',
      });
    });

    it('should return null for a request without a session cookie', async () => {
      const { resolvers } = setUp();

      expect(await resolvers.sessionResolver.resolve(requestTo('/authorize'))).toBeNull();
    });

    it('should return null for a session id that has no session', async () => {
      const { resolvers } = setUp();
      const request = requestTo('/authorize', { headers: { Cookie: 'session_id=ended' } });

      expect(await resolvers.sessionResolver.resolve(request)).toBeNull();
    });
  });

  describe('authenticationSessionResolver', () => {
    it('should find a session by id and return null once it has ended', async () => {
      const { stores, resolvers } = setUp();
      await stores.browserSessionStore.set('sid-1', { subject: 'alice', authTime: 1700000000 });

      expect(await resolvers.authenticationSessionResolver.findSession('sid-1')).toEqual({
        subject: 'alice',
        authTime: 1700000000,
      });
      await stores.browserSessionStore.delete('sid-1');
      expect(await resolvers.authenticationSessionResolver.findSession('sid-1')).toBeNull();
    });
  });

  describe('consentResolver', () => {
    it('should confirm a recorded consent only for scopes that were all granted', async () => {
      const { resolvers } = setUp();

      await resolvers.consentResolver.recordConsent?.('alice', 'client-1', ['openid', 'profile']);

      expect(await resolvers.consentResolver.hasConsent('alice', 'client-1', ['openid', 'profile'])).toBe(true);
      expect(await resolvers.consentResolver.hasConsent('alice', 'client-1', ['openid', 'email'])).toBe(false);
    });

    it('should remove the consent and revoke the tokens of its recorded grants', async () => {
      const { db, stores, resolvers } = setUp();
      await resolvers.consentResolver.recordConsent?.('alice', 'client-1', ['openid']);
      await resolvers.consentResolver.recordGrant('alice', 'client-1', 'grant-1');
      await stores.accessTokenStore.set('at-1', accessTokenInfo('grant-1'));
      await stores.refreshTokenStore.set('rt-1', refreshTokenInfo('grant-1'));

      await resolvers.consentResolver.revokeConsent?.('alice', 'client-1');

      expect(await resolvers.consentResolver.hasConsent('alice', 'client-1', ['openid'])).toBe(false);
      expect(db.accessTokens.size).toBe(0);
      expect(db.refreshTokens.size).toBe(0);
    });
  });
});
