import type {
  AccessTokenInfo,
  AuthTransaction,
  AuthorizationCodeData,
  AuthorizationCodeInfo,
  RefreshTokenInfo,
} from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapKvDatabase, type MapKvDatabase } from '../../../test-support/databases.js';
import type { ProviderStores } from '../../store.js';
import { readRecord } from './database.js';
import {
  keys,
  type AccessTokenRecord,
  type AuthUserRecord,
  type CodeRecord,
  type FederatedIdentityRecord,
  type RefreshTokenRecord,
  type TransactionRecord,
  type TransactionResultRecord,
  type UserRecord,
} from './keys.js';
import { createProviderStores } from './stores.js';
import { registerUser } from './users.js';

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW_MS = Date.UTC(2026, 0, 1);
const NOW = NOW_MS / 1000;

/** RFC 9562 §5.4: a version 4 UUID, which crypto.randomUUID() returns. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let db: MapKvDatabase;
let stores: ProviderStores;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  db = createMapKvDatabase();
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

function storedKeys(): string[] {
  return db.entries().map(([key]) => key);
}

/** The status of a transaction in progress, and how it ended. */
async function stateOf(transactionId: string): Promise<{ status?: string; result?: string }> {
  const record = await readRecord<TransactionRecord>(db, keys.transaction(transactionId));
  const result = await readRecord<TransactionResultRecord>(db, keys.transactionResult(transactionId));
  return { status: record?.status, result: result?.status };
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
      expect(db.entries()).toEqual([]);
    });

    it('should return every parameter of the authorization request it was stored with', async () => {
      const stored = transaction({
        state: 'state-1',
        nonce: 'nonce-1',
        codeChallenge: 'challenge-1',
        codeChallengeMethod: 'S256',
        prompt: 'consent',
        maxAge: 300,
        acrValues: 'urn:acr:1',
        loginHint: 'alice',
        uiLocales: 'ja en',
        audience: ['https://api.example.com'],
        claims: { userinfo: { email: { essential: true } } },
        bindingHash: 'binding-1',
        failedAttempts: 2,
      });
      await stores.transactionStore.put('auth_txn:txn-1', stored, 60);

      expect(await stores.transactionStore.get('auth_txn:txn-1')).toEqual(stored);
    });

    it('should save a new transaction as requested under its id without the auth_txn: prefix', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);

      expect(storedKeys()).toEqual(['oidc:transaction:txn-1']);
      expect(await readRecord<TransactionRecord>(db, keys.transaction('txn-1'))).toMatchObject({
        status: 'requested',
        created_at: NOW,
        expired_at: NOW + 60,
      });
    });

    it('should end a deleted transaction as failed and return null for it', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.transactionStore.delete('auth_txn:txn-1');

      expect(await stores.transactionStore.get('auth_txn:txn-1')).toBeNull();
      expect(await stateOf('txn-1')).toEqual({ status: 'requested', result: 'failed' });
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
      expect(await stateOf('txn-1')).toEqual({ status: 'upstream_pending' });
    });
  });

  describe('authCodeStore', () => {
    it('should mark a consumed code used and keep returning it', async () => {
      await stores.authCodeStore.set('code-1', code());
      await stores.authCodeStore.consume('code-1');

      expect(await stores.authCodeStore.get('code-1')).toEqual(code({ used: true }));
    });

    it('should return a code stored as used with used: true', async () => {
      await stores.authCodeStore.set('code-1', code({ used: true }));

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

    // OAuth 2.1 §4.1.2: setIfAbsent claims the code, so two concurrent requests cannot both use it.
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

    it('should let a consumed code, its used marker and its grant expire with the code', async () => {
      await stores.authCodeStore.set('code-1', code());
      await stores.authCodeStore.consume('code-1');
      const beforeExpiry = storedKeys();

      vi.setSystemTime(NOW_MS + 300_000);

      const codeHash = await sha256('code-1');
      expect(beforeExpiry).toEqual([keys.code(codeHash), keys.grant('grant-1'), keys.codeUsed(codeHash)]);
      expect(storedKeys()).toEqual([]);
      await expect(stores.authCodeStore.consume('code-1')).rejects.toThrow(expect.objectContaining({ error: 'invalid_grant' }));
    });

    it('should store the code under its SHA-256 hash, never the code itself', async () => {
      await stores.authCodeStore.set('code-1', code());

      const codeHash = await sha256('code-1');
      expect(storedKeys()).toEqual([keys.code(codeHash), keys.grant('grant-1')]);
      expect(await readRecord<CodeRecord>(db, keys.code(codeHash))).toEqual({
        transaction_id: null,
        expired_at: NOW + 300,
        grant_id: 'grant-1',
        payload: {
          clientId: 'rp-1',
          redirectUri: 'https://rp.example.com/callback',
          redirectUriExplicit: true,
          scope: ['openid'],
        },
      });
    });

    it('should forget a deleted code and its used marker', async () => {
      await stores.authCodeStore.set('code-1', code());
      await stores.authCodeStore.consume('code-1');
      await stores.authCodeStore.delete('code-1');

      expect(await stores.authCodeStore.get('code-1')).toBeUndefined();
      expect(storedKeys()).toEqual([keys.grant('grant-1')]);
    });

    it('should end the transaction a code is issued from as code_issued', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.transactionStore.delete('auth_txn:txn-1');

      await stores.authCodeStore.set('code-1', issuedCode('txn-1'));

      expect(await stateOf('txn-1')).toEqual({ status: 'requested', result: 'code_issued' });
      expect(await readRecord<CodeRecord>(db, keys.code(await sha256('code-1')))).toMatchObject({ transaction_id: 'txn-1' });
    });

    it('should keep the result of the transaction until the code expires', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.authCodeStore.set('code-1', issuedCode('txn-1'));

      vi.setSystemTime(NOW_MS + 299_999);
      const beforeExpiry = await stateOf('txn-1');
      vi.setSystemTime(NOW_MS + 300_000);
      const atExpiry = await stateOf('txn-1');

      expect(beforeExpiry).toEqual({ result: 'code_issued' });
      expect(atExpiry).toEqual({});
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
      expect(storedKeys()).toEqual([keys.grant('grant-1'), keys.accessToken(tokenHash)]);
      expect(await readRecord<AccessTokenRecord>(db, keys.accessToken(tokenHash))).toEqual({
        id: tokenHash,
        sub: 'alice',
        exp: NOW + 3600,
        iat: null,
        iss: null,
        client_id: 'rp-1',
        scope: 'openid',
        acr: null,
        transaction_id: null,
        grant_id: 'grant-1',
        payload: {},
      });
      expect(await stores.accessTokenStore.get('at-1')).toEqual(accessToken());
    });

    it('should store a token without a grant and without a scope', async () => {
      const stored: AccessTokenInfo = { sub: 'alice', scope: [], clientId: 'rp-1', expiresAt: NOW + 3600 };
      await stores.accessTokenStore.set('at-1', stored);

      expect(storedKeys()).toEqual([keys.accessToken(await sha256('at-1'))]);
      expect(await stores.accessTokenStore.get('at-1')).toEqual(stored);
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

    it('should keep the revocation of a grant until its last token expires', async () => {
      await stores.accessTokenStore.set('at-1', accessToken());
      await stores.accessTokenStore.revokeByGrantId('grant-1');

      vi.setSystemTime(NOW_MS + 3_599_999);
      const beforeExpiry = storedKeys();
      vi.setSystemTime(NOW_MS + 3_600_000);

      expect(beforeExpiry).toEqual([
        keys.grant('grant-1'),
        keys.accessToken(await sha256('at-1')),
        keys.grantAccessTokensRevoked('grant-1'),
      ]);
      expect(storedKeys()).toEqual([]);
    });

    it('should write nothing to revoke a grant that has no record', async () => {
      await stores.accessTokenStore.revokeByGrantId('grant-1');

      expect(storedKeys()).toEqual([]);
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

    it('should end the transaction of the code of its grant as token_issued', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.authCodeStore.set('code-1', issuedCode('txn-1'));

      await stores.accessTokenStore.set('at-1', accessToken());

      expect(await stateOf('txn-1')).toEqual({ status: 'requested', result: 'token_issued' });
      expect(await readRecord<AccessTokenRecord>(db, keys.accessToken(await sha256('at-1')))).toMatchObject({
        transaction_id: 'txn-1',
      });
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
    it('should revoke one refresh token and its used marker', async () => {
      await stores.refreshTokenStore.set('rt-1', refreshToken({ used: true }));
      await stores.refreshTokenStore.set('rt-2', refreshToken());

      await stores.refreshTokenStore.revoke('rt-1');

      expect(await stores.refreshTokenStore.get('rt-1')).toBeUndefined();
      expect(await stores.refreshTokenStore.get('rt-2')).toEqual(refreshToken());
      expect(storedKeys()).toEqual([keys.grant('grant-1'), keys.refreshToken(await sha256('rt-2'))]);
    });

    it('should store the token under its SHA-256 hash, never the token itself', async () => {
      await stores.refreshTokenStore.set('rt-1', refreshToken());

      const tokenHash = await sha256('rt-1');
      expect(storedKeys()).toEqual([keys.grant('grant-1'), keys.refreshToken(tokenHash)]);
      expect(await readRecord<RefreshTokenRecord>(db, keys.refreshToken(tokenHash))).toEqual({
        access_token_id: null,
        exp: NOW + 86_400,
        iat: null,
        grant_id: 'grant-1',
        payload: {
          subject: 'alice',
          clientId: 'rp-1',
          scope: ['openid', 'offline_access'],
          originalIssuedAt: NOW,
          authTime: NOW,
        },
      });
    });

    it('should link a refresh token to the access token of the same token response', async () => {
      await stores.accessTokenStore.set('at-1', accessToken({ jti: 'jti-1', iat: NOW }));
      await stores.refreshTokenStore.set('rt-1', refreshToken({ iat: NOW }));
      vi.setSystemTime(NOW_MS + 60_000);
      await stores.accessTokenStore.set('at-2', accessToken({ jti: 'jti-2', iat: NOW + 60 }));
      await stores.refreshTokenStore.set('rt-2', refreshToken({ iat: NOW + 60 }));

      expect(await readRecord<RefreshTokenRecord>(db, keys.refreshToken(await sha256('rt-1')))).toMatchObject({
        access_token_id: 'jti-1',
      });
      expect(await readRecord<RefreshTokenRecord>(db, keys.refreshToken(await sha256('rt-2')))).toMatchObject({
        access_token_id: 'jti-2',
      });
    });

    it('should not link a refresh token to an access token issued at another time', async () => {
      await stores.accessTokenStore.set('at-1', accessToken({ jti: 'jti-1', iat: NOW }));
      await stores.refreshTokenStore.set('rt-1', refreshToken({ iat: NOW + 1 }));

      expect(await readRecord<RefreshTokenRecord>(db, keys.refreshToken(await sha256('rt-1')))).toMatchObject({
        access_token_id: null,
      });
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

      expect(await stateOf('txn-1')).toEqual({ status: 'authenticated' });
      expect(await stores.transactionStore.get('auth_txn:txn-1')).toEqual(transaction());
    });

    it('should forget the login hand-off when its transaction expires', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      await stores.authSessionStore.set('txn-1', { subject: 'alice', authTime: NOW });

      vi.setSystemTime(NOW_MS + 59_999);
      const beforeExpiry = await stores.authSessionStore.get('txn-1');
      vi.setSystemTime(NOW_MS + 60_000);
      const atExpiry = await stores.authSessionStore.get('txn-1');

      expect(beforeExpiry).toEqual({ subject: 'alice', authTime: NOW });
      expect(atExpiry).toBeUndefined();
    });

    // FALLBACK_TTL_SECONDS: the transaction cannot be completed, so the record only outlives the request.
    it('should keep the login hand-off of a transaction that is gone for 600 seconds', async () => {
      await stores.authSessionStore.set('txn-gone', { subject: 'alice', authTime: NOW });

      vi.setSystemTime(NOW_MS + 599_999);
      const beforeExpiry = await stores.authSessionStore.get('txn-gone');
      vi.setSystemTime(NOW_MS + 600_000);
      const atExpiry = await stores.authSessionStore.get('txn-gone');

      expect(beforeExpiry).toEqual({ subject: 'alice', authTime: NOW });
      expect(atExpiry).toBeUndefined();
    });

    it('should record password as the auth type of a user without a federated identity', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);

      await stores.authSessionStore.set('txn-1', { subject: 'alice', authTime: NOW });

      expect(await readRecord<AuthUserRecord>(db, keys.authUser('txn-1'))).toEqual({
        user_id: 'alice',
        auth_type: 'password',
        auth_time: NOW,
        session_id: null,
      });
    });

    it('should record the provider of the federated identity of the user as the auth type', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);
      const user = await stores.userStore.linkFederatedIdentity({ provider: 'google', subject: 'google-sub-1', claims: {} });

      await stores.authSessionStore.set('txn-1', { subject: user.sub, authTime: NOW });

      expect(await readRecord<AuthUserRecord>(db, keys.authUser('txn-1'))).toEqual({
        user_id: user.sub,
        auth_type: 'google',
        auth_time: NOW,
        session_id: null,
      });
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

    it('should keep a browser session without an expiry', async () => {
      await stores.browserSessionStore.set('session-1', { subject: 'alice', authTime: NOW });

      vi.setSystemTime(NOW_MS + 365 * 86_400_000);

      expect(await stores.browserSessionStore.get('session-1')).toEqual({ subject: 'alice', authTime: NOW });
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

      expect(storedKeys()).toEqual([]);
    });

    it('should save each granted scope once', async () => {
      await stores.consentStore.grant('alice', 'rp-1', ['openid', 'profile']);
      await stores.consentStore.grant('alice', 'rp-1', ['profile', 'email']);

      expect(await readRecord(db, keys.consent('alice', 'rp-1'))).toEqual({
        scopes: ['openid', 'profile', 'email'],
        grant_ids: [],
      });
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
      const passwordHash = (await readRecord<UserRecord>(db, keys.user('alice')))?.password_hash;

      const user = await stores.userStore.authenticate('alice', 'correct horse');

      expect(user).toEqual({
        sub: 'alice',
        name: 'Alice',
        email: 'alice@example.com',
        email_verified: false,
        password: passwordHash,
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
      expect(await readRecord<FederatedIdentityRecord>(db, keys.federatedIdentity('google', 'google-sub-1'))).toEqual({
        user_id: claims.sub,
        created_at: NOW,
        updated_at: NOW,
      });
      expect(await readRecord<UserRecord>(db, keys.user(claims.sub))).toEqual({
        email: 'alice@gmail.com',
        is_verified: true,
        password_hash: null,
        created_at: NOW,
        updated_at: NOW,
        claims: { name: 'Alice' },
        federated_identities: [{ provider: 'google', provider_sub: 'google-sub-1' }],
      });
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
      expect(await readRecord<UserRecord>(db, keys.user(first.sub))).toEqual({
        email: 'alice@example.com',
        is_verified: false,
        password_hash: null,
        created_at: NOW,
        updated_at: NOW + 60,
        claims: {},
        federated_identities: [{ provider: 'google', provider_sub: 'google-sub-1' }],
      });
    });

    it('should keep accounts of different providers apart even with the same upstream subject', async () => {
      const google = await stores.userStore.linkFederatedIdentity({ provider: 'google', subject: 'shared', claims: {} });
      const other = await stores.userStore.linkFederatedIdentity({ provider: 'other', subject: 'shared', claims: {} });

      expect(other.sub).not.toBe(google.sub);
      expect(storedKeys().filter((key) => key.startsWith('oidc:user:'))).toEqual([keys.user(google.sub), keys.user(other.sub)]);
    });

    // setIfAbsent keeps one federated identity, and the request that lost uses the user it names.
    it('should link two concurrent first sign-ins of one upstream account to one user', async () => {
      const identity = { provider: 'google', subject: 'google-sub-1', claims: {} };

      const [first, second] = await Promise.all([
        stores.userStore.linkFederatedIdentity(identity),
        stores.userStore.linkFederatedIdentity(identity),
      ]);

      expect(second.sub).toBe(first.sub);
      expect(storedKeys().filter((key) => key.startsWith('oidc:user:'))).toEqual([keys.user(first.sub)]);
    });

    it('should not authenticate a user created by an upstream sign-in with the login form', async () => {
      const user = await stores.userStore.linkFederatedIdentity({ provider: 'google', subject: 'google-sub-1', claims: {} });

      expect(await stores.userStore.authenticate(user.sub, '')).toBeUndefined();
    });
  });

  describe('upstreamLoginStore', () => {
    it('should find a saved upstream login until its expiry, then undefined', async () => {
      await stores.upstreamLoginStore.save('nonce-1', { provider: 'google', transactionId: 'txn-1', expiresAt: NOW_MS + 1000 });

      vi.setSystemTime(NOW_MS + 999);
      const beforeExpiry = await stores.upstreamLoginStore.find('nonce-1');
      vi.setSystemTime(NOW_MS + 1000);
      const atExpiry = await stores.upstreamLoginStore.find('nonce-1');

      expect(beforeExpiry).toEqual({ provider: 'google', transactionId: 'txn-1', expiresAt: NOW_MS + 1000 });
      expect(atExpiry).toBeUndefined();
      expect(storedKeys()).toEqual([]);
    });

    it('should move the transaction to upstream_pending and keep it in progress', async () => {
      await stores.transactionStore.put('auth_txn:txn-1', transaction(), 60);

      await stores.upstreamLoginStore.save('nonce-1', { provider: 'google', transactionId: 'txn-1', expiresAt: NOW_MS + 60_000 });

      expect(await stateOf('txn-1')).toEqual({ status: 'upstream_pending' });
      expect(await stores.transactionStore.get('auth_txn:txn-1')).toEqual(transaction());
    });

    it('should replace the nonce of an older login page of the same transaction', async () => {
      const expiresAt = NOW_MS + 60_000;
      await stores.upstreamLoginStore.save('nonce-old', { provider: 'google', transactionId: 'txn-1', expiresAt });
      await stores.upstreamLoginStore.save('nonce-other', { provider: 'google', transactionId: 'txn-2', expiresAt });
      await stores.upstreamLoginStore.save('nonce-new', { provider: 'google', transactionId: 'txn-1', expiresAt });

      expect(await stores.upstreamLoginStore.find('nonce-old')).toBeUndefined();
      expect(await stores.upstreamLoginStore.find('nonce-other')).toEqual({ provider: 'google', transactionId: 'txn-2', expiresAt });
      expect(await stores.upstreamLoginStore.find('nonce-new')).toEqual({ provider: 'google', transactionId: 'txn-1', expiresAt });
    });

    it('should forget a deleted upstream login', async () => {
      await stores.upstreamLoginStore.save('nonce-1', { provider: 'google', transactionId: 'txn-1', expiresAt: NOW_MS + 60_000 });
      await stores.upstreamLoginStore.delete('nonce-1');

      expect(await stores.upstreamLoginStore.find('nonce-1')).toBeUndefined();
      expect(storedKeys()).toEqual([]);
    });

    it('should keep the newer login of a transaction when the nonce of an older one is deleted', async () => {
      const expiresAt = NOW_MS + 60_000;
      await stores.upstreamLoginStore.save('nonce-old', { provider: 'google', transactionId: 'txn-1', expiresAt });
      await stores.upstreamLoginStore.save('nonce-new', { provider: 'google', transactionId: 'txn-1', expiresAt });

      await stores.upstreamLoginStore.delete('nonce-old');

      expect(await stores.upstreamLoginStore.find('nonce-new')).toEqual({ provider: 'google', transactionId: 'txn-1', expiresAt });
    });
  });
});
