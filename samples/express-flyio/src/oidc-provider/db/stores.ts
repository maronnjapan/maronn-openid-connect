/**
 * ProviderStores (store.ts) on a SQL database: the stores the OP uses when no
 * other storage is passed in. Every query is one SQL statement run through the
 * SqlDatabase that db/instance.ts creates; db/schema.sql defines the tables.
 *
 * Rewriting this file for another driver or an ORM is fine, but keep these
 * behaviors - routes/ and resolvers.ts rely on them:
 *
 * 1. Keep the ProviderStores types (method names, parameters, return values).
 * 2. authCodeStore.consume and refreshTokenStore.consume flip used from 0 to 1
 *    in ONE conditional UPDATE, and throw TokenError (invalid_grant) when it
 *    changed no row. A SELECT followed by an UPDATE lets two concurrent requests
 *    both see an unused code and both receive tokens (OAuth 2.1 §4.1.2).
 * 3. consume never deletes the row. A used code or a rotated refresh token has
 *    to stay readable, so a replay is detected and the grant's tokens revoked.
 * 4. get never returns an expired row, and does return used ones.
 * 5. revokeByGrantId also removes the rotated (used) refresh tokens of the grant.
 * 6. hasConsent is true only when every requested scope was granted.
 * 7. Codes and tokens are stored and looked up by their SHA-256 hash; the raw
 *    value is never written to the database.
 */
import {
  TokenError,
  TokenErrorCode,
  type AccessTokenInfo,
  type AuthTransaction,
  type AuthTransactionStore,
  type AuthorizationCodeInfo,
  type RefreshTokenInfo,
  type UserClaims,
} from '@maronn-openid-connect/core';
import type { GoogleLoginNonceRecord, GoogleLoginNonceStore } from '@maronn-openid-connect/google-login';
import {
  UserStore,
  googleAccountToClaims,
  type AccessTokenStorage,
  type AuthSessionInfo,
  type AuthSessionStorage,
  type AuthorizationCodeStorage,
  type BrowserSessionStorage,
  type ConsentStorage,
  type ProviderStores,
  type RefreshTokenStorage,
  type UserStorage,
} from '../store.js';
import type { SqlDatabase } from './database.js';

// Password users are the fixed development users of store.ts (testuser /
// otheruser). Users provisioned by "Sign in with Google" are stored in the
// google_users table. Connect your own user table here: authenticate() checks
// a login, getClaims() returns the claims of a subject.
const fixedUsers = new UserStore();

export function createSqlProviderStores(db: SqlDatabase): ProviderStores {
  const transactionStore: AuthTransactionStore = {
    async get(key) {
      const [row] = await db.all<{ payload: string }>({
        sql: 'SELECT payload FROM auth_transactions WHERE id = ? AND expires_at > ?',
        params: [key, nowSeconds()],
      });
      return row ? (JSON.parse(row.payload) as AuthTransaction) : null;
    },
    async put(key, value, ttlSeconds) {
      // value.expiresAt is in milliseconds; the column is epoch seconds.
      await db.run({
        sql:
          'INSERT INTO auth_transactions (id, expires_at, payload) VALUES (?, ?, ?) ' +
          'ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at, payload = excluded.payload',
        params: [key, nowSeconds() + ttlSeconds, JSON.stringify(value)],
      });
    },
    async delete(key) {
      await db.run({ sql: 'DELETE FROM auth_transactions WHERE id = ?', params: [key] });
    },
  };

  const authCodeStore: AuthorizationCodeStorage = {
    async set(code, info) {
      // Neither the raw code nor the used flag (a column) goes into payload.
      const { code: _code, used, ...payload } = info;
      await db.run({
        sql:
          'INSERT INTO authorization_codes (code_hash, grant_id, client_id, used, expires_at, payload) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
        params: [
          await hashKey(code),
          info.grantId,
          info.clientId,
          used ? 1 : 0,
          info.expiresAt,
          JSON.stringify(payload),
        ],
      });
    },
    async get(code) {
      const [row] = await db.all<{ used: number; payload: string }>({
        sql: 'SELECT used, payload FROM authorization_codes WHERE code_hash = ? AND expires_at > ?',
        params: [await hashKey(code), nowSeconds()],
      });
      if (!row) return undefined;
      const payload = JSON.parse(row.payload) as Omit<AuthorizationCodeInfo, 'code' | 'used'>;
      return { ...payload, code, used: Number(row.used) === 1 };
    },
    // Only one of two concurrent requests changes the row; the other one finds
    // the code already used and must not receive tokens.
    async consume(code) {
      const { changes } = await db.run({
        sql: 'UPDATE authorization_codes SET used = 1 WHERE code_hash = ? AND used = 0',
        params: [await hashKey(code)],
      });
      if (changes === 0) {
        throw new TokenError(TokenErrorCode.InvalidGrant, 'Authorization code has already been used');
      }
    },
    async delete(code) {
      await db.run({
        sql: 'DELETE FROM authorization_codes WHERE code_hash = ?',
        params: [await hashKey(code)],
      });
    },
  };

  const deleteAccessToken = async (token: string): Promise<void> => {
    await db.run({
      sql: 'DELETE FROM access_tokens WHERE token_hash = ?',
      params: [await hashKey(token)],
    });
  };

  const accessTokenStore: AccessTokenStorage = {
    async set(token, info) {
      await db.run({
        sql:
          'INSERT INTO access_tokens (token_hash, grant_id, client_id, expires_at, payload) ' +
          'VALUES (?, ?, ?, ?, ?)',
        params: [
          await hashKey(token),
          info.grantId ?? null,
          info.clientId,
          info.expiresAt,
          JSON.stringify(info),
        ],
      });
    },
    async get(token) {
      const [row] = await db.all<{ payload: string }>({
        sql: 'SELECT payload FROM access_tokens WHERE token_hash = ? AND expires_at > ?',
        params: [await hashKey(token), nowSeconds()],
      });
      return row ? (JSON.parse(row.payload) as AccessTokenInfo) : undefined;
    },
    delete: deleteAccessToken,
    revoke: deleteAccessToken,
    async revokeByGrantId(grantId) {
      await db.run({ sql: 'DELETE FROM access_tokens WHERE grant_id = ?', params: [grantId] });
    },
  };

  const deleteRefreshToken = async (token: string): Promise<void> => {
    await db.run({
      sql: 'DELETE FROM refresh_tokens WHERE token_hash = ?',
      params: [await hashKey(token)],
    });
  };

  const refreshTokenStore: RefreshTokenStorage = {
    async set(token, info) {
      const { used, ...payload } = info;
      await db.run({
        sql:
          'INSERT INTO refresh_tokens (token_hash, grant_id, client_id, used, expires_at, payload) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
        params: [
          await hashKey(token),
          info.grantId,
          info.clientId,
          used ? 1 : 0,
          info.expiresAt,
          JSON.stringify(payload),
        ],
      });
    },
    async get(token) {
      const [row] = await db.all<{ used: number; payload: string }>({
        sql: 'SELECT used, payload FROM refresh_tokens WHERE token_hash = ? AND expires_at > ?',
        params: [await hashKey(token), nowSeconds()],
      });
      if (!row) return undefined;
      const payload = JSON.parse(row.payload) as Omit<RefreshTokenInfo, 'used'>;
      return { ...payload, used: Number(row.used) === 1 };
    },
    // Rotation: like authCodeStore.consume, exactly one request wins.
    async consume(token) {
      const { changes } = await db.run({
        sql: 'UPDATE refresh_tokens SET used = 1 WHERE token_hash = ? AND used = 0',
        params: [await hashKey(token)],
      });
      if (changes === 0) {
        throw new TokenError(TokenErrorCode.InvalidGrant, 'Refresh token has already been used');
      }
    },
    delete: deleteRefreshToken,
    revoke: deleteRefreshToken,
    // Rotated (used) refresh tokens share the grant_id, so they go too.
    async revokeByGrantId(grantId) {
      await db.run({ sql: 'DELETE FROM refresh_tokens WHERE grant_id = ?', params: [grantId] });
    },
  };

  const authSessionStore: AuthSessionStorage = {
    async set(transactionId, info) {
      await db.run({
        sql:
          'INSERT INTO auth_sessions (transaction_id, payload) VALUES (?, ?) ' +
          'ON CONFLICT (transaction_id) DO UPDATE SET payload = excluded.payload',
        params: [transactionId, JSON.stringify(info)],
      });
    },
    async get(transactionId) {
      const [row] = await db.all<{ payload: string }>({
        sql: 'SELECT payload FROM auth_sessions WHERE transaction_id = ?',
        params: [transactionId],
      });
      return row ? (JSON.parse(row.payload) as AuthSessionInfo) : undefined;
    },
    async delete(transactionId) {
      await db.run({
        sql: 'DELETE FROM auth_sessions WHERE transaction_id = ?',
        params: [transactionId],
      });
    },
  };

  const browserSessionStore: BrowserSessionStorage = {
    async set(sessionId, info) {
      await db.run({
        sql:
          'INSERT INTO browser_sessions (session_id, subject, auth_time) VALUES (?, ?, ?) ' +
          'ON CONFLICT (session_id) DO UPDATE SET subject = excluded.subject, auth_time = excluded.auth_time',
        params: [sessionId, info.subject, info.authTime],
      });
    },
    async get(sessionId) {
      const [row] = await db.all<{ subject: string; auth_time: number }>({
        sql: 'SELECT subject, auth_time FROM browser_sessions WHERE session_id = ?',
        params: [sessionId],
      });
      return row ? { subject: row.subject, authTime: Number(row.auth_time) } : undefined;
    },
    async delete(sessionId) {
      await db.run({ sql: 'DELETE FROM browser_sessions WHERE session_id = ?', params: [sessionId] });
    },
  };

  const consentStore: ConsentStorage = {
    async grant(subject, clientId, scopes) {
      const unique = [...new Set(scopes)];
      if (unique.length === 0) return;
      // Scopes granted before are skipped by ON CONFLICT DO NOTHING; new ones are added.
      await db.run({
        sql:
          'INSERT INTO consent_scopes (subject, client_id, scope) VALUES ' +
          unique.map(() => '(?, ?, ?)').join(', ') +
          ' ON CONFLICT DO NOTHING',
        params: unique.flatMap((scope) => [subject, clientId, scope]),
      });
    },
    async hasConsent(subject, clientId, scopes) {
      const unique = [...new Set(scopes)];
      // An empty request is never treated as consented (and IN () is not valid SQL).
      if (unique.length === 0) return false;
      const [row] = await db.all<{ granted: number }>({
        sql:
          'SELECT COUNT(*) AS granted FROM consent_scopes ' +
          'WHERE subject = ? AND client_id = ? AND scope IN (' +
          unique.map(() => '?').join(', ') +
          ')',
        params: [subject, clientId, ...unique],
      });
      // A partially granted request counts fewer rows than it asked for.
      return Number(row?.granted ?? 0) === unique.length;
    },
    async recordGrant(subject, clientId, grantId) {
      await db.run({
        sql:
          'INSERT INTO consent_grants (subject, client_id, grant_id) VALUES (?, ?, ?) ' +
          'ON CONFLICT DO NOTHING',
        params: [subject, clientId, grantId],
      });
    },
    async revoke(subject, clientId) {
      await db.run({
        sql: 'DELETE FROM consent_scopes WHERE subject = ? AND client_id = ?',
        params: [subject, clientId],
      });
      // DELETE ... RETURNING hands back every grant it removed, in the same
      // statement, so the caller revokes the tokens of each one.
      const rows = await db.all<{ grant_id: string }>({
        sql: 'DELETE FROM consent_grants WHERE subject = ? AND client_id = ? RETURNING grant_id',
        params: [subject, clientId],
      });
      return rows.map((row) => row.grant_id);
    },
  };

  const userStore: UserStorage = {
    authenticate: (username, password) => fixedUsers.authenticate(username, password),
    async getClaims(sub) {
      const fixed = fixedUsers.getClaims(sub);
      if (fixed) return fixed;
      const [row] = await db.all<{ claims: string }>({
        sql: 'SELECT claims FROM google_users WHERE sub = ?',
        params: [sub],
      });
      return row ? (JSON.parse(row.claims) as UserClaims) : undefined;
    },
    // EXTENSION (google-login): create or refresh the user of a verified Google account.
    async linkGoogleAccount(account) {
      const claims = googleAccountToClaims(account);
      await db.run({
        sql:
          'INSERT INTO google_users (sub, claims) VALUES (?, ?) ' +
          'ON CONFLICT (sub) DO UPDATE SET claims = excluded.claims',
        params: [claims.sub, JSON.stringify(claims)],
      });
      return claims;
    },
  };

  // EXTENSION (google-login): same lifetime rule as the authorization transactions.
  const googleLoginNonceStore: GoogleLoginNonceStore = {
    async get(key) {
      const [row] = await db.all<{ payload: string }>({
        sql: 'SELECT payload FROM google_login_nonces WHERE id = ? AND expires_at > ?',
        params: [key, nowSeconds()],
      });
      return row ? (JSON.parse(row.payload) as GoogleLoginNonceRecord) : null;
    },
    async put(key, value, ttlSeconds) {
      await db.run({
        sql:
          'INSERT INTO google_login_nonces (id, expires_at, payload) VALUES (?, ?, ?) ' +
          'ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at, payload = excluded.payload',
        params: [key, nowSeconds() + ttlSeconds, JSON.stringify(value)],
      });
    },
    async delete(key) {
      await db.run({ sql: 'DELETE FROM google_login_nonces WHERE id = ?', params: [key] });
    },
  };

  return {
    transactionStore,
    authCodeStore,
    accessTokenStore,
    refreshTokenStore,
    authSessionStore,
    browserSessionStore,
    consentStore,
    userStore,
    googleLoginNonceStore,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The key a code or token is stored under: its SHA-256 hash, base64url-encoded. */
async function hashKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
