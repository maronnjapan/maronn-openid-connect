/**
 * The in-memory database of the provider (generated without --db).
 *
 * Every record lives in a Map of this process, so a restart forgets
 * everything, and a second instance of the OP sees none of it. Use it to try
 * the provider out and in tests; generate with --db sql or --db kv to keep the
 * data in a database.
 */
import type {
  AccessTokenInfo,
  AuthTransaction,
  AuthorizationCodeInfo,
  RefreshTokenInfo,
  UserClaims,
} from '@maronn-openid-connect/core';
import type { ClientRegistration } from '../../config';
import type { AuthSessionInfo, BrowserSessionInfo, UpstreamLogin } from '../../store';

export interface MemoryDatabase {
  /** By AuthTransactionStore key, with the expiry its TTL gave it (Unix time in milliseconds). */
  transactions: Map<string, { value: AuthTransaction; expiresAt: number }>;
  codes: Map<string, AuthorizationCodeInfo>;
  accessTokens: Map<string, AccessTokenInfo>;
  refreshTokens: Map<string, RefreshTokenInfo>;
  /** By transaction id. */
  authSessions: Map<string, AuthSessionInfo>;
  /** By session id. */
  browserSessions: Map<string, BrowserSessionInfo>;
  /** The granted scopes, by subject, then client_id. */
  consentScopes: Map<string, Map<string, Set<string>>>;
  /** The grants issued under a consent, by subject, then client_id. */
  consentGrants: Map<string, Map<string, Set<string>>>;
  /** By sub. passwordHash is the hash of hashPassword() (users.ts); absent for an upstream user. */
  users: Map<string, { claims: UserClaims; passwordHash?: string }>;
  /** The sub of the user an upstream account belongs to, by federatedIdentityKey(). */
  federatedIdentities: Map<string, string>;
  /** By the nonce the OP sent upstream. */
  upstreamLogins: Map<string, UpstreamLogin>;
  /** By client_id. clientSecret is never kept: registerClient() keeps clientSecretHash. */
  clients: Map<string, ClientRegistration>;
}

/** The key of federatedIdentities for an account at a provider. */
export function federatedIdentityKey(provider: string, subject: string): string {
  return JSON.stringify([provider, subject]);
}

export function createEmptyDatabase(): MemoryDatabase {
  return {
    transactions: new Map(),
    codes: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
    authSessions: new Map(),
    browserSessions: new Map(),
    consentScopes: new Map(),
    consentGrants: new Map(),
    users: new Map(),
    federatedIdentities: new Map(),
    upstreamLogins: new Map(),
    clients: new Map(),
  };
}

// Kept on globalThis so every module that asks for the database gets the same
// one, also where a framework loads a module more than once (dev-mode hot
// reloads, separate module layers).
const registry = globalThis as typeof globalThis & { __oidcMemoryDatabase?: MemoryDatabase };

/** The database of this process. Every call returns the same one (kept on globalThis, so every module layer of Next.js shares it). */
export function createDatabase(): MemoryDatabase {
  return (registry.__oidcMemoryDatabase ??= createEmptyDatabase());
}
