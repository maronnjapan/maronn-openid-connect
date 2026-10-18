import type {
  AccessTokenInfo,
  AuthTransaction,
  AuthorizationCodeInfo,
  RefreshTokenInfo,
} from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDatabase, federatedIdentityKey, type MemoryDatabase } from './database.js';
import { createProviderStores } from './stores.js';
import { registerUser } from './users.js';

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW_MS = Date.UTC(2026, 0, 1);
const NOW = NOW_MS / 1000;

let db: MemoryDatabase;
let stores: ReturnType<typeof createProviderStores>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  db = createEmptyDatabase();
  stores = createProviderStores(db);
});

afterEach(() => {
  vi.useRealTimers();
});

function transaction(): AuthTransaction {
  return {
    clientId: 'rp-1',
    redirectUri: 'https://rp.example.com/callback',
    redirectUriExplicit: true,
    responseType: 'code',
    scope: 'openid',
    csrfToken: 'csrf-1',
    createdAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
    failedAttempts: 0,
  };
}

function code(overrides: Partial<AuthorizationCodeInfo> = {}): AuthorizationCodeInfo {
  return {
    code: 'code-1',
    grantId: 'grant-1',
    clientId: 'rp-1',
    redirectUri: 'https://rp.example.com/callback',
    redirectUriExplicit: true,
    scope: ['openid'],
    expiresAt: NOW + 300,
    used: false,
    ...overrides,
  };
}

function accessToken(overrides: Partial<AccessTokenInfo> = {}): AccessTokenInfo {
  return { sub: 'alice', scope: ['openid'], clientId: 'rp-1', expiresAt: NOW + 3600, grantId: 'grant-1', ...overrides };
}

function refreshToken(overrides: Partial<RefreshTokenInfo> = {}): RefreshTokenInfo {
  return {
    subject: 'alice',
    clientId: 'rp-1',
    scope: ['openid', 'offline_access'],
    expiresAt: NOW + 86_400,
    used: false,
    grantId: 'grant-1',
    originalIssuedAt: NOW,
    authTime: NOW,
    ...overrides,
  };
}

describe('createProviderStores', () => {
  describe('transactionStore', () => {
    it('should return a stored transaction until its TTL has passed, then forget it', async () => {
      await stores.transactionStore.put('auth_txn:1', transaction(), 60);

      vi.setSystemTime(NOW_MS + 60_000);
      const atExpiry = await stores.transactionStore.get('auth_txn:1');
      vi.setSystemTime(NOW_MS + 60_001);
      const afterExpiry = await stores.transactionStore.get('auth_txn:1');

      expect(atExpiry).toEqual(transaction());
      expect(afterExpiry).toBeNull();
      expect(db.transactions.has('auth_txn:1')).toBe(false);
    });

    it('should return null for a deleted transaction', async () => {
      await stores.transactionStore.put('auth_txn:1', transaction(), 60);
      await stores.transactionStore.delete('auth_txn:1');

      expect(await stores.transactionStore.get('auth_txn:1')).toBeNull();
    });
  });

  describe('authCodeStore', () => {
    it('should mark a consumed code used and keep returning it', async () => {
      await stores.authCodeStore.set('code-1', code());
      await stores.authCodeStore.consume('code-1');

      expect(await stores.authCodeStore.get('code-1')).toEqual(code({ used: true }));
    });

    // OAuth 2.1 §4.1.2: of two requests that present the same code, only one receives tokens.
    it('should reject a second consume of the same code with invalid_grant', async () => {
      await stores.authCodeStore.set('code-1', code());
      await stores.authCodeStore.consume('code-1');

      expect(() => stores.authCodeStore.consume('code-1')).toThrow(
        expect.objectContaining({ error: 'invalid_grant', errorDescription: 'Authorization code has already been used' }),
      );
    });

    it('should reject consuming an unknown code with invalid_grant', () => {
      expect(() => stores.authCodeStore.consume('unknown')).toThrow(expect.objectContaining({ error: 'invalid_grant' }));
    });

    it('should return undefined for an expired code and remove it', async () => {
      await stores.authCodeStore.set('code-1', code({ expiresAt: NOW }));

      expect(await stores.authCodeStore.get('code-1')).toBeUndefined();
      expect(db.codes.has('code-1')).toBe(false);
    });

    it('should hand out a copy that does not change the stored code', async () => {
      await stores.authCodeStore.set('code-1', code());
      const read = await stores.authCodeStore.get('code-1');
      read!.used = true;

      expect(await stores.authCodeStore.get('code-1')).toEqual(code());
    });
  });

  describe('accessTokenStore', () => {
    // OAuth 2.1 §4.1.2: code reuse revokes every token of the grant.
    it('should revoke every access token of a grant and keep the tokens of other grants', async () => {
      await stores.accessTokenStore.set('at-1', accessToken());
      await stores.accessTokenStore.set('at-2', accessToken());
      await stores.accessTokenStore.set('at-3', accessToken({ grantId: 'grant-2' }));

      await stores.accessTokenStore.revokeByGrantId('grant-1');

      expect([...db.accessTokens.keys()]).toEqual(['at-3']);
    });

    it('should return undefined for an expired access token and evict it', async () => {
      await stores.accessTokenStore.set('at-1', accessToken({ expiresAt: NOW }));

      expect(await stores.accessTokenStore.get('at-1')).toBeUndefined();
      expect(db.accessTokens.has('at-1')).toBe(false);
    });

    // RFC 7009: one token is revoked on its own.
    it('should revoke one access token', async () => {
      await stores.accessTokenStore.set('at-1', accessToken());
      await stores.accessTokenStore.set('at-2', accessToken());

      await stores.accessTokenStore.revoke('at-1');

      expect([...db.accessTokens.keys()]).toEqual(['at-2']);
    });
  });

  describe('refreshTokenStore', () => {
    // OAuth 2.1 §4.3.1: a rotated refresh token stays readable so a replay is detected.
    it('should keep a consumed refresh token readable and reject a second consume with invalid_grant', async () => {
      await stores.refreshTokenStore.set('rt-1', refreshToken());
      await stores.refreshTokenStore.consume('rt-1');

      expect(await stores.refreshTokenStore.get('rt-1')).toEqual(refreshToken({ used: true }));
      expect(() => stores.refreshTokenStore.consume('rt-1')).toThrow(
        expect.objectContaining({ error: 'invalid_grant', errorDescription: 'Refresh token has already been used' }),
      );
    });

    it('should revoke the refresh tokens of a grant, the rotated ones included', async () => {
      await stores.refreshTokenStore.set('rt-1', refreshToken({ used: true }));
      await stores.refreshTokenStore.set('rt-2', refreshToken());
      await stores.refreshTokenStore.set('rt-3', refreshToken({ grantId: 'grant-2' }));

      await stores.refreshTokenStore.revokeByGrantId('grant-1');

      expect([...db.refreshTokens.keys()]).toEqual(['rt-3']);
    });

    it('should return undefined for a refresh token past its absolute lifetime and evict it', async () => {
      await stores.refreshTokenStore.set('rt-1', refreshToken({ expiresAt: NOW }));

      expect(await stores.refreshTokenStore.get('rt-1')).toBeUndefined();
      expect(db.refreshTokens.has('rt-1')).toBe(false);
    });
  });

  describe('authSessionStore', () => {
    it('should return the login hand-off of a transaction until it is deleted', async () => {
      await stores.authSessionStore.set('txn-1', { subject: 'alice', authTime: NOW, sessionId: 'session-1' });
      const stored = await stores.authSessionStore.get('txn-1');
      await stores.authSessionStore.delete('txn-1');

      expect(stored).toEqual({ subject: 'alice', authTime: NOW, sessionId: 'session-1' });
      expect(await stores.authSessionStore.get('txn-1')).toBeUndefined();
    });
  });

  describe('browserSessionStore', () => {
    it('should return a browser session until it is deleted', async () => {
      await stores.browserSessionStore.set('session-1', { subject: 'alice', authTime: NOW });
      const stored = await stores.browserSessionStore.get('session-1');
      await stores.browserSessionStore.delete('session-1');

      expect(stored).toEqual({ subject: 'alice', authTime: NOW });
      expect(await stores.browserSessionStore.get('session-1')).toBeUndefined();
    });
  });

  describe('consentStore', () => {
    // OIDC Core 1.0 §3.1.2.1: prompt=none relies on consent to every requested scope.
    it('should report consent only when every requested scope was granted', async () => {
      await stores.consentStore.grant('alice', 'rp-1', ['openid']);
      await stores.consentStore.grant('alice', 'rp-1', ['profile']);

      expect(await stores.consentStore.hasConsent('alice', 'rp-1', ['openid', 'profile'])).toBe(true);
      expect(await stores.consentStore.hasConsent('alice', 'rp-1', ['openid', 'email'])).toBe(false);
      expect(await stores.consentStore.hasConsent('alice', 'rp-2', ['openid'])).toBe(false);
    });

    it('should report no consent for an empty scope list', async () => {
      await stores.consentStore.grant('alice', 'rp-1', ['openid']);

      expect(await stores.consentStore.hasConsent('alice', 'rp-1', [])).toBe(false);
    });

    it('should remove the consent and hand back the grants issued under it', async () => {
      await stores.consentStore.grant('alice', 'rp-1', ['openid']);
      await stores.consentStore.recordGrant('alice', 'rp-1', 'grant-1');
      await stores.consentStore.recordGrant('alice', 'rp-1', 'grant-2');

      const grantIds = await stores.consentStore.revoke('alice', 'rp-1');

      expect(grantIds).toEqual(['grant-1', 'grant-2']);
      expect(await stores.consentStore.hasConsent('alice', 'rp-1', ['openid'])).toBe(false);
      expect(await stores.consentStore.revoke('alice', 'rp-1')).toEqual([]);
    });
  });

  describe('userStore', () => {
    it('should authenticate a user by sub and password and return the claims with the password hash', async () => {
      await registerUser(db, { sub: 'alice', email: 'alice@example.com', password: 'correct horse' });

      const user = await stores.userStore.authenticate('alice', 'correct horse');

      expect(user).toEqual({ sub: 'alice', email: 'alice@example.com', password: db.users.get('alice')!.passwordHash });
    });

    it('should not authenticate a wrong password, an unknown user or a user without a password', async () => {
      await registerUser(db, { sub: 'alice', password: 'correct horse' });
      await registerUser(db, { sub: 'upstream-user' });

      expect(await stores.userStore.authenticate('alice', 'wrong')).toBeUndefined();
      expect(await stores.userStore.authenticate('nobody', 'correct horse')).toBeUndefined();
      expect(await stores.userStore.authenticate('upstream-user', '')).toBeUndefined();
    });

    it('should return the claims of a user, or undefined for an unknown sub', async () => {
      await registerUser(db, { sub: 'alice', name: 'Alice' });

      expect(await stores.userStore.getClaims('alice')).toEqual({ sub: 'alice', name: 'Alice' });
      expect(await stores.userStore.getClaims('nobody')).toBeUndefined();
    });

    it('should create a user under a new random sub on the first sign-in of an upstream account', async () => {
      const claims = await stores.userStore.linkFederatedIdentity({
        provider: 'google',
        subject: 'google-sub-1',
        claims: { email: 'alice@gmail.com' },
      });

      expect(claims).toEqual({ sub: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), email: 'alice@gmail.com' });
      expect(db.federatedIdentities.get(federatedIdentityKey('google', 'google-sub-1'))).toBe(claims.sub);
      expect(db.users.get(claims.sub)).toEqual({ claims });
    });

    it('should find the same user on a later sign-in and save the newly asserted claims', async () => {
      const first = await stores.userStore.linkFederatedIdentity({
        provider: 'google',
        subject: 'google-sub-1',
        claims: { email: 'alice@gmail.com', name: 'Alice' },
      });
      const second = await stores.userStore.linkFederatedIdentity({
        provider: 'google',
        subject: 'google-sub-1',
        claims: { email: 'alice@example.com' },
      });

      expect(second).toEqual({ sub: first.sub, email: 'alice@example.com' });
      expect(db.users.size).toBe(1);
    });

    it('should keep accounts of different providers apart even with the same upstream subject', async () => {
      const google = await stores.userStore.linkFederatedIdentity({ provider: 'google', subject: 'shared', claims: {} });
      const other = await stores.userStore.linkFederatedIdentity({ provider: 'other', subject: 'shared', claims: {} });

      expect(other.sub).not.toBe(google.sub);
      expect(db.users.size).toBe(2);
    });
  });

  describe('upstreamLoginStore', () => {
    it('should find a saved upstream login until its expiry, then forget it', async () => {
      await stores.upstreamLoginStore.save('nonce-1', { provider: 'google', transactionId: 'txn-1', expiresAt: NOW_MS + 1000 });

      vi.setSystemTime(NOW_MS + 999);
      const beforeExpiry = await stores.upstreamLoginStore.find('nonce-1');
      vi.setSystemTime(NOW_MS + 1000);
      const atExpiry = await stores.upstreamLoginStore.find('nonce-1');

      expect(beforeExpiry).toEqual({ provider: 'google', transactionId: 'txn-1', expiresAt: NOW_MS + 1000 });
      expect(atExpiry).toBeUndefined();
      expect(db.upstreamLogins.has('nonce-1')).toBe(false);
    });

    it('should replace the nonce of an older login page of the same transaction', async () => {
      const expiresAt = NOW_MS + 60_000;
      await stores.upstreamLoginStore.save('nonce-old', { provider: 'google', transactionId: 'txn-1', expiresAt });
      await stores.upstreamLoginStore.save('nonce-other', { provider: 'google', transactionId: 'txn-2', expiresAt });
      await stores.upstreamLoginStore.save('nonce-new', { provider: 'google', transactionId: 'txn-1', expiresAt });

      expect([...db.upstreamLogins.keys()]).toEqual(['nonce-other', 'nonce-new']);
    });

    it('should forget a deleted upstream login', async () => {
      await stores.upstreamLoginStore.save('nonce-1', { provider: 'google', transactionId: 'txn-1', expiresAt: NOW_MS + 1000 });
      await stores.upstreamLoginStore.delete('nonce-1');

      expect(await stores.upstreamLoginStore.find('nonce-1')).toBeUndefined();
    });
  });
});
