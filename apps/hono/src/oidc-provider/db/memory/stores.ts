/**
 * ProviderStores (store.ts) on the Maps of database.ts: the stores the OP uses
 * when no other storage is passed in.
 *
 * They behave like the stores of --db sql and --db kv, which the endpoints and
 * resolvers.ts rely on:
 *
 * 1. authCodeStore.consume and refreshTokenStore.consume throw TokenError
 *    (invalid_grant) for a code or token that is already used, so of two
 *    requests that present the same one, only one receives tokens
 *    (OAuth 2.1 §4.1.2).
 * 2. consume never deletes the record. A used code or a rotated refresh token
 *    has to stay readable, so a replay is detected and the grant's tokens
 *    revoked.
 * 3. get never returns an expired record (and removes it), and does return
 *    used ones.
 * 4. revokeByGrantId also removes the rotated (used) refresh tokens of the grant.
 * 5. hasConsent is true only when every requested scope was granted.
 */
import {
  TokenError,
  TokenErrorCode,
  type AuthTransactionStore,
  type UserClaims,
} from '@maronn-openid-connect/core';
import type {
  AccessTokenStorage,
  AuthSessionStorage,
  AuthorizationCodeStorage,
  BrowserSessionStorage,
  ConsentStorage,
  ProviderStores,
  RefreshTokenStorage,
  UpstreamLoginStorage,
  UserStorage,
} from '../../store.js';
import { federatedIdentityKey, type MemoryDatabase } from './database.js';
import { verifyPassword } from './users.js';

export function createProviderStores(db: MemoryDatabase): ProviderStores {
  const transactionStore: AuthTransactionStore = {
    async get(key) {
      const entry = db.transactions.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        db.transactions.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, ttlSeconds) {
      db.transactions.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async delete(key) {
      db.transactions.delete(key);
    },
  };

  const authCodeStore: AuthorizationCodeStorage = {
    set(code, info) {
      db.codes.set(code, { ...info });
    },
    get(code) {
      const entry = db.codes.get(code);
      if (!entry) return undefined;
      if (entry.expiresAt <= nowSeconds()) {
        db.codes.delete(code);
        return undefined;
      }
      return { ...entry };
    },
    consume(code) {
      const entry = db.codes.get(code);
      if (!entry || entry.used) {
        throw new TokenError(TokenErrorCode.InvalidGrant, 'Authorization code has already been used');
      }
      entry.used = true;
    },
    delete(code) {
      db.codes.delete(code);
    },
  };

  const accessTokenStore: AccessTokenStorage = {
    set(token, info) {
      db.accessTokens.set(token, { ...info });
    },
    get(token) {
      const entry = db.accessTokens.get(token);
      if (!entry) return undefined;
      // Lazy eviction (RFC 6819 §5.1.5.3 / RFC 9700 §4.14): drop expired entries
      // on read so an idle store does not grow unbounded. Correctness is already
      // guaranteed by the core expiry check; this only bounds retention.
      if (entry.expiresAt <= nowSeconds()) {
        db.accessTokens.delete(token);
        return undefined;
      }
      return { ...entry };
    },
    delete(token) {
      db.accessTokens.delete(token);
    },
    revokeByGrantId(grantId) {
      for (const [token, info] of db.accessTokens) {
        if (info.grantId === grantId) db.accessTokens.delete(token);
      }
    },
    revoke(token) {
      db.accessTokens.delete(token);
    },
  };

  const refreshTokenStore: RefreshTokenStorage = {
    set(token, info) {
      db.refreshTokens.set(token, { ...info });
    },
    get(token) {
      const entry = db.refreshTokens.get(token);
      if (!entry) return undefined;
      // Evicted only past the absolute lifetime (expiresAt). A used but
      // still-in-lifetime entry stays, so rotation-reuse detection keeps firing
      // (OAuth 2.1 §4.3.1 / RFC 9700 §4.13).
      if (entry.expiresAt <= nowSeconds()) {
        db.refreshTokens.delete(token);
        return undefined;
      }
      return { ...entry };
    },
    consume(token) {
      const entry = db.refreshTokens.get(token);
      if (!entry || entry.used) {
        throw new TokenError(TokenErrorCode.InvalidGrant, 'Refresh token has already been used');
      }
      entry.used = true;
    },
    delete(token) {
      db.refreshTokens.delete(token);
    },
    revokeByGrantId(grantId) {
      for (const [token, info] of db.refreshTokens) {
        if (info.grantId === grantId) db.refreshTokens.delete(token);
      }
    },
    revoke(token) {
      db.refreshTokens.delete(token);
    },
  };

  const authSessionStore: AuthSessionStorage = {
    set(transactionId, info) {
      db.authSessions.set(transactionId, { ...info });
    },
    get(transactionId) {
      const entry = db.authSessions.get(transactionId);
      return entry ? { ...entry } : undefined;
    },
    delete(transactionId) {
      db.authSessions.delete(transactionId);
    },
  };

  const browserSessionStore: BrowserSessionStorage = {
    set(sessionId, info) {
      db.browserSessions.set(sessionId, { ...info });
    },
    get(sessionId) {
      const entry = db.browserSessions.get(sessionId);
      return entry ? { ...entry } : undefined;
    },
    delete(sessionId) {
      db.browserSessions.delete(sessionId);
    },
  };

  const consentStore: ConsentStorage = {
    grant(subject, clientId, scopes) {
      const granted = entryOf(db.consentScopes, subject, clientId);
      for (const scope of scopes) granted.add(scope);
    },
    hasConsent(subject, clientId, scopes) {
      const granted = db.consentScopes.get(subject)?.get(clientId);
      if (!granted || scopes.length === 0) return false;
      return scopes.every((scope) => granted.has(scope));
    },
    recordGrant(subject, clientId, grantId) {
      entryOf(db.consentGrants, subject, clientId).add(grantId);
    },
    // Remove what the subject granted the client ("remove access") and hand
    // back the grant ids, whose tokens the caller revokes.
    revoke(subject, clientId) {
      const grantIds = [...(db.consentGrants.get(subject)?.get(clientId) ?? [])];
      db.consentScopes.get(subject)?.delete(clientId);
      db.consentGrants.get(subject)?.delete(clientId);
      return grantIds;
    },
  };

  const userStore: UserStorage = {
    // The password form checks the user's sub as the username.
    async authenticate(username, password) {
      const user = db.users.get(username);
      // verifyPassword() takes as long without a hash, so the response time
      // does not tell whether the user exists. A user without a password (one
      // created by an upstream sign-in) cannot sign in with the form.
      const passwordHash = user?.passwordHash ?? null;
      if (!(await verifyPassword(password, passwordHash)) || !user || passwordHash === null) {
        return undefined;
      }
      return { ...user.claims, password: passwordHash };
    },
    getClaims(sub) {
      const user = db.users.get(sub);
      return user ? { ...user.claims } : undefined;
    },
    // Find or create the user of a verified upstream account by its federated
    // identity (never by email), under a new random sub on the first sign-in,
    // and save the claims the provider asserted.
    linkFederatedIdentity(identity) {
      const key = federatedIdentityKey(identity.provider, identity.subject);
      const sub = db.federatedIdentities.get(key) ?? crypto.randomUUID();
      db.federatedIdentities.set(key, sub);
      const claims: UserClaims = { ...identity.claims, sub };
      db.users.set(sub, { ...db.users.get(sub), claims });
      return { ...claims };
    },
  };

  const upstreamLoginStore: UpstreamLoginStorage = {
    find(nonce) {
      const login = db.upstreamLogins.get(nonce);
      if (!login) return undefined;
      if (login.expiresAt <= Date.now()) {
        db.upstreamLogins.delete(nonce);
        return undefined;
      }
      return { ...login };
    },
    // A transaction waits for one upstream sign-in, so a newer login page
    // replaces the nonce of an older one.
    save(nonce, login) {
      for (const [other, pending] of db.upstreamLogins) {
        if (pending.transactionId === login.transactionId) db.upstreamLogins.delete(other);
      }
      db.upstreamLogins.set(nonce, { ...login });
    },
    delete(nonce) {
      db.upstreamLogins.delete(nonce);
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
    upstreamLoginStore,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The set under subject and client_id, created when it is not there yet. */
function entryOf(
  map: Map<string, Map<string, Set<string>>>,
  subject: string,
  clientId: string,
): Set<string> {
  let byClient = map.get(subject);
  if (!byClient) {
    byClient = new Map();
    map.set(subject, byClient);
  }
  let values = byClient.get(clientId);
  if (!values) {
    values = new Set();
    byClient.set(clientId, values);
  }
  return values;
}
