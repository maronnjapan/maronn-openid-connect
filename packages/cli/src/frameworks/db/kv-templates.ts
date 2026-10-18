/**
 * Templates for the db/ directory generated with --db kv.
 *
 * The generated OP keeps its data in a key-value store (Redis, Upstash,
 * Valkey, ...) instead of the in-memory stores, and reads its registered
 * clients and users from it too. Each record is a JSON document under a key
 * named after the entity of the ER model it stores (keys.ts), so the layout
 * follows the same model as the SQL tables of --db sql. Everything in db/ is
 * generated except instance.ts, which wraps the user's store in the four
 * methods of KvDatabase (get, set, setIfAbsent, delete).
 *
 * setIfAbsent is the one operation the store has to make atomic: it keeps
 * authorization codes and refresh tokens single-use, and lets one of two
 * concurrent first sign-ins of a Google account create the user.
 */
import type { GeneratedFile } from '../types.js';
import type { OidcFeatureConfig } from '../../features.js';
import { GOOGLE_LOGIN_PACKAGE } from '../hono/templates.js';
import {
  passwordHashingConstants,
  passwordHashingFunctions,
  type DbInstanceTarget,
} from './templates.js';

/** The db/ files of --db kv, relative to the generated provider directory. */
export function kvGeneratedFiles(
  corePkg: string,
  features: OidcFeatureConfig,
  target: DbInstanceTarget,
): GeneratedFile[] {
  return [
    // The one file the user writes: created once, never overwritten.
    { path: 'db/instance.ts', content: kvInstanceTemplate(target), userOwned: true },
    { path: 'db/database.ts', content: kvDatabaseTemplate() },
    { path: 'db/keys.ts', content: kvKeysTemplate(features) },
    { path: 'db/stores.ts', content: kvStoresTemplate(corePkg, features) },
    { path: 'db/clients.ts', content: kvClientsTemplate(corePkg) },
    { path: 'db/users.ts', content: kvUsersTemplate(corePkg, features) },
  ];
}

export function kvDatabaseTemplate(): string {
  return `/**
 * The key-value contract of the generated OP (--db kv).
 *
 * db/stores.ts, db/clients.ts and db/users.ts keep every record through these
 * four methods, and db/instance.ts creates the object that implements them for
 * your store. keys.ts lists the keys and the records they hold.
 *
 * - Keys and values are strings. Every value is JSON text.
 * - ttlSeconds is a whole number of seconds, 1 or more. A key past its TTL
 *   reads as missing. A key written without ttlSeconds does not expire.
 * - setIfAbsent stores the value only when the key is missing (or has
 *   expired), in one atomic step: of concurrent calls for one key, exactly one
 *   returns true. Authorization codes and refresh tokens are single-use
 *   because of it. Redis and Upstash have SET NX, DynamoDB a conditional put
 *   with attribute_not_exists, Deno KV an atomic check on a null versionstamp.
 * - A get sees every write that finished before it started. A store that
 *   copies writes to its other locations later (Cloudflare Workers KV) does not:
 *   the token request can reach a location that has not received the code yet.
 *   Workers KV has no atomic write either, so on Cloudflare use D1 (--db sql)
 *   or a store built on Durable Objects.
 * - There is no transaction and no listing of keys. A record the stores read,
 *   change and write back (stores.ts says which) is one the OP's flows change
 *   from one request at a time.
 */
export interface KvDatabase {
  /** The value of key, or null when the key is missing or has expired. */
  get(key: string): Promise<string | null>;
  /** Store value under key, replacing the value that is there. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Store value under key only when the key is missing, atomically; true when it stored the value. */
  setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
  /** Remove key. A missing key is not an error. */
  delete(key: string): Promise<void>;
}

/** The record under key (parsed from JSON), or undefined when the key is missing. */
export async function readRecord<T>(db: KvDatabase, key: string): Promise<T | undefined> {
  const value = await db.get(key);
  return value === null ? undefined : (JSON.parse(value) as T);
}

/** Store record under key as JSON. */
export async function writeRecord(
  db: KvDatabase,
  key: string,
  record: unknown,
  ttlSeconds?: number,
): Promise<void> {
  await db.set(key, JSON.stringify(record), ttlSeconds);
}
`;
}

/**
 * db/keys.ts: the keys of the store and the JSON record each one holds, the
 * part schema.sql plays for --db sql.
 */
export function kvKeysTemplate(features: OidcFeatureConfig): string {
  const google = features.googleLogin;
  return `/**
 * The keys of the key-value store (--db kv) and the JSON record each of them
 * holds: the layout that schema.sql is for --db sql.
 *
 * A record is a JSON document under a key named after the entity of the ER
 * model it stores, with the attribute names of the model. What belongs to one
 * entity goes into its record: a client holds its authentication method,
 * secret, redirect URIs, grant types and scopes, and a transaction holds its
 * authentication request, so each of them is written in one set. Keys that
 * are not in the ER model hold what the OP needs on top of it: how a
 * transaction ended, the single-use markers of codes and refresh tokens, and
 * the grants (the codes and tokens issued for one authorization).
 *
 * Every key starts with KEY_PREFIX, so the OP can share a store with other
 * data. A value that comes from a request (an id, a subject) is URI-encoded in
 * the key, so a colon in it cannot reach into another key.
 *
 * A record that expires has a TTL and carries its expiry too (expired_at,
 * exp), which the stores check on every read: a store that removes expired
 * keys late (DynamoDB) still never returns an expired record. Clients, users,
 * browser sessions and consent do not expire; remove them yourself once they
 * are no longer needed.
 */
export const KEY_PREFIX = 'oidc:';

function key(...parts: string[]): string {
  return KEY_PREFIX + parts.map((part) => encodeURIComponent(part)).join(':');
}

export const keys = {
  /** Client, with its Client_auth, Client_secret, Redirect_Uri, Grant and Scope (ClientRecord). */
  client: (clientId: string) => key('client', clientId),
  /** Client_jwk: the public keys of a client for one purpose (ClientJwksRecord). */
  clientJwks: (clientId: string, purpose: string) => key('client_jwks', clientId, purpose),
  /** User (UserRecord). */
  user: (userId: string) => key('user', userId),${google ? `
  /** Federated_identity, found by the account at the provider (FederatedIdentityRecord). */
  federatedIdentity: (provider: string, providerSub: string) =>
    key('federated_identity', provider, providerSub),` : ''}
  /** Transaction, with its Authentication_request (TransactionRecord). */
  transaction: (transactionId: string) => key('transaction', transactionId),
  /**
   * Not in the ER model: how a transaction ended (TransactionResultRecord).
   * The transaction record never changes it, so an ended transaction cannot
   * start again.
   */
  transactionResult: (transactionId: string) => key('transaction_result', transactionId),
  /** Auth_user: the sign-in of a transaction (AuthUserRecord). */
  authUser: (transactionId: string) => key('auth_user', transactionId),${google ? `
  /** Upstream_auth_request of a transaction (UpstreamAuthRequestRecord). */
  upstreamAuthRequest: (transactionId: string) => key('upstream_auth_request', transactionId),
  /** Not in the ER model: the transaction a nonce of an upstream request belongs to (UpstreamNonceRecord). */
  upstreamNonce: (nonce: string) => key('upstream_nonce', nonce),` : ''}
  /** Code, under the SHA-256 hash of the code (CodeRecord). */
  code: (codeHash: string) => key('code', codeHash),
  /** Not in the ER model: written with setIfAbsent when the code is used. */
  codeUsed: (codeHash: string) => key('code_used', codeHash),
  /** Access_token, under the SHA-256 hash of the token (AccessTokenRecord). */
  accessToken: (tokenHash: string) => key('access_token', tokenHash),
  /** Refresh_token, under the SHA-256 hash of the token (RefreshTokenRecord). */
  refreshToken: (tokenHash: string) => key('refresh_token', tokenHash),
  /** Not in the ER model: written with setIfAbsent when the refresh token is used. */
  refreshTokenUsed: (tokenHash: string) => key('refresh_token_used', tokenHash),
  /** Not in the ER model: a grant, the codes and tokens of one authorization (GrantRecord). */
  grant: (grantId: string) => key('grant', grantId),
  /** Not in the ER model: written when the access tokens of a grant are revoked. */
  grantAccessTokensRevoked: (grantId: string) => key('grant_access_tokens_revoked', grantId),
  /** Not in the ER model: written when the refresh tokens of a grant are revoked. */
  grantRefreshTokensRevoked: (grantId: string) => key('grant_refresh_tokens_revoked', grantId),
  /** Not in the ER model: a browser session for SSO, prompt=none and max_age (BrowserSessionRecord). */
  browserSession: (sessionId: string) => key('browser_session', sessionId),
  /** Not in the ER model: what a user consented to for a client (ConsentRecord). */
  consent: (subject: string, clientId: string) => key('consent', subject, clientId),
  /**
   * Not in the ER model: written with setIfAbsent when a client assertion
   * (private_key_jwt) is used, under the SHA-256 hash of the client_id and jti.
   */
  clientAssertionJti: (jtiHash: string) => key('client_assertion_jti', jtiHash),
};

/** Client: id is the client_id, in the key. The OP does not know a deleted client (is_deleted). */
export interface ClientRecord {
  name: string | null;
  client_type: 'public' | 'confidential';
  is_deleted: boolean;
  /**
   * Client_auth (with its Client_secret): the methods the client may
   * authenticate with at the token endpoint. A public client has none. A
   * confidential client has at most one of client_secret_basic /
   * client_secret_post, whose secret is the hash from hashClientSecret(), and
   * private_key_jwt (OIDC Core 1.0 §9), whose keys are those of the
   * private_key_jwt purpose (keys.clientJwks(client_id, 'private_key_jwt')).
   * registerClient() replaces the secret method and keeps private_key_jwt, so
   * private_key_jwt can be added here while the OP runs.
   */
  client_auths: ClientAuthRecord[];
  /** Redirect_Uri: the redirect URIs of the client. */
  redirect_uris: string[];
  /** Grant: the grant types the client may use. Empty: authorization_code only. */
  grant_types: string[];
  /**
   * Scope: the scopes the client may request. A request for any other scope is
   * rejected with invalid_scope. Empty: every scope the OP accepts.
   */
  scopes: string[];
}

/** One Client_auth of ClientRecord.client_auths. */
export type ClientAuthRecord =
  | { client_auth_type: 'client_secret_basic' | 'client_secret_post'; secret: string }
  | { client_auth_type: 'private_key_jwt' };

/**
 * Client_jwk: the public keys of a client for one purpose, as a JWK Set
 * (RFC 7517 §5). The purpose is part of the key and names the process that
 * uses the keys: private_key_jwt (client assertions, OIDC Core 1.0 §9),
 * request_object (signed Request Objects, OIDC Core 1.0 §6.3.2), dpop (DPoP
 * proofs, RFC 9449) or another one. The OP reads the record of a purpose each
 * time a process needs its keys, so a key added to it or removed from it takes
 * effect at once. Never store a private key.
 */
export interface ClientJwksRecord {
  keys: Array<Record<string, unknown>>;
}

/**
 * User: id is the sub, in the key. email and is_verified are the email and
 * email_verified claims. password_hash is the hash from hashPassword()
 * (users.ts), and null for a user who has no password and signs in another
 * way${google ? ' (such as Sign in with Google)' : ''}.
 */
export interface UserRecord {
  email: string | null;
  is_verified: boolean;
  password_hash: string | null;
  created_at: number;
  updated_at: number;
  /** Not in the ER model: the claims other than email and email_verified (name and so on). */
  claims: Record<string, unknown>;${google ? `
  /** The Federated_identity records of the user, each found through keys.federatedIdentity(). */
  federated_identities?: Array<{ provider: string; provider_sub: string }>;` : ''}
}
${google ? `
/** Federated_identity (google-login): the account of a user at an external IdP. */
export interface FederatedIdentityRecord {
  user_id: string;
  created_at: number;
  updated_at: number;
}
` : ''}
/**
 * Transaction: one authorization request on its way through the OP.
 * expired_at is when it expires, in epoch seconds like every time here.
 */
export interface TransactionRecord {
  /** The status while the transaction is in progress; how it ended is in keys.transactionResult(). */
  status: 'requested' | 'upstream_pending' | 'authenticated';
  created_at: number;
  expired_at: number;
  /** Authentication_request: what the authorization request asked for. */
  authentication_request: {
    client_id: string;
    redirect_uri: string;
    state: string | null;
    nonce: string | null;
    code_challenge: string | null;
    code_challenge_method: string | null;
    response_type: string;
    scope: string | null;
    /** Not in the ER model: the other parameters of the request (prompt, max_age, claims, ...). */
    payload: Record<string, unknown>;
  };
  /** Not in the ER model: the CSRF token, the failed sign-in attempts and the browser binding. */
  payload: Record<string, unknown>;
}

/**
 * Not in the ER model: failed when the transaction ended without a code,
 * code_issued once a code was issued from it, and token_issued once that code
 * was exchanged for tokens.
 */
export interface TransactionResultRecord {
  status: 'failed' | 'code_issued' | 'token_issued';
}

/** Auth_user: who signed in for a transaction, how and when. */
export interface AuthUserRecord {
  user_id: string;
  /** password, or the provider of the user's federated identity (such as google). */
  auth_type: string;
  auth_time: number;
  /** Not in the ER model: the browser session the sign-in created. */
  session_id: string | null;
}
${google ? `
/**
 * Upstream_auth_request (google-login): the request to the external IdP.
 * Sign in with Google (GIS redirect mode) sends no state and uses no PKCE, so
 * state and code_verifier are null. A transaction has one, so a newer login
 * page replaces the nonce of an older one.
 */
export interface UpstreamAuthRequestRecord {
  provider: string;
  state: string | null;
  nonce: string;
  code_verifier: string | null;
  expired_at: number;
}

/** Not in the ER model: the transaction of an upstream nonce. */
export interface UpstreamNonceRecord {
  transaction_id: string;
}
` : ''}
/** Code: an authorization code, under the hash of the code. */
export interface CodeRecord {
  /** The transaction the code was issued from. */
  transaction_id: string | null;
  expired_at: number;
  grant_id: string;
  /** Not in the ER model: what the token request checks (client, redirect URI, scope, PKCE, nonce, ...). */
  payload: Record<string, unknown>;
}

/** Access_token: an access token, under the hash of the token. */
export interface AccessTokenRecord {
  /** The jti, or the hash of a token issued without one. */
  id: string;
  sub: string;
  exp: number;
  iat: number | null;
  iss: string | null;
  client_id: string;
  /** Space-separated. */
  scope: string | null;
  /**
   * The acr claim of the token (RFC 9068, OpenID Connect Core 1.0): the
   * authentication context class it was issued for, the same as the acr of its
   * ID Token. null when the token has none, as when the authorization request
   * asked for no acr (acr_values).
   */
  acr: string | null;
  /** The transaction of the code the grant came from. null for the device flow and CIBA. */
  transaction_id: string | null;
  grant_id: string | null;
  /** Not in the ER model: the other values the OP needs (audience, auth_time, ...). */
  payload: Record<string, unknown>;
}

/** Refresh_token: a refresh token, under the hash of the token. */
export interface RefreshTokenRecord {
  /** The access token issued in the same token response. */
  access_token_id: string | null;
  exp: number;
  iat: number | null;
  grant_id: string;
  /** Not in the ER model: the other values the OP needs (client, scope, session, ...). */
  payload: Record<string, unknown>;
}

/**
 * Not in the ER model: a grant. Its code points to its transaction, and the
 * refresh token of a token response points to the access token issued just
 * before it. expired_at is when the grant's last code or token expires: the
 * record, and the revocation markers of the grant, live until then.
 */
export interface GrantRecord {
  transaction_id: string | null;
  latest_access_token: { id: string; iat: number | null } | null;
  expired_at: number;
}

/** Not in the ER model: a browser session (SSO, prompt=none, max_age). */
export interface BrowserSessionRecord {
  subject: string;
  auth_time: number;
}

/** Not in the ER model: the scopes a user consented to for a client, and the grants issued under them. */
export interface ConsentRecord {
  scopes: string[];
  grant_ids: string[];
}
`;
}

/** db/stores.ts: ProviderStores on the key-value store. */
export function kvStoresTemplate(corePkg: string, features: OidcFeatureConfig): string {
  const google = features.googleLogin;
  return `/**
 * ProviderStores (store.ts) on the key-value store of db/instance.ts: the
 * stores the OP uses when no other storage is passed in. keys.ts lists the
 * keys and the records they hold.
 *
 * Rewriting this file for another store is fine, but keep these behaviors -
 * routes/ and resolvers.ts rely on them:
 *
 * 1. Keep the ProviderStores types (method names, parameters, return values).
 * 2. authCodeStore.consume and refreshTokenStore.consume claim the code_used /
 *    refresh_token_used key with setIfAbsent, and throw TokenError
 *    (invalid_grant) when it was already taken. A get followed by a set lets
 *    two concurrent requests both see an unused code and both receive tokens
 *    (OAuth 2.1 §4.1.2).
 * 3. consume never deletes the record. A used code or a rotated refresh token
 *    has to stay readable, so a replay is detected and the grant's tokens
 *    revoked.
 * 4. get never returns an expired record, and does return used ones.
 * 5. revokeByGrantId makes every token of that kind in the grant unreadable,
 *    the rotated (used) refresh tokens included, by writing a marker key with
 *    set. Nothing the stores read and write back holds it, so a token request
 *    running at the same moment cannot undo it.
 * 6. hasConsent is true only when every requested scope was granted.
 * 7. Codes and tokens are stored under their SHA-256 hash; the raw value is
 *    never written to the store.
 * 8. transactionStore.get returns a transaction only while it is in progress,
 *    and delete ends it with a transaction_result key that put never changes,
 *    so an ended transaction cannot start again: failed, then code_issued if a
 *    code is issued from it, and token_issued once that code is exchanged.
 * 9. clientAssertionJtiStore.markUsed claims the client_assertion_jti key with
 *    setIfAbsent and is true only when it took the key. A get followed by a
 *    set lets two requests carrying the same client assertion both pass
 *    (OIDC Core 1.0 §9: an assertion MUST only be used once).
 *
 * A few records are read, changed and written back: a grant, a consent, and
 * the status of a transaction in progress. Two requests that change the same
 * one at the same moment can lose one of the changes. The OP's flows change a
 * grant from one request at a time (consume lets one refresh through). A
 * consent changes at once only when one user authorizes one client from two
 * browser tabs in the same moment: a lost scope asks the user again, and a
 * lost grant id leaves that grant out of revokeConsentAndTokens().
 */
import {
  TokenError,
  TokenErrorCode,
  type AccessTokenInfo,
  type AuthTransaction,
  type AuthTransactionStore,
  type AuthorizationCodeData,
  type AuthorizationCodeInfo,
  type ClientAssertionJtiStore,
  type RefreshTokenInfo,
  type UserClaims,
} from '${corePkg}';
${google ? `import type { GoogleLoginNonceStore } from '${GOOGLE_LOGIN_PACKAGE}';
` : ''}import {
${google ? '  googleAccountToClaims,\n' : ''}  type AccessTokenStorage,
  type AuthSessionInfo,
  type AuthSessionStorage,
  type AuthorizationCodeStorage,
  type BrowserSessionStorage,
  type ConsentStorage,
  type ProviderStores,
  type RefreshTokenStorage,
  type UserStorage,
} from '../store.js';
import { readRecord, writeRecord, type KvDatabase } from './database.js';
import {
  keys,
  type AccessTokenRecord,
  type AuthUserRecord,
  type BrowserSessionRecord,
  type CodeRecord,
  type ConsentRecord,
${google ? '  type FederatedIdentityRecord,\n' : ''}  type GrantRecord,
  type RefreshTokenRecord,
  type TransactionRecord,
  type TransactionResultRecord,
${google ? '  type UpstreamAuthRequestRecord,\n  type UpstreamNonceRecord,\n' : ''}  type UserRecord,
} from './keys.js';
import { verifyPassword } from './users.js';

/** core prefixes the id of every AuthTransactionStore key with this. */
const TRANSACTION_KEY_PREFIX = 'auth_txn:';
${google ? `
/** google-login prefixes the nonce of every GoogleLoginNonceStore key with this. */
const GOOGLE_LOGIN_NONCE_KEY_PREFIX = 'google_login_nonce:';
` : ''}
/**
 * The TTL of a sign-in (auth_user) whose transaction record is already gone:
 * the transaction cannot be completed any more, so the record only has to
 * outlive the request that writes it.
 */
const FALLBACK_TTL_SECONDS = 600;

/** The value of a single-use marker (code_used, refresh_token_used) and of a revocation marker. */
const MARKER = 'true';

export function createKvProviderStores(db: KvDatabase): ProviderStores {
  const read = <T>(key: string) => readRecord<T>(db, key);
  const write = (key: string, record: unknown, ttlSeconds?: number) =>
    writeRecord(db, key, record, ttlSeconds);

  /** The record of a transaction, unless it has expired. */
  const readTransaction = async (transactionId: string): Promise<TransactionRecord | undefined> => {
    const record = await read<TransactionRecord>(keys.transaction(transactionId));
    return record && record.expired_at > nowSeconds() ? record : undefined;
  };

  /** Move a transaction in progress from one of the statuses in from to status. */
  const advanceTransaction = async (
    transactionId: string,
    from: Array<TransactionRecord['status']>,
    status: TransactionRecord['status'],
  ): Promise<void> => {
    const record = await readTransaction(transactionId);
    if (record && from.includes(record.status)) {
      await write(keys.transaction(transactionId), { ...record, status }, ttlUntil(record.expired_at));
    }
  };

  /** The record of a grant, changed by change and written back. It lives until expiresAt at least. */
  const updateGrant = async (
    grantId: string,
    expiresAt: number,
    change: (grant: GrantRecord) => GrantRecord,
  ): Promise<GrantRecord> => {
    const current = (await read<GrantRecord>(keys.grant(grantId))) ?? {
      transaction_id: null,
      latest_access_token: null,
      expired_at: 0,
    };
    const grant = { ...change(current), expired_at: Math.max(current.expired_at, expiresAt) };
    await write(keys.grant(grantId), grant, ttlUntil(grant.expired_at));
    return grant;
  };

  /** Mark the tokens of one kind in a grant revoked, until the grant's last code or token expires. */
  const revokeGrant = async (revokedKey: string, grantId: string): Promise<void> => {
    const grant = await read<GrantRecord>(keys.grant(grantId));
    // Without a grant record every code and token of the grant has expired.
    if (grant) await db.set(revokedKey, MARKER, ttlUntil(grant.expired_at));
  };

  // Transaction + Authentication_request: one record, written in one set.
  const transactionStore: AuthTransactionStore = {
    async get(key) {
      const transactionId = withoutPrefix(key, TRANSACTION_KEY_PREFIX);
      const [record, result] = await Promise.all([
        readTransaction(transactionId),
        db.get(keys.transactionResult(transactionId)),
      ]);
      // A transaction that ended (failed, code_issued, token_issued) is gone for the OP.
      if (!record || result !== null) return null;
      const request = record.authentication_request;
      const transaction: AuthTransaction = {
        ...(request.payload as OtherRequestParameters),
        ...(record.payload as TransactionPayload),
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        responseType: request.response_type,
        scope: request.scope ?? '',
        createdAt: record.created_at * 1000,
        expiresAt: record.expired_at * 1000,
      };
      if (request.state !== null) transaction.state = request.state;
      if (request.nonce !== null) transaction.nonce = request.nonce;
      if (request.code_challenge !== null) transaction.codeChallenge = request.code_challenge;
      if (request.code_challenge_method !== null) {
        transaction.codeChallengeMethod = request.code_challenge_method as 'S256';
      }
      return transaction;
    },
    // The expiry is the transaction's own expiresAt (milliseconds, rounded up
    // to seconds), which the ttlSeconds core passes is computed from.
    async put(key, value, _ttlSeconds) {
      const transactionId = withoutPrefix(key, TRANSACTION_KEY_PREFIX);
      const {
        clientId,
        redirectUri,
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod,
        responseType,
        scope,
        createdAt,
        expiresAt,
        csrfToken,
        failedAttempts,
        bindingHash,
        ...otherParameters
      } = value;
      // A new transaction starts as requested. Saving it again (a failed
      // sign-in attempt) keeps its status.
      const current = await readTransaction(transactionId);
      const record: TransactionRecord = {
        status: current?.status ?? 'requested',
        created_at: Math.floor(createdAt / 1000),
        expired_at: Math.ceil(expiresAt / 1000),
        authentication_request: {
          client_id: clientId,
          redirect_uri: redirectUri,
          state: state ?? null,
          nonce: nonce ?? null,
          code_challenge: codeChallenge ?? null,
          code_challenge_method: codeChallengeMethod ?? null,
          response_type: responseType,
          scope,
          payload: otherParameters,
        },
        payload: { csrfToken, failedAttempts, bindingHash },
      };
      await write(keys.transaction(transactionId), record, ttlUntil(record.expired_at));
    },
    // One-time use: the transaction ends as failed, unless a code was issued
    // from it already (code_issued stays).
    async delete(key) {
      const transactionId = withoutPrefix(key, TRANSACTION_KEY_PREFIX);
      const record = await readTransaction(transactionId);
      if (!record) return;
      const result: TransactionResultRecord = { status: 'failed' };
      await db.setIfAbsent(
        keys.transactionResult(transactionId),
        JSON.stringify(result),
        ttlUntil(record.expired_at),
      );
    },
  };

  const authCodeStore: AuthorizationCodeStorage = {
    async set(code, info) {
      // The routes pass core's AuthorizationCodeData, which names the
      // transaction the code was issued from. Neither the raw code nor a value
      // with a field of its own goes into payload.
      const { code: _code, used, expiresAt, grantId, transactionId, ...payload } =
        info as AuthorizationCodeInfo & Pick<AuthorizationCodeData, 'transactionId'>;
      const codeHash = await hashKey(code);
      const record: CodeRecord = {
        transaction_id: transactionId ?? null,
        expired_at: expiresAt,
        grant_id: grantId,
        payload,
      };
      await write(keys.code(codeHash), record, ttlUntil(expiresAt));
      if (used) await db.setIfAbsent(keys.codeUsed(codeHash), MARKER, ttlUntil(expiresAt));
      await updateGrant(grantId, expiresAt, (grant) => ({
        ...grant,
        transaction_id: transactionId ?? grant.transaction_id,
      }));
      if (transactionId !== undefined) {
        // The result outlives the transaction until the code expires, so the
        // exchange of the code can still record token_issued.
        const transaction = await read<TransactionRecord>(keys.transaction(transactionId));
        const result: TransactionResultRecord = { status: 'code_issued' };
        await db.set(
          keys.transactionResult(transactionId),
          JSON.stringify(result),
          ttlUntil(Math.max(expiresAt, transaction?.expired_at ?? 0)),
        );
      }
    },
    async get(code) {
      const codeHash = await hashKey(code);
      const [record, used] = await Promise.all([
        read<CodeRecord>(keys.code(codeHash)),
        db.get(keys.codeUsed(codeHash)),
      ]);
      if (!record || record.expired_at <= nowSeconds()) return undefined;
      return {
        ...(record.payload as Omit<AuthorizationCodeInfo, 'code' | 'used' | 'expiresAt' | 'grantId'>),
        code,
        grantId: record.grant_id,
        expiresAt: record.expired_at,
        used: used !== null,
      };
    },
    // Only one of two concurrent requests stores the code_used key; the other
    // one finds the code already used and must not receive tokens.
    async consume(code) {
      const codeHash = await hashKey(code);
      const record = await read<CodeRecord>(keys.code(codeHash));
      const claimed =
        record !== undefined &&
        (await db.setIfAbsent(keys.codeUsed(codeHash), MARKER, ttlUntil(record.expired_at)));
      if (!claimed) {
        throw new TokenError(TokenErrorCode.InvalidGrant, 'Authorization code has already been used');
      }
    },
    async delete(code) {
      const codeHash = await hashKey(code);
      await db.delete(keys.code(codeHash));
      await db.delete(keys.codeUsed(codeHash));
    },
  };

  const deleteAccessToken = async (token: string): Promise<void> => {
    await db.delete(keys.accessToken(await hashKey(token)));
  };

  const accessTokenStore: AccessTokenStorage = {
    async set(token, info) {
      const { sub, scope, clientId, expiresAt, iat, issuer, jti, grantId, acr, ...payload } = info;
      const tokenHash = await hashKey(token);
      // A token issued without a jti is kept under its hash.
      const id = jti ?? tokenHash;
      // The grant also names the transaction of the code it came from. A grant
      // without a code (the device flow, CIBA) has none.
      const grant =
        grantId === undefined
          ? undefined
          : await updateGrant(grantId, expiresAt, (current) => ({
            ...current,
            latest_access_token: { id, iat: iat ?? null },
          }));
      const record: AccessTokenRecord = {
        id,
        sub,
        exp: expiresAt,
        iat: iat ?? null,
        iss: issuer ?? null,
        client_id: clientId,
        scope: joinScope(scope),
        acr: acr ?? null,
        transaction_id: grant?.transaction_id ?? null,
        grant_id: grantId ?? null,
        payload,
      };
      await write(keys.accessToken(tokenHash), record, ttlUntil(expiresAt));
      if (grant?.transaction_id) {
        const transactionId = grant.transaction_id;
        const result = await read<TransactionResultRecord>(keys.transactionResult(transactionId));
        if (result?.status === 'code_issued') {
          const issued: TransactionResultRecord = { status: 'token_issued' };
          await db.set(keys.transactionResult(transactionId), JSON.stringify(issued), ttlUntil(expiresAt));
        }
      }
    },
    async get(token) {
      const tokenHash = await hashKey(token);
      const record = await read<AccessTokenRecord>(keys.accessToken(tokenHash));
      if (!record || record.exp <= nowSeconds()) return undefined;
      if (record.grant_id !== null && (await db.get(keys.grantAccessTokensRevoked(record.grant_id))) !== null) {
        return undefined;
      }
      const info: AccessTokenInfo = {
        ...(record.payload as Omit<AccessTokenInfo, AccessTokenField>),
        sub: record.sub,
        clientId: record.client_id,
        scope: splitScope(record.scope),
        expiresAt: record.exp,
      };
      if (record.id !== tokenHash) info.jti = record.id;
      if (record.iat !== null) info.iat = record.iat;
      if (record.iss !== null) info.issuer = record.iss;
      if (record.acr !== null) info.acr = record.acr;
      if (record.grant_id !== null) info.grantId = record.grant_id;
      return info;
    },
    delete: deleteAccessToken,
    revoke: deleteAccessToken,
    async revokeByGrantId(grantId) {
      await revokeGrant(keys.grantAccessTokensRevoked(grantId), grantId);
    },
  };

  const deleteRefreshToken = async (token: string): Promise<void> => {
    const tokenHash = await hashKey(token);
    await db.delete(keys.refreshToken(tokenHash));
    await db.delete(keys.refreshTokenUsed(tokenHash));
  };

  const refreshTokenStore: RefreshTokenStorage = {
    async set(token, info) {
      const { used, expiresAt, iat, grantId, ...payload } = info;
      const tokenHash = await hashKey(token);
      let accessTokenId: string | null = null;
      // The access token of the same token response: the token endpoint stores
      // it just before, with the same grant and iat.
      await updateGrant(grantId, expiresAt, (grant) => {
        const latest = grant.latest_access_token;
        if (latest && latest.iat === (iat ?? null)) accessTokenId = latest.id;
        return { ...grant, latest_access_token: null };
      });
      const record: RefreshTokenRecord = {
        access_token_id: accessTokenId,
        exp: expiresAt,
        iat: iat ?? null,
        grant_id: grantId,
        payload,
      };
      await write(keys.refreshToken(tokenHash), record, ttlUntil(expiresAt));
      if (used) await db.setIfAbsent(keys.refreshTokenUsed(tokenHash), MARKER, ttlUntil(expiresAt));
    },
    async get(token) {
      const tokenHash = await hashKey(token);
      const [record, used] = await Promise.all([
        read<RefreshTokenRecord>(keys.refreshToken(tokenHash)),
        db.get(keys.refreshTokenUsed(tokenHash)),
      ]);
      if (!record || record.exp <= nowSeconds()) return undefined;
      if ((await db.get(keys.grantRefreshTokensRevoked(record.grant_id))) !== null) return undefined;
      const info: RefreshTokenInfo = {
        ...(record.payload as Omit<RefreshTokenInfo, 'used' | 'expiresAt' | 'iat' | 'grantId'>),
        grantId: record.grant_id,
        expiresAt: record.exp,
        used: used !== null,
      };
      if (record.iat !== null) info.iat = record.iat;
      return info;
    },
    // Rotation: like authCodeStore.consume, exactly one request wins.
    async consume(token) {
      const tokenHash = await hashKey(token);
      const record = await read<RefreshTokenRecord>(keys.refreshToken(tokenHash));
      const claimed =
        record !== undefined &&
        (await db.setIfAbsent(keys.refreshTokenUsed(tokenHash), MARKER, ttlUntil(record.exp)));
      if (!claimed) {
        throw new TokenError(TokenErrorCode.InvalidGrant, 'Refresh token has already been used');
      }
    },
    delete: deleteRefreshToken,
    revoke: deleteRefreshToken,
    async revokeByGrantId(grantId) {
      await revokeGrant(keys.grantRefreshTokensRevoked(grantId), grantId);
    },
  };

  // auth_type of a sign-in (auth_user): ${google ? `the provider of the user's federated
  // identity, or password. A user created by Sign in with Google has no
  // password, and registerUser() (users.ts) adds no federated identity, so
  // each user signs in one way only unless you link a Google account to a
  // user with a password yourself.
  const authTypeOf = async (userId: string): Promise<string> => {
    const user = await read<UserRecord>(keys.user(userId));
    return user?.federated_identities?.[0]?.provider ?? 'password';
  };` : `password, the one way to sign in.
  const authTypeOf = async (_userId: string): Promise<string> => 'password';`}

  // Auth_user: the sign-in handed from /login to /consent, per transaction.
  // It expires with the transaction.
  const authSessionStore: AuthSessionStorage = {
    async set(transactionId, info) {
      const transaction = await readTransaction(transactionId);
      const record: AuthUserRecord = {
        user_id: info.subject,
        auth_type: await authTypeOf(info.subject),
        auth_time: info.authTime,
        session_id: info.sessionId ?? null,
      };
      await write(
        keys.authUser(transactionId),
        record,
        transaction ? ttlUntil(transaction.expired_at) : FALLBACK_TTL_SECONDS,
      );
      await advanceTransaction(transactionId, ['requested', 'upstream_pending'], 'authenticated');
    },
    async get(transactionId) {
      const record = await read<AuthUserRecord>(keys.authUser(transactionId));
      if (!record) return undefined;
      const info: AuthSessionInfo = { subject: record.user_id, authTime: record.auth_time };
      if (record.session_id !== null) info.sessionId = record.session_id;
      return info;
    },
    async delete(transactionId) {
      await db.delete(keys.authUser(transactionId));
    },
  };

  const browserSessionStore: BrowserSessionStorage = {
    async set(sessionId, info) {
      const record: BrowserSessionRecord = { subject: info.subject, auth_time: info.authTime };
      await write(keys.browserSession(sessionId), record);
    },
    async get(sessionId) {
      const record = await read<BrowserSessionRecord>(keys.browserSession(sessionId));
      return record ? { subject: record.subject, authTime: record.auth_time } : undefined;
    },
    async delete(sessionId) {
      await db.delete(keys.browserSession(sessionId));
    },
  };

  const readConsent = async (subject: string, clientId: string): Promise<ConsentRecord> =>
    (await read<ConsentRecord>(keys.consent(subject, clientId))) ?? { scopes: [], grant_ids: [] };

  const consentStore: ConsentStorage = {
    async grant(subject, clientId, scopes) {
      if (scopes.length === 0) return;
      const consent = await readConsent(subject, clientId);
      await write(keys.consent(subject, clientId), {
        ...consent,
        scopes: [...new Set([...consent.scopes, ...scopes])],
      });
    },
    async hasConsent(subject, clientId, scopes) {
      const unique = [...new Set(scopes)];
      // An empty request is never treated as consented.
      if (unique.length === 0) return false;
      const consent = await readConsent(subject, clientId);
      return unique.every((scope) => consent.scopes.includes(scope));
    },
    async recordGrant(subject, clientId, grantId) {
      const consent = await readConsent(subject, clientId);
      if (consent.grant_ids.includes(grantId)) return;
      await write(keys.consent(subject, clientId), {
        ...consent,
        grant_ids: [...consent.grant_ids, grantId],
      });
    },
    // The grants come back, so the caller revokes the tokens of each one.
    async revoke(subject, clientId) {
      const consent = await readConsent(subject, clientId);
      await db.delete(keys.consent(subject, clientId));
      return consent.grant_ids;
    },
  };
${google ? `
  // EXTENSION (google-login): the user linked to a Google account, if any.
  const findGoogleUser = async (googleSub: string): Promise<string | undefined> => {
    const identity = await read<FederatedIdentityRecord>(keys.federatedIdentity('google', googleSub));
    return identity?.user_id;
  };

  // EXTENSION (google-login): link a Google account to a new user, under a new
  // random id, on its first sign-in. Two first sign-ins of one account may
  // race: setIfAbsent keeps one federated identity, and the request that lost
  // uses the user it names.
  const createGoogleUser = async (googleSub: string): Promise<string> => {
    const userId = crypto.randomUUID();
    const now = nowSeconds();
    const identity: FederatedIdentityRecord = { user_id: userId, created_at: now, updated_at: now };
    const linked = await db.setIfAbsent(
      keys.federatedIdentity('google', googleSub),
      JSON.stringify(identity),
    );
    return linked ? userId : ((await findGoogleUser(googleSub)) ?? userId);
  };

  // EXTENSION (google-login): save the claims Google asserted to the user
  // (email and email_verified to their fields, the others to claims), and
  // create the user record on the first sign-in. password_hash is left as it
  // is.
  const saveGoogleClaims = async (claims: UserClaims, googleSub: string): Promise<void> => {
    const { sub, email, email_verified, ...otherClaims } = claims;
    const current = await read<UserRecord>(keys.user(sub));
    const now = nowSeconds();
    const identities = current?.federated_identities ?? [];
    const linked = identities.some(
      (identity) => identity.provider === 'google' && identity.provider_sub === googleSub,
    );
    const record: UserRecord = {
      email: email ?? null,
      is_verified: email_verified === true,
      password_hash: current?.password_hash ?? null,
      created_at: current?.created_at ?? now,
      updated_at: now,
      claims: otherClaims,
      federated_identities: linked
        ? identities
        : [...identities, { provider: 'google', provider_sub: googleSub }],
    };
    await write(keys.user(sub), record);
  };
` : ''}
  // User: the user records. Put users there with registerUser() (users.ts).
  const userStore: UserStorage = {
    // The password form checks the user's id as the username.
    async authenticate(username, password) {
      const user = await read<UserRecord>(keys.user(username));
      // verifyPassword() takes as long without a hash, so the response time
      // does not tell whether the user exists. A user without a password
      // cannot sign in with the form.
      const passwordHash = user?.password_hash ?? null;
      if (!(await verifyPassword(password, passwordHash)) || !user || passwordHash === null) {
        return undefined;
      }
      return { ...userClaims(username, user), password: passwordHash };
    },
    async getClaims(sub) {
      const user = await read<UserRecord>(keys.user(sub));
      return user ? userClaims(sub, user) : undefined;
    },
${google ? `    // EXTENSION (google-login): find or create the user of a verified Google
    // account by its federated identity (never by email), and save the claims
    // Google asserted.
    async linkGoogleAccount(account) {
      const userId = (await findGoogleUser(account.sub)) ?? (await createGoogleUser(account.sub));
      const claims: UserClaims = { ...googleAccountToClaims(account), sub: userId };
      await saveGoogleClaims(claims, account.sub);
      return claims;
    },
` : ''}  };
${google ? `
  // EXTENSION (google-login): the nonce of the Google button, kept in the
  // upstream_auth_request record of its transaction, and found by the nonce
  // through upstream_nonce. A transaction has one record, so a newer login
  // page replaces the nonce of an older one. Both expire with the nonce.
  const googleLoginNonceStore: GoogleLoginNonceStore = {
    async get(key) {
      const nonce = withoutPrefix(key, GOOGLE_LOGIN_NONCE_KEY_PREFIX);
      const index = await read<UpstreamNonceRecord>(keys.upstreamNonce(nonce));
      if (!index) return null;
      const request = await read<UpstreamAuthRequestRecord>(keys.upstreamAuthRequest(index.transaction_id));
      if (!request || request.nonce !== nonce || request.expired_at <= nowSeconds()) return null;
      return { transactionId: index.transaction_id, expiresAt: request.expired_at * 1000 };
    },
    async put(key, value, ttlSeconds) {
      const nonce = withoutPrefix(key, GOOGLE_LOGIN_NONCE_KEY_PREFIX);
      const request: UpstreamAuthRequestRecord = {
        provider: 'google',
        state: null,
        nonce,
        code_verifier: null,
        expired_at: Math.ceil(value.expiresAt / 1000),
      };
      const index: UpstreamNonceRecord = { transaction_id: value.transactionId };
      await write(keys.upstreamAuthRequest(value.transactionId), request, ttlSeconds);
      await write(keys.upstreamNonce(nonce), index, ttlSeconds);
      await advanceTransaction(value.transactionId, ['requested'], 'upstream_pending');
    },
    async delete(key) {
      const nonce = withoutPrefix(key, GOOGLE_LOGIN_NONCE_KEY_PREFIX);
      const index = await read<UpstreamNonceRecord>(keys.upstreamNonce(nonce));
      await db.delete(keys.upstreamNonce(nonce));
      if (!index) return;
      const request = await read<UpstreamAuthRequestRecord>(keys.upstreamAuthRequest(index.transaction_id));
      if (request?.nonce === nonce) await db.delete(keys.upstreamAuthRequest(index.transaction_id));
    },
  };
` : ''}
  // Not in the ER model: the client assertions (private_key_jwt) the OP
  // accepted. setIfAbsent takes the key only while no request has used the
  // same assertion, and the key expires with the assertion.
  const clientAssertionJtiStore: ClientAssertionJtiStore = {
    async markUsed({ clientId, jti, expiresAt }) {
      const jtiHash = await hashKey(JSON.stringify([clientId, jti]));
      return db.setIfAbsent(keys.clientAssertionJti(jtiHash), MARKER, ttlUntil(expiresAt));
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
    userStore,${google ? '\n    googleLoginNonceStore,' : ''}
    clientAssertionJtiStore,
  };
}

/** The values of an AuthTransaction kept in the payload of the transaction record. */
type TransactionPayload = Pick<AuthTransaction, 'csrfToken' | 'failedAttempts' | 'bindingHash'>;

/** The values of an AuthTransaction kept in the payload of its authentication request. */
type OtherRequestParameters = Omit<
  AuthTransaction,
  | keyof TransactionPayload
  | 'clientId'
  | 'redirectUri'
  | 'state'
  | 'nonce'
  | 'codeChallenge'
  | 'codeChallengeMethod'
  | 'responseType'
  | 'scope'
  | 'createdAt'
  | 'expiresAt'
>;

/** The values of an AccessTokenInfo with a field of their own in the access token record. */
type AccessTokenField =
  | 'sub'
  | 'scope'
  | 'clientId'
  | 'expiresAt'
  | 'iat'
  | 'issuer'
  | 'jti'
  | 'grantId'
  | 'acr';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The TTL that makes a key expire at expiresAt (epoch seconds), 1 second at least. */
function ttlUntil(expiresAt: number): number {
  return Math.max(1, expiresAt - nowSeconds());
}

/** The claims of a user record: email and email_verified from their fields, the rest from claims. */
function userClaims(sub: string, user: UserRecord): UserClaims {
  const claims: UserClaims = { ...(user.claims as Partial<UserClaims>), sub };
  if (user.email !== null) {
    claims.email = user.email;
    claims.email_verified = user.is_verified;
  }
  return claims;
}

function withoutPrefix(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/** The scope field: space-separated, null when there is none. */
function joinScope(scope: string[]): string | null {
  return scope.length > 0 ? scope.join(' ') : null;
}

function splitScope(scope: string | null): string[] {
  return scope ? scope.split(' ') : [];
}

/** The key a code or token is stored under: its SHA-256 hash, base64url-encoded. */
async function hashKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}
`;
}

/** db/clients.ts: the ClientResolver on the key-value store, and registerClient(). */
export function kvClientsTemplate(corePkg: string): string {
  return `/**
 * Registered clients in the key-value store: the ClientResolver and the
 * ClientKeyResolver the OP uses when no other ones are passed in, and
 * registerClient() to put a client into the store.
 *
 * A client is one record (ClientRecord in keys.ts), and this is how it becomes
 * a RegisteredClient (config.ts):
 *
 * - client_type public: no client authentication
 *   (tokenEndpointAuthMethods ['none']).
 * - client_auths: the methods the client may authenticate with
 *   (tokenEndpointAuthMethods). A client_secret_basic or client_secret_post
 *   entry carries the clientSecretHash the presented secret is checked
 *   against; more than one of those is a configuration error. A
 *   private_key_jwt entry lets the client sign a JWT with one of its keys of
 *   the private_key_jwt purpose instead (OIDC Core 1.0 §9). A confidential
 *   client without entries keeps the default client_secret_basic with no
 *   secret, so it cannot authenticate.
 * - redirect_uris, grant_types and scopes: redirectUris, grantTypes and scope.
 *   A request for a scope outside scope is rejected with invalid_scope
 *   (validateClientScope() in core). A client without scopes may request every
 *   scope the OP accepts.
 * - Metadata without a field (response_types, default_max_age, the ID Token
 *   and UserInfo signing algs) keeps its default.
 *
 * The client's public keys (keys.clientJwks(), one record per purpose) are not
 * part of the RegisteredClient. Each process that needs them asks the
 * ClientKeyResolver for the keys of its own purpose (ClientKeyResolver in
 * core): private_key_jwt for client assertions, request_object for signed
 * Request Objects, and another purpose (dpop, for one) for a process added
 * later.
 *
 * findClient() and findClientKeys() read the store on every call, so a change
 * made while the OP runs takes effect from the next request. That is how a
 * client starts using private_key_jwt or rotates its keys, without a restart:
 * add { "client_auth_type": "private_key_jwt" } to client_auths of its client
 * record, and put its public keys into keys.clientJwks(client_id,
 * 'private_key_jwt') as { "keys": [ <JWK>, ... ] }.
 */
import {
  hashClientSecret,
  isPublicTokenClient,
  selectRegisteredClientAuthMethods,
  type ClientAuthMethod,
  type ClientKeyPurpose,
  type ClientKeyResolver,
  type ClientResolver,
  type Jwk,
  type JwkSet,
  type TokenClientResolver,
} from '${corePkg}';
import type { ClientRegistration, RegisteredClient } from '../config.js';
import { readRecord, writeRecord, type KvDatabase } from './database.js';
import { keys, type ClientAuthRecord, type ClientJwksRecord, type ClientRecord } from './keys.js';

export function createKvClientResolver(db: KvDatabase): ClientResolver & TokenClientResolver {
  return {
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      const client = await readRecord<ClientRecord>(db, keys.client(clientId));
      if (!client || client.is_deleted) return null;
      const registered: RegisteredClient = {
        clientId,
        clientType: client.client_type === 'public' ? 'public' : 'confidential',
        redirectUris: client.redirect_uris,
      };
      if (client.grant_types.length > 0) registered.grantTypes = client.grant_types;
      if (client.scopes.length > 0) registered.scope = client.scopes;
      if (registered.clientType === 'public') {
        registered.tokenEndpointAuthMethods = ['none'];
      } else if (client.client_auths.length > 0) {
        const secretAuths = client.client_auths.filter(
          (auth): auth is Extract<ClientAuthRecord, { secret: string }> => 'secret' in auth,
        );
        if (secretAuths.length > 1) {
          throw new Error('Client ' + clientId + ' has more than one client_secret method in client_auths');
        }
        registered.tokenEndpointAuthMethods = client.client_auths.map(
          (auth): ClientAuthMethod => auth.client_auth_type,
        );
        if (secretAuths[0]) registered.clientSecretHash = secretAuths[0].secret;
      }
      // A confidential client without client_auths keeps the default
      // client_secret_basic with no secret, so it cannot authenticate.
      return registered;
    },
  };
}

/**
 * The public keys of keys.clientJwks() for one purpose at a time: the
 * ClientKeyResolver the OP uses when no other one is passed in. private_key_jwt
 * reads the record of the private_key_jwt purpose and a signed Request Object
 * that of request_object. A deleted client (is_deleted) has no keys.
 */
export function createKvClientKeyResolver(db: KvDatabase): ClientKeyResolver {
  return {
    async findClientKeys(clientId: string, purpose: ClientKeyPurpose): Promise<JwkSet> {
      const client = await readRecord<ClientRecord>(db, keys.client(clientId));
      if (!client || client.is_deleted) return { keys: [] };
      const record = await readRecord<ClientJwksRecord>(db, keys.clientJwks(clientId, purpose));
      return { keys: [...((record?.keys ?? []) as unknown as Jwk[])] };
    },
  };
}

/**
 * Put a client into the store, replacing an earlier registration with the
 * same client_id. Call it from a setup script or at startup, for example for
 * the clients of config.ts:
 *
 *   for (const client of defaultRegisteredClients.values()) {
 *     await registerClient(db, client);
 *   }
 *
 * The whole client is one record written in one set, so every instance of the
 * OP may register its clients at startup, even at the same moment.
 * clientSecret is saved as its hash (hashClientSecret()).
 *
 * The keys of keys (ClientRegistration.keys) go into keys.clientJwks() of
 * their purpose.
 *
 * private_key_jwt and the keys are only ever added here: the record keeps a
 * private_key_jwt entry of client_auths once it has one, and a key missing
 * from its purpose's keys.clientJwks() is appended to it. Both may be managed
 * in the store while the OP runs (see the top of this file), and registering
 * the client again at the next start keeps them. To remove one, change it in
 * the store, and drop it from the client passed here too, or the next
 * registration adds it back.
 */
export async function registerClient(
  db: KvDatabase,
  client: ClientRegistration & { name?: string },
): Promise<void> {
  const clientType = client.clientType ?? (isPublicTokenClient(client) ? 'public' : 'confidential');
  const secretHash =
    client.clientSecretHash ??
    (client.clientSecret !== undefined ? await hashClientSecret(client.clientSecret) : undefined);
  const methods = clientType === 'confidential' ? selectRegisteredClientAuthMethods(client) : [];
  const secretMethod = methods.find(
    (method): method is 'client_secret_basic' | 'client_secret_post' =>
      method === 'client_secret_basic' || method === 'client_secret_post',
  );
  const current = await readRecord<ClientRecord>(db, keys.client(client.clientId));
  const keepsPrivateKeyJwt =
    clientType === 'confidential' &&
    (methods.includes('private_key_jwt') ||
      (current?.client_auths ?? []).some((auth) => auth.client_auth_type === 'private_key_jwt'));
  const record: ClientRecord = {
    name: client.name ?? null,
    client_type: clientType,
    is_deleted: false,
    client_auths: [
      ...(secretMethod !== undefined && secretHash !== undefined
        ? [{ client_auth_type: secretMethod, secret: secretHash }]
        : []),
      ...(keepsPrivateKeyJwt ? [{ client_auth_type: 'private_key_jwt' as const }] : []),
    ],
    redirect_uris: [...client.redirectUris],
    grant_types: [...(client.grantTypes ?? [])],
    scopes: [...(client.scope ?? [])],
  };
  await writeRecord(db, keys.client(client.clientId), record);

  for (const [purpose, keySet] of Object.entries(client.keys ?? {})) {
    const listedKeys = (keySet?.keys ?? []) as unknown as Array<Record<string, unknown>>;
    if (listedKeys.length === 0) continue;
    const recordKey = keys.clientJwks(client.clientId, purpose);
    const stored = (await readRecord<ClientJwksRecord>(db, recordKey))?.keys ?? [];
    const storedJson = new Set(stored.map((jwk) => JSON.stringify(jwk)));
    const added = listedKeys.filter((jwk) => !storedJson.has(JSON.stringify(jwk)));
    if (added.length > 0) {
      const jwksRecord: ClientJwksRecord = { keys: [...stored, ...added] };
      await writeRecord(db, recordKey, jwksRecord);
    }
  }
}
`;
}

/** db/users.ts of --db kv: registerUser() and the password hashing. */
export function kvUsersTemplate(corePkg: string, features: OidcFeatureConfig): string {
  const google = features.googleLogin;
  return `/**
 * Users in the key-value store: registerUser() to put a user there, and the
 * password hashing that authenticate() (stores.ts) checks the login form
 * against.
 *
 * Passwords are hashed with PBKDF2-HMAC-SHA256 of the Web Crypto API, which
 * every runtime of the generated OP has. A stored hash records its own
 * iteration count and salt ('pbkdf2-sha256$<iterations>$<salt>$<hash>'), so
 * raising PASSWORD_HASH_ITERATIONS later keeps the existing hashes valid.
 */
import type { UserClaims } from '${corePkg}';
import { readRecord, writeRecord, type KvDatabase } from './database.js';
import { keys, type UserRecord } from './keys.js';

${passwordHashingConstants()}
/**
 * Put a user into the store, replacing an earlier registration with the same
 * id (sub). email and email_verified go to their fields, the other claims to
 * claims, and password (when given) is saved as its hash. Without a password
 * the user cannot use the login form of the OP.
 *
 *   await registerUser(db, { sub: 'alice', email: 'alice@example.com', email_verified: true, password: '...' });
 */
export async function registerUser(
  db: KvDatabase,
  user: UserClaims & { password?: string },
): Promise<void> {
  const { sub, email, email_verified, password, ...otherClaims } = user;
  const now = Math.floor(Date.now() / 1000);
  const current = await readRecord<UserRecord>(db, keys.user(sub));
  const record: UserRecord = {
    email: email ?? null,
    is_verified: email_verified === true,
    password_hash: password === undefined ? null : await hashPassword(password),
    created_at: current?.created_at ?? now,
    updated_at: now,
    claims: otherClaims,${google ? `
    // A Google account linked to the user stays linked.
    ...(current?.federated_identities ? { federated_identities: current.federated_identities } : {}),` : ''}
  };
  await writeRecord(db, keys.user(sub), record);
}

${passwordHashingFunctions("a user's password_hash")}`;
}

const KV_INSTANCE_HEADER = `/**
 * The key-value store instance: the one file in db/ that you write.
 *
 * The CLI creates this file only when it does not exist yet and never
 * overwrites it, not even with --force, so your code here survives
 * re-generation. Everything else in db/ is generated.
 *
 * createDatabase() returns a KvDatabase (database.ts): get, set, setIfAbsent
 * and delete on string keys and values. Wrap the client of your store in them;
 * the examples at the end of this file are starting points. setIfAbsent must
 * be atomic, and a get must see the writes that finished before it
 * (database.ts says why, and why Cloudflare Workers KV does not fit). The OP
 * reads its clients and users from the store, so register them there with
 * registerClient() (clients.ts) and registerUser() (users.ts).`;

const KV_NOT_IMPLEMENTED_ERROR = `    'db/instance.ts: createDatabase() is not implemented yet. ' +
      'Return the key-value store the OP keeps its data in (see the examples in that file).',`;

/**
 * The Upstash Redis REST example (Vercel KV is Upstash): fetch alone, so it
 * runs on every target. env reads the URL and the token.
 */
function upstashExample(signature: string, env: string): string {
  return `// Upstash Redis over its REST API (Vercel KV is Upstash too). fetch is all
// it needs, so it runs on Node.js, Vercel and Cloudflare Workers alike:
//
//   const upstash = async (url: string, token: string, command: Array<string | number>) => {
//     const response = await fetch(url, {
//       method: 'POST',
//       headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
//       body: JSON.stringify(command),
//     });
//     const body = (await response.json()) as { result?: unknown; error?: string };
//     if (!response.ok || body.error !== undefined) {
//       throw new Error('Upstash: ' + (body.error ?? 'HTTP ' + response.status));
//     }
//     return body.result;
//   };
//
//   ${signature} {
//     const run = (command: Array<string | number>) =>
//       upstash(${env}.UPSTASH_REDIS_REST_URL as string, ${env}.UPSTASH_REDIS_REST_TOKEN as string, command);
//     const expiry = (ttlSeconds?: number) => (ttlSeconds === undefined ? [] : ['EX', ttlSeconds]);
//     return {
//       get: async (key) => (await run(['GET', key])) as string | null,
//       set: async (key, value, ttlSeconds) => {
//         await run(['SET', key, value, ...expiry(ttlSeconds)]);
//       },
//       setIfAbsent: async (key, value, ttlSeconds) =>
//         (await run(['SET', key, value, 'NX', ...expiry(ttlSeconds)])) === 'OK',
//       delete: async (key) => {
//         await run(['DEL', key]);
//       },
//     };
//   }`;
}

/** The in-memory example: one Map, for trying the OP out in one process. */
function memoryExample(signature: string, note: string, entries: string): string {
  return `// In memory, for trying the OP out: ${note}
//
${entries}
//   const live = (key: string) => {
//     const entry = entries.get(key);
//     if (entry && entry.expiresAt <= Date.now()) entries.delete(key);
//     return entries.get(key);
//   };
//   const expiry = (ttlSeconds?: number) =>
//     ttlSeconds === undefined ? Number.POSITIVE_INFINITY : Date.now() + ttlSeconds * 1000;
//
//   ${signature} {
//     return {
//       get: async (key) => live(key)?.value ?? null,
//       set: async (key, value, ttlSeconds) => {
//         entries.set(key, { value, expiresAt: expiry(ttlSeconds) });
//       },
//       setIfAbsent: async (key, value, ttlSeconds) => {
//         if (live(key)) return false;
//         entries.set(key, { value, expiresAt: expiry(ttlSeconds) });
//         return true;
//       },
//       delete: async (key) => {
//         entries.delete(key);
//       },
//     };
//   }`;
}

/** The Map of the in-memory example, in a module-level variable. */
const MODULE_MAP = '//   const entries = new Map<string, { value: string; expiresAt: number }>();';

/** The Map of the in-memory example, on globalThis (Next.js). */
const GLOBAL_MAP = `//   const registry = globalThis as typeof globalThis & {
//     __oidcKv?: Map<string, { value: string; expiresAt: number }>;
//   };
//   const entries = (registry.__oidcKv ??= new Map());`;

/** The examples for a Redis server over TCP (node-redis, ioredis). */
function redisExamples(signature: string): string {
  return `// Redis, Valkey and other Redis servers with node-redis (pnpm add redis):
//
//   import { createClient } from 'redis';
//
//   const redis = createClient({ url: process.env.REDIS_URL });
//   const connected = redis.connect();
//
//   ${signature} {
//     return {
//       get: async (key) => {
//         await connected;
//         return redis.get(key);
//       },
//       set: async (key, value, ttlSeconds) => {
//         await connected;
//         if (ttlSeconds === undefined) await redis.set(key, value);
//         else await redis.set(key, value, { expiration: { type: 'EX', value: ttlSeconds } });
//       },
//       setIfAbsent: async (key, value, ttlSeconds) => {
//         await connected;
//         const reply =
//           ttlSeconds === undefined
//             ? await redis.set(key, value, { condition: 'NX' })
//             : await redis.set(key, value, {
//               condition: 'NX',
//               expiration: { type: 'EX', value: ttlSeconds },
//             });
//         return reply === 'OK';
//       },
//       delete: async (key) => {
//         await connected;
//         await redis.del(key);
//       },
//     };
//   }
//
// Redis with ioredis (pnpm add ioredis):
//
//   import { Redis } from 'ioredis';
//
//   const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
//
//   ${signature} {
//     return {
//       get: (key) => redis.get(key),
//       set: async (key, value, ttlSeconds) => {
//         if (ttlSeconds === undefined) await redis.set(key, value);
//         else await redis.set(key, value, 'EX', ttlSeconds);
//       },
//       setIfAbsent: async (key, value, ttlSeconds) =>
//         (ttlSeconds === undefined
//           ? await redis.set(key, value, 'NX')
//           : await redis.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK',
//       delete: async (key) => {
//         await redis.del(key);
//       },
//     };
//   }`;
}

/** db/instance.ts of --db kv: the stub the user replaces, with examples. */
export function kvInstanceTemplate(target: DbInstanceTarget): string {
  if (target === 'hono') {
    return `${KV_INSTANCE_HEADER}
 *
 * The generated app calls createDatabase() for every request with the Hono
 * context, so the URL and token of a store can be read from its bindings
 * (c.env). Keep a client that must outlive a request in a module-level
 * variable instead of creating it here.
 */
import type { Context } from 'hono';
import type { KvDatabase } from './database.js';

export function createDatabase(_c: Context): KvDatabase {
  throw new Error(
${KV_NOT_IMPLEMENTED_ERROR}
  );
}

// ---------------------------------------------------------------------------
// Examples. Replace createDatabase() above with one of them, adapted to your
// project; each needs: import type { KvDatabase } from './database.js';
//
${upstashExample('export function createDatabase(c: Context): KvDatabase', 'c.env')}
//
${memoryExample(
  'export function createDatabase(_c: Context): KvDatabase',
  'the data lives in the memory of one isolate,\n// so it is lost on every restart and never shared between isolates. It fits\n// wrangler dev and nothing else:',
  MODULE_MAP,
)}
`;
  }

  if (target === 'nextjs') {
    return `${KV_INSTANCE_HEADER}
 *
 * provider.ts calls createDatabase() on the first query, not at import, so
 * \`next build\` does not need the store as long as this module does not
 * connect when it is imported. Next.js loads provider.ts once per module layer
 * (Route Handlers, Server Actions), so keep a client on globalThis when the
 * store limits its connections, and keep an in-memory store there too.
 */
import type { KvDatabase } from './database';

export function createDatabase(): KvDatabase {
  throw new Error(
${KV_NOT_IMPLEMENTED_ERROR}
  );
}

// ---------------------------------------------------------------------------
// Examples. Replace createDatabase() above with one of them, adapted to your
// project; each needs: import type { KvDatabase } from './database';
//
${upstashExample('export function createDatabase(): KvDatabase', 'process.env')}
//
${redisExamples('export function createDatabase(): KvDatabase')}
//
${memoryExample(
  'export function createDatabase(): KvDatabase',
  'the data lives in the memory of one server\n// process, so it is lost on every restart and never shared between instances\n// (on Vercel, between functions). The Map is kept on globalThis, because the\n// module layers of Next.js do not share module-level variables:',
  GLOBAL_MAP,
)}
`;
  }

  return `${KV_INSTANCE_HEADER}
 *
 * The generated app calls createDatabase() once, when it is created.
 */
import type { KvDatabase } from './database.js';

export function createDatabase(): KvDatabase {
  throw new Error(
${KV_NOT_IMPLEMENTED_ERROR}
  );
}

// ---------------------------------------------------------------------------
// Examples. Replace createDatabase() above with one of them, adapted to your
// project; each needs: import type { KvDatabase } from './database.js';
//
${redisExamples('export function createDatabase(): KvDatabase')}
//
${upstashExample('export function createDatabase(): KvDatabase', 'process.env')}
//
${memoryExample(
  'export function createDatabase(): KvDatabase',
  'the data lives in the memory of one process,\n// so it is lost on every restart and never shared between processes:',
  MODULE_MAP,
)}
`;
}
