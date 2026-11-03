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
import type { ClientRegistration } from '../../config.js';
import type { AuthSessionInfo, BrowserSessionInfo, UpstreamLogin } from '../../store.js';

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

/**
 * `federatedIdentities` の外部アカウントのキーを返す。
 *
 * ID プロバイダ名とそこでのサブジェクトの組 `[provider, subject]` を、JSON の文字列にして返す。
 * どちらの値に区切りの文字が含まれていても、ほかのアカウントのキーと同じ文字列にはならない。
 */
export function federatedIdentityKey(provider: string, subject: string): string {
  return JSON.stringify([provider, subject]);
}

/** すべての `Map` が空の、新しいデータベースを返す。 */
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

/**
 * このプロセスのメモリ上のデータベースを返す。
 *
 * 最初の呼び出しで空のデータベースを作って `globalThis` に置き、以後はどの呼び出しにも同じデータベースを返す。
 * そのため、フレームワークがモジュールを二度以上読み込んでも、どのモジュールも同じデータベースを使う。
 * 引数のリクエストコンテキストは使わない。
 */
export function createDatabase(_c?: unknown): MemoryDatabase {
  return (registry.__oidcMemoryDatabase ??= createEmptyDatabase());
}
