import type {
  AccessTokenInfo,
  AuthTransaction,
  AuthorizationCodeData,
  AuthorizationCodeInfo,
  RefreshTokenInfo,
} from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqliteDatabase } from '../../../../test-support/databases';
import type { ProviderStores } from '../../store';
import type { SqlDatabase } from './database';
import { createProviderStores } from './stores';
import { registerUser } from './users';

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW_MS = Date.UTC(2026, 0, 1);
const NOW = NOW_MS / 1000;

/** RFC 9562 §5.4: a version 4 UUID, which crypto.randomUUID() returns. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let db: SqlDatabase;
let stores: ProviderStores;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  db = createSqliteDatabase();
  stores = createProviderStores(db);
});

afterEach(() => {
  vi.useRealTimers();
});

function transaction(overrides: Partial<AuthTransaction> = {}): AuthTransaction {
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
    ...overrides,
  };
}

/**
 * A transaction with every parameter of the authorization request, and the
 * response mode the authorization endpoint records beside them.
 */
function everyParameter(): AuthTransaction & { responseMode: string } {
  return {
    ...transaction({
      state: 'state-1',
      nonce: 'nonce-1',
      codeChallenge: 'challenge-1',
      codeChallengeMethod: 'S256',
      prompt: 'consent',
      maxAge: 300,
      acrValues: 'urn:acr:1',
      loginHint: 'alice',
      uiLocales: 'ja en',
      claimsLocales: 'en',
      idTokenHint: 'id-token-1',
      audience: ['https://api.example.com'],
      claims: { userinfo: { email: { essential: true } } },
      bindingHash: 'binding-1',
      failedAttempts: 2,
    }),
    responseMode: 'form_post',
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

/** A code as the routes pass it: core's AuthorizationCodeData, issued from a transaction. */
function issuedCode(transactionId: string): AuthorizationCodeData {
  return { ...code(), subject: 'alice', authTime: NOW, transactionId };
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

/** The key a code or token is stored under: its SHA-256 hash, base64url without padding. */
async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function rows(sql: string, ...params: string[]): Promise<unknown[]> {
  return db.all({ sql, params });
}

async function statusOf(transactionId: string): Promise<unknown[]> {
  return rows('SELECT status FROM transactions WHERE transaction_id = ?', transactionId);
}

/** The settled states of concurrent calls, sorted so the order they settled in does not matter. */
async function settledStates(calls: Array<Promise<unknown>>): Promise<string[]> {
  return (await Promise.allSettled(calls)).map((result) => result.status).sort();
}

describe('createProviderStores', () => {
  describe('transactionStore', () => {
    it('should return a stored transaction until its expiresAt, then null', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);

      vi.setSystemTime(NOW_MS + 59_999);
      const beforeExpiry = await stores.transactionStore.get('auth_txn:txn-1');
      vi.setSystemTime(NOW_MS + 60_000);
      const atExpiry = await stores.transactionStore.get('auth_txn:txn-1');

      expect(beforeExpiry).toEqual(transaction());
      expect(atExpiry).toBeNull();
    });

    it('should return every parameter of the authorization request it was stored with', async () => {
      const stored = everyParameter();
      await stores.transactionStore.put('auth_txn:txn-1', stored, 60);

      expect(await stores.transactionStore.get('auth_txn:txn-1')).toEqual(stored);
    });

    // OpenID Connect Core 1.0 §3.1.2.1 / §5.2 / §5.5: each parameter of the
    // authentication request has a column of its own.
    it('should keep each OpenID Connect Core parameter in a column of its own and the rest in payload', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', everyParameter(), 60);

      expect(
        await rows(
          'SELECT state, nonce, response_mode, prompt, max_age, ui_locales, claims_locales, id_token_hint, ' +
            'login_hint, acr_values, claims, payload FROM authentication_requests',
        ),
      ).toEqual([
        {
          state: 'state-1',
          nonce: 'nonce-1',
          response_mode: 'form_post',
          prompt: 'consent',
          max_age: 300,
          ui_locales: 'ja en',
          claims_locales: 'en',
          id_token_hint: 'id-token-1',
          login_hint: 'alice',
          acr_values: 'urn:acr:1',
          claims: '{"userinfo":{"email":{"essential":true}}}',
          payload: '{"redirectUriExplicit":true,"audience":["https://api.example.com"]}',
        },
      ]);
    });

    it('should leave the column of a parameter the request did not send NULL', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);

      expect(
        await rows(
          'SELECT response_mode, prompt, max_age, ui_locales, claims_locales, id_token_hint, login_hint, ' +
            'acr_values, claims FROM authentication_requests',
        ),
      ).toEqual([
        {
          response_mode: null,
          prompt: null,
          max_age: null,
          ui_locales: null,
          claims_locales: null,
          id_token_hint: null,
          login_hint: null,
          acr_values: null,
          claims: null,
        },
      ]);
      expect(await stores.transactionStore.get('auth_txn:txn-1')).toEqual(transaction());
    });

    it('should save a new transaction as requested under its id without the auth_txn: prefix', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);

      expect(await rows('SELECT transaction_id, status, created_at, expired_at FROM transactions')).toEqual([
        { transaction_id: 'txn-1', status: 'requested', created_at: NOW, expired_at: NOW + 60 },
      ]);
    });

    it('should end a deleted transaction as failed and return null for it', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.transactionStore.delete('auth_txn:txn-1');

      expect(await stores.transactionStore.get('auth_txn:txn-1')).toBeNull();
      expect(await statusOf('txn-1')).toEqual([{ status: 'failed' }]);
    });

    it('should not start a deleted transaction again when it is saved again', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.transactionStore.delete('auth_txn:txn-1');
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);

      expect(await stores.transactionStore.get('auth_txn:txn-1')).toBeNull();
    });

    it('should keep the status of a transaction saved again after a failed login attempt', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.upstreamLoginStore.save('nonce-1', { provider: 'google', transactionId: 'txn-1', expiresAt: NOW_MS + 60_000 });

      await stores.transactionStore.put('auth_txn:txn-1', transaction({ failedAttempts: 1 }), 60);

      expect(await stores.transactionStore.get('auth_txn:txn-1')).toEqual(transaction({ failedAttempts: 1 }));
      expect(await statusOf('txn-1')).toEqual([{ status: 'upstream_pending' }]);
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

      await expect(stores.authCodeStore.consume('code-1')).rejects.toThrow(
        expect.objectContaining({ error: 'invalid_grant', errorDescription: 'Authorization code has already been used' }),
      );
    });

    // OAuth 2.1 §4.1.2: one conditional UPDATE, so two concurrent requests cannot both use the code.
    it('should let only one of two concurrent consumes of a code succeed', async () => {
      await stores.authCodeStore.set('code-1', code());

      const states = await settledStates([
        Promise.resolve(stores.authCodeStore.consume('code-1')),
        Promise.resolve(stores.authCodeStore.consume('code-1')),
      ]);

      expect(states).toEqual(['fulfilled', 'rejected']);
    });

    it('should reject consuming an unknown code with invalid_grant', async () => {
      await expect(stores.authCodeStore.consume('unknown')).rejects.toThrow(
        expect.objectContaining({ error: 'invalid_grant', errorDescription: 'Authorization code has already been used' }),
      );
    });

    it('should return a code until its expiresAt, then undefined', async () => {
      await stores.authCodeStore.set('code-1', code());

      vi.setSystemTime(NOW_MS + 299_999);
      const beforeExpiry = await stores.authCodeStore.get('code-1');
      vi.setSystemTime(NOW_MS + 300_000);
      const atExpiry = await stores.authCodeStore.get('code-1');

      expect(beforeExpiry).toEqual(code());
      expect(atExpiry).toBeUndefined();
    });

    it('should store the code under its SHA-256 hash, never the code itself', async () => {
      await stores.authCodeStore.set('code-1', code());

      expect(await rows('SELECT id, transaction_id, expired_at, is_used, grant_id, payload FROM codes')).toEqual([
        {
          id: await sha256('code-1'),
          transaction_id: null,
          expired_at: NOW + 300,
          is_used: 0,
          grant_id: 'grant-1',
          payload: JSON.stringify({
            clientId: 'rp-1',
            redirectUri: 'https://rp.example.com/callback',
            redirectUriExplicit: true,
            scope: ['openid'],
          }),
        },
      ]);
    });

    it('should forget a deleted code', async () => {
      await stores.authCodeStore.set('code-1', code());
      await stores.authCodeStore.delete('code-1');

      expect(await stores.authCodeStore.get('code-1')).toBeUndefined();
      await expect(stores.authCodeStore.consume('code-1')).rejects.toThrow(expect.objectContaining({ error: 'invalid_grant' }));
    });

    it('should move the transaction a code is issued from to code_issued', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.transactionStore.delete('auth_txn:txn-1');

      await stores.authCodeStore.set('code-1', issuedCode('txn-1'));

      expect(await statusOf('txn-1')).toEqual([{ status: 'code_issued' }]);
      expect(await rows('SELECT transaction_id FROM codes')).toEqual([{ transaction_id: 'txn-1' }]);
    });
  });

  describe('accessTokenStore', () => {
    it('should return every value an access token was stored with', async () => {
      const stored = accessToken({
        iat: NOW,
        nbf: NOW,
        issuer: 'https://op.example.com',
        jti: 'jti-1',
        acr: 'urn:acr:1',
        audience: ['https://api.example.com'],
        claims: { userinfo: { email: null } },
      });
      await stores.accessTokenStore.set('at-1', stored);

      expect(await stores.accessTokenStore.get('at-1')).toEqual(stored);
    });

    it('should store a token without a jti under its SHA-256 hash and return it without a jti', async () => {
      await stores.accessTokenStore.set('at-1', accessToken());

      const tokenHash = await sha256('at-1');
      expect(await rows('SELECT id, token_hash FROM access_tokens')).toEqual([{ id: tokenHash, token_hash: tokenHash }]);
      expect(await stores.accessTokenStore.get('at-1')).toEqual(accessToken());
    });

    it('should return an access token until its expiresAt, then undefined', async () => {
      await stores.accessTokenStore.set('at-1', accessToken());

      vi.setSystemTime(NOW_MS + 3_599_999);
      const beforeExpiry = await stores.accessTokenStore.get('at-1');
      vi.setSystemTime(NOW_MS + 3_600_000);
      const atExpiry = await stores.accessTokenStore.get('at-1');

      expect(beforeExpiry).toEqual(accessToken());
      expect(atExpiry).toBeUndefined();
    });

    // OAuth 2.1 §4.1.2: code reuse revokes every token of the grant.
    it('should revoke every access token of a grant and keep the tokens of other grants', async () => {
      await stores.accessTokenStore.set('at-1', accessToken());
      await stores.accessTokenStore.set('at-2', accessToken());
      await stores.accessTokenStore.set('at-3', accessToken({ grantId: 'grant-2' }));

      await stores.accessTokenStore.revokeByGrantId('grant-1');

      expect(await stores.accessTokenStore.get('at-1')).toBeUndefined();
      expect(await stores.accessTokenStore.get('at-2')).toBeUndefined();
      expect(await stores.accessTokenStore.get('at-3')).toEqual(accessToken({ grantId: 'grant-2' }));
    });

    // RFC 7009: one token is revoked on its own.
    it('should revoke one access token', async () => {
      await stores.accessTokenStore.set('at-1', accessToken());
      await stores.accessTokenStore.set('at-2', accessToken());

      await stores.accessTokenStore.revoke('at-1');

      expect(await stores.accessTokenStore.get('at-1')).toBeUndefined();
      expect(await stores.accessTokenStore.get('at-2')).toEqual(accessToken());
    });

    it('should forget a deleted access token', async () => {
      await stores.accessTokenStore.set('at-1', accessToken());
      await stores.accessTokenStore.delete('at-1');

      expect(await stores.accessTokenStore.get('at-1')).toBeUndefined();
    });

    it('should move the transaction of the code of its grant to token_issued', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.authCodeStore.set('code-1', issuedCode('txn-1'));

      await stores.accessTokenStore.set('at-1', accessToken());

      expect(await statusOf('txn-1')).toEqual([{ status: 'token_issued' }]);
      expect(await rows('SELECT transaction_id FROM access_tokens')).toEqual([{ transaction_id: 'txn-1' }]);
    });
  });

  describe('refreshTokenStore', () => {
    // OAuth 2.1 §4.3.1: a rotated refresh token stays readable so a replay is detected.
    it('should keep a consumed refresh token readable and reject a second consume with invalid_grant', async () => {
      await stores.refreshTokenStore.set('rt-1', refreshToken());
      await stores.refreshTokenStore.consume('rt-1');

      expect(await stores.refreshTokenStore.get('rt-1')).toEqual(refreshToken({ used: true }));
      await expect(stores.refreshTokenStore.consume('rt-1')).rejects.toThrow(
        expect.objectContaining({ error: 'invalid_grant', errorDescription: 'Refresh token has already been used' }),
      );
    });

    // OAuth 2.1 §4.3.1: exactly one of two concurrent refresh requests rotates the token.
    it('should let only one of two concurrent consumes of a refresh token succeed', async () => {
      await stores.refreshTokenStore.set('rt-1', refreshToken());

      const states = await settledStates([
        Promise.resolve(stores.refreshTokenStore.consume('rt-1')),
        Promise.resolve(stores.refreshTokenStore.consume('rt-1')),
      ]);

      expect(states).toEqual(['fulfilled', 'rejected']);
    });

    it('should reject consuming an unknown refresh token with invalid_grant', async () => {
      await expect(stores.refreshTokenStore.consume('unknown')).rejects.toThrow(
        expect.objectContaining({ error: 'invalid_grant', errorDescription: 'Refresh token has already been used' }),
      );
    });

    it('should return a refresh token with its iat until its absolute expiry, then undefined', async () => {
      await stores.refreshTokenStore.set('rt-1', refreshToken({ iat: NOW }));

      vi.setSystemTime(NOW_MS + 86_399_999);
      const beforeExpiry = await stores.refreshTokenStore.get('rt-1');
      vi.setSystemTime(NOW_MS + 86_400_000);
      const atExpiry = await stores.refreshTokenStore.get('rt-1');

      expect(beforeExpiry).toEqual(refreshToken({ iat: NOW }));
      expect(atExpiry).toBeUndefined();
    });

    it('should revoke the refresh tokens of a grant, the rotated ones included', async () => {
      await stores.refreshTokenStore.set('rt-1', refreshToken({ used: true }));
      await stores.refreshTokenStore.set('rt-2', refreshToken());
      await stores.refreshTokenStore.set('rt-3', refreshToken({ grantId: 'grant-2' }));

      await stores.refreshTokenStore.revokeByGrantId('grant-1');

      expect(await stores.refreshTokenStore.get('rt-1')).toBeUndefined();
      expect(await stores.refreshTokenStore.get('rt-2')).toBeUndefined();
      expect(await stores.refreshTokenStore.get('rt-3')).toEqual(refreshToken({ grantId: 'grant-2' }));
    });

    // RFC 7009: one token is revoked on its own.
    it('should revoke one refresh token', async () => {
      await stores.refreshTokenStore.set('rt-1', refreshToken());
      await stores.refreshTokenStore.set('rt-2', refreshToken());

      await stores.refreshTokenStore.revoke('rt-1');

      expect(await stores.refreshTokenStore.get('rt-1')).toBeUndefined();
      expect(await stores.refreshTokenStore.get('rt-2')).toEqual(refreshToken());
    });

    it('should store the token under its SHA-256 hash, never the token itself', async () => {
      await stores.refreshTokenStore.set('rt-1', refreshToken());

      expect(await rows('SELECT id, access_token_id, exp, iat, is_used, grant_id FROM refresh_tokens')).toEqual([
        { id: await sha256('rt-1'), access_token_id: null, exp: NOW + 86_400, iat: null, is_used: 0, grant_id: 'grant-1' },
      ]);
    });

    it('should link a refresh token to the access token of the same token response', async () => {
      await stores.accessTokenStore.set('at-1', accessToken({ jti: 'jti-1', iat: NOW }));
      await stores.refreshTokenStore.set('rt-1', refreshToken({ iat: NOW }));
      vi.setSystemTime(NOW_MS + 60_000);
      await stores.accessTokenStore.set('at-2', accessToken({ jti: 'jti-2', iat: NOW + 60 }));
      await stores.refreshTokenStore.set('rt-2', refreshToken({ iat: NOW + 60 }));

      expect(await rows('SELECT id, access_token_id FROM refresh_tokens ORDER BY iat')).toEqual([
        { id: await sha256('rt-1'), access_token_id: 'jti-1' },
        { id: await sha256('rt-2'), access_token_id: 'jti-2' },
      ]);
    });
  });

  describe('authSessionStore', () => {
    it('should return the login hand-off of a transaction until it is deleted', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.authSessionStore.set('txn-1', { subject: 'alice', authTime: NOW, sessionId: 'session-1' });
      const stored = await stores.authSessionStore.get('txn-1');
      await stores.authSessionStore.delete('txn-1');

      expect(stored).toEqual({ subject: 'alice', authTime: NOW, sessionId: 'session-1' });
      expect(await stores.authSessionStore.get('txn-1')).toBeUndefined();
    });

    it('should return a login hand-off without a browser session without sessionId', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.authSessionStore.set('txn-1', { subject: 'alice', authTime: NOW });

      expect(await stores.authSessionStore.get('txn-1')).toEqual({ subject: 'alice', authTime: NOW });
    });

    it('should move the transaction to authenticated', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);

      await stores.authSessionStore.set('txn-1', { subject: 'alice', authTime: NOW });

      expect(await statusOf('txn-1')).toEqual([{ status: 'authenticated' }]);
      expect(await stores.transactionStore.get('auth_txn:txn-1')).toEqual(transaction());
    });

    it('should record password as the auth type of a user without a federated identity', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);

      await stores.authSessionStore.set('txn-1', { subject: 'alice', authTime: NOW });

      expect(await rows('SELECT user_id, auth_type FROM auth_users')).toEqual([{ user_id: 'alice', auth_type: 'password' }]);
    });

    it('should record the provider of the federated identity of the user as the auth type', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      const user = await stores.userStore.linkFederatedIdentity({ provider: 'google', subject: 'google-sub-1', claims: {} });

      await stores.authSessionStore.set('txn-1', { subject: user.sub, authTime: NOW });

      expect(await rows('SELECT user_id, auth_type FROM auth_users')).toEqual([{ user_id: user.sub, auth_type: 'google' }]);
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

    it('should replace a browser session saved again under the same id', async () => {
      await stores.browserSessionStore.set('session-1', { subject: 'alice', authTime: NOW });
      await stores.browserSessionStore.set('session-1', { subject: 'bob', authTime: NOW + 60 });

      expect(await stores.browserSessionStore.get('session-1')).toEqual({ subject: 'bob', authTime: NOW + 60 });
    });
  });

  describe('consentStore', () => {
    // OIDC Core 1.0 §3.1.2.1: prompt=none relies on consent to every requested scope.
    it('should report consent only when every requested scope was granted', async () => {
      await stores.consentStore.grant('alice', 'rp-1', ['openid']);
      await stores.consentStore.grant('alice', 'rp-1', ['profile', 'openid']);

      expect(await stores.consentStore.hasConsent('alice', 'rp-1', ['openid', 'profile'])).toBe(true);
      expect(await stores.consentStore.hasConsent('alice', 'rp-1', ['openid', 'openid'])).toBe(true);
      expect(await stores.consentStore.hasConsent('alice', 'rp-1', ['openid', 'email'])).toBe(false);
      expect(await stores.consentStore.hasConsent('alice', 'rp-2', ['openid'])).toBe(false);
      expect(await stores.consentStore.hasConsent('bob', 'rp-1', ['openid'])).toBe(false);
    });

    it('should report no consent for an empty scope list', async () => {
      await stores.consentStore.grant('alice', 'rp-1', ['openid']);

      expect(await stores.consentStore.hasConsent('alice', 'rp-1', [])).toBe(false);
    });

    it('should save nothing when no scope is granted', async () => {
      await stores.consentStore.grant('alice', 'rp-1', []);

      expect(await rows('SELECT COUNT(*) AS count FROM consent_scopes')).toEqual([{ count: 0 }]);
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

    it('should record a grant only once', async () => {
      await stores.consentStore.recordGrant('alice', 'rp-1', 'grant-1');
      await stores.consentStore.recordGrant('alice', 'rp-1', 'grant-1');

      expect(await stores.consentStore.revoke('alice', 'rp-1')).toEqual(['grant-1']);
    });

    it('should keep the consent and the grants of another client when one is revoked', async () => {
      await stores.consentStore.grant('alice', 'rp-1', ['openid']);
      await stores.consentStore.grant('alice', 'rp-2', ['openid']);
      await stores.consentStore.recordGrant('alice', 'rp-2', 'grant-2');

      await stores.consentStore.revoke('alice', 'rp-1');

      expect(await stores.consentStore.hasConsent('alice', 'rp-2', ['openid'])).toBe(true);
      expect(await stores.consentStore.revoke('alice', 'rp-2')).toEqual(['grant-2']);
    });
  });

  describe('userStore', () => {
    it('should authenticate a user by sub and password and return the claims with the password hash', async () => {
      await registerUser(db, { sub: 'alice', email: 'alice@example.com', name: 'Alice', password: 'correct horse' });
      const [{ password_hash }] = (await rows("SELECT password_hash FROM users WHERE id = 'alice'")) as Array<{
        password_hash: string;
      }>;

      const user = await stores.userStore.authenticate('alice', 'correct horse');

      expect(user).toEqual({
        sub: 'alice',
        name: 'Alice',
        email: 'alice@example.com',
        email_verified: false,
        password: password_hash,
      });
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

    // OIDC Core 1.0 §5.1: email_verified accompanies email.
    it('should return email_verified with the email of a user', async () => {
      await registerUser(db, { sub: 'alice', email: 'alice@example.com', email_verified: true });
      await registerUser(db, { sub: 'bob', email: 'bob@example.com' });

      expect(await stores.userStore.getClaims('alice')).toEqual({ sub: 'alice', email: 'alice@example.com', email_verified: true });
      expect(await stores.userStore.getClaims('bob')).toEqual({ sub: 'bob', email: 'bob@example.com', email_verified: false });
    });

    it('should create a user under a new random sub on the first sign-in of an upstream account', async () => {
      const claims = await stores.userStore.linkFederatedIdentity({
        provider: 'google',
        subject: 'google-sub-1',
        claims: { email: 'alice@gmail.com', email_verified: true, name: 'Alice' },
      });

      expect(claims).toEqual({
        sub: expect.stringMatching(UUID_V4),
        email: 'alice@gmail.com',
        email_verified: true,
        name: 'Alice',
      });
      expect(await rows('SELECT user_id, provider, provider_sub FROM federated_identities')).toEqual([
        { user_id: claims.sub, provider: 'google', provider_sub: 'google-sub-1' },
      ]);
      expect(await stores.userStore.getClaims(claims.sub)).toEqual(claims);
    });

    it('should find the same user on a later sign-in and save the newly asserted claims', async () => {
      const first = await stores.userStore.linkFederatedIdentity({
        provider: 'google',
        subject: 'google-sub-1',
        claims: { email: 'alice@gmail.com', name: 'Alice' },
      });
      vi.setSystemTime(NOW_MS + 60_000);
      const second = await stores.userStore.linkFederatedIdentity({
        provider: 'google',
        subject: 'google-sub-1',
        claims: { email: 'alice@example.com' },
      });

      expect(second).toEqual({ sub: first.sub, email: 'alice@example.com' });
      expect(await stores.userStore.getClaims(first.sub)).toEqual({
        sub: first.sub,
        email: 'alice@example.com',
        email_verified: false,
      });
      expect(await rows('SELECT id, created_at, updated_at FROM users')).toEqual([
        { id: first.sub, created_at: NOW, updated_at: NOW + 60 },
      ]);
    });

    it('should keep accounts of different providers apart even with the same upstream subject', async () => {
      const google = await stores.userStore.linkFederatedIdentity({ provider: 'google', subject: 'shared', claims: {} });
      const other = await stores.userStore.linkFederatedIdentity({ provider: 'other', subject: 'shared', claims: {} });

      expect(other.sub).not.toBe(google.sub);
      expect(await rows('SELECT COUNT(*) AS count FROM users')).toEqual([{ count: 2 }]);
    });

    // UNIQUE (provider, provider_sub) keeps one federated identity, and the user of the losing request is removed.
    it('should link two concurrent first sign-ins of one upstream account to one user', async () => {
      const identity = { provider: 'google', subject: 'google-sub-1', claims: {} };

      const [first, second] = await Promise.all([
        stores.userStore.linkFederatedIdentity(identity),
        stores.userStore.linkFederatedIdentity(identity),
      ]);

      expect(second.sub).toBe(first.sub);
      expect(await rows('SELECT id FROM users')).toEqual([{ id: first.sub }]);
    });

    it('should not authenticate a user created by an upstream sign-in with the login form', async () => {
      const user = await stores.userStore.linkFederatedIdentity({ provider: 'google', subject: 'google-sub-1', claims: {} });

      expect(await stores.userStore.authenticate(user.sub, '')).toBeUndefined();
    });
  });

  describe('upstreamLoginStore', () => {
    it('should find a saved upstream login until its expiry, then undefined', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction({ expiresAt: NOW_MS + 1000 }), 1);
      await stores.upstreamLoginStore.save('nonce-1', { provider: 'google', transactionId: 'txn-1', expiresAt: NOW_MS + 1000 });

      vi.setSystemTime(NOW_MS + 999);
      const beforeExpiry = await stores.upstreamLoginStore.find('nonce-1');
      vi.setSystemTime(NOW_MS + 1000);
      const atExpiry = await stores.upstreamLoginStore.find('nonce-1');

      expect(beforeExpiry).toEqual({ provider: 'google', transactionId: 'txn-1', expiresAt: NOW_MS + 1000 });
      expect(atExpiry).toBeUndefined();
    });

    it('should move the transaction to upstream_pending and keep it in progress', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);

      await stores.upstreamLoginStore.save('nonce-1', { provider: 'google', transactionId: 'txn-1', expiresAt: NOW_MS + 60_000 });

      expect(await statusOf('txn-1')).toEqual([{ status: 'upstream_pending' }]);
      expect(await stores.transactionStore.get('auth_txn:txn-1')).toEqual(transaction());
    });

    it('should replace the nonce of an older login page of the same transaction', async () => {
      const expiresAt = NOW_MS + 60_000;
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.transactionStore.put('auth_txn:txn-2', transaction(), 60);
      await stores.upstreamLoginStore.save('nonce-old', { provider: 'google', transactionId: 'txn-1', expiresAt });
      await stores.upstreamLoginStore.save('nonce-other', { provider: 'google', transactionId: 'txn-2', expiresAt });
      await stores.upstreamLoginStore.save('nonce-new', { provider: 'google', transactionId: 'txn-1', expiresAt });

      expect(await stores.upstreamLoginStore.find('nonce-old')).toBeUndefined();
      expect(await stores.upstreamLoginStore.find('nonce-other')).toEqual({ provider: 'google', transactionId: 'txn-2', expiresAt });
      expect(await stores.upstreamLoginStore.find('nonce-new')).toEqual({ provider: 'google', transactionId: 'txn-1', expiresAt });
    });

    it('should forget a deleted upstream login', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.upstreamLoginStore.save('nonce-1', { provider: 'google', transactionId: 'txn-1', expiresAt: NOW_MS + 60_000 });
      await stores.upstreamLoginStore.delete('nonce-1');

      expect(await stores.upstreamLoginStore.find('nonce-1')).toBeUndefined();
    });

    it('should keep the newer login of a transaction when the nonce of an older one is deleted', async () => {
      const expiresAt = NOW_MS + 60_000;
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.upstreamLoginStore.save('nonce-old', { provider: 'google', transactionId: 'txn-1', expiresAt });
      await stores.upstreamLoginStore.save('nonce-new', { provider: 'google', transactionId: 'txn-1', expiresAt });

      await stores.upstreamLoginStore.delete('nonce-old');

      expect(await stores.upstreamLoginStore.find('nonce-new')).toEqual({ provider: 'google', transactionId: 'txn-1', expiresAt });
    });
  });
});
