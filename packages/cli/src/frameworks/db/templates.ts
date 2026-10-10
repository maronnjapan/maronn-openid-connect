/**
 * Templates for the db/ directory generated with --db.
 *
 * The generated OP keeps its data in SQL tables instead of the in-memory or
 * JSON key/value stores, and reads its registered clients from them too. The
 * tables follow the ER model of the OP (clients, users, authorization
 * transactions, codes and tokens); the tables of Sign in with Google exist only
 * with --enable google-login. Everything in db/ is generated except
 * instance.ts: that file creates the database instance, so it is written by
 * the user, created only when it does not exist yet, and never overwritten.
 *
 * The SQL is written once for every supported database: it only uses what
 * SQLite, Cloudflare D1 and PostgreSQL share (? placeholders, ON CONFLICT,
 * RETURNING, BIGINT, BOOLEAN with TRUE / FALSE), and every value bound to it is
 * a string, a number or null.
 */
import type { GeneratedFile } from '../types.js';
import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import { GOOGLE_LOGIN_PACKAGE } from '../hono/templates.js';

/**
 * Where the generated app calls createDatabase() from, which decides its
 * signature and the examples instance.ts shows.
 *
 * - hono: once per request with the Hono context (a D1 binding is read from it)
 * - node: once when the Express / Fastify app is created
 * - nextjs: on the first query, from _oidc-provider/provider.ts
 */
export type DbInstanceTarget = 'hono' | 'node' | 'nextjs';

/** The db/ files, relative to the generated provider directory. */
export function dbGeneratedFiles(
  corePkg: string,
  features: OidcFeatureConfig,
  target: DbInstanceTarget,
): GeneratedFile[] {
  return [
    // The one file the user writes: created once, never overwritten.
    { path: 'db/instance.ts', content: dbInstanceTemplate(target), userOwned: true },
    { path: 'db/database.ts', content: dbDatabaseTemplate() },
    { path: 'db/schema.sql', content: dbSchemaSql(features) },
    { path: 'db/schema.ts', content: dbSchemaModuleTemplate(features) },
    { path: 'db/stores.ts', content: dbStoresTemplate(corePkg, features) },
    { path: 'db/clients.ts', content: dbClientsTemplate(corePkg) },
    { path: 'db/users.ts', content: dbUsersTemplate(corePkg) },
  ];
}

export function dbDatabaseTemplate(): string {
  return `/**
 * The database contract of the generated OP (--db).
 *
 * db/stores.ts and db/clients.ts run every query through these two methods,
 * and db/instance.ts creates the object that implements them for your
 * database. Any driver or ORM can implement them, because every one of them
 * can run raw SQL.
 *
 * - Values are bound with ? placeholders, in order. An adapter for a driver
 *   that numbers its placeholders (PostgreSQL: $1, $2, ...) rewrites each ?
 *   into the next number; the generated SQL never has a ? inside a literal.
 * - Bound values are only strings, numbers and null: times are epoch seconds
 *   and objects are JSON text. Booleans are never bound. The statements write
 *   them as the literals TRUE / FALSE, because not every PostgreSQL driver
 *   accepts a bound number for a BOOLEAN column.
 * - Rows come back the way the driver returns them. stores.ts reads a BIGINT
 *   that pg returns as a string, and a BOOLEAN that SQLite returns as 1 / 0.
 * - There is no transaction API. Each store operation runs its statements one
 *   at a time, and the database applies a statement's condition and its
 *   change together.
 */
export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params: SqlValue[];
}

export interface SqlDatabase {
  /** Run a statement that returns rows (SELECT, DELETE ... RETURNING). */
  all<Row>(statement: SqlStatement): Promise<Row[]>;
  /** Run a statement that returns no rows (INSERT, UPDATE, DELETE) and report how many rows it changed. */
  run(statement: SqlStatement): Promise<{ changes: number }>;
}
`;
}

/**
 * The table definitions (db/schema.sql). The same statements are exported as
 * SCHEMA_SQL from db/schema.ts for applying them at startup.
 *
 * Each table is an entity of the ER model of the OP, named in its comment.
 * Tables and columns the OP needs beyond that model say "Not in the ER model".
 * No comment may contain a semicolon: a migration tool that splits the file
 * into statements would cut the comment there.
 */
export function dbSchemaSql(features: OidcFeatureConfig = DEFAULT_FEATURES): string {
  const federatedIdentityTable = features.googleLogin
    ? `
-- Federated_identity (google-login): the account of a user at an external IdP.
-- A user is found by provider_sub, which the IdP never reassigns, and never by
-- email.
CREATE TABLE IF NOT EXISTS federated_identities (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider     VARCHAR(1000) NOT NULL,
  provider_sub VARCHAR(255) NOT NULL,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  UNIQUE (provider, provider_sub)
);
CREATE INDEX IF NOT EXISTS federated_identities_user_id_idx ON federated_identities (user_id);
`
    : '';
  const upstreamAuthRequestTable = features.googleLogin
    ? `
-- Upstream_auth_request (google-login): the sign-in at Google a transaction
-- waits for. nonce is the value the login page puts in the Google button, and
-- Google returns it in its ID Token. Sign in with Google (redirect mode) sends
-- no state and uses no PKCE, so state and code_verifier stay NULL. Only the
-- latest login page of a transaction has a working Google button.
CREATE TABLE IF NOT EXISTS upstream_auth_requests (
  transaction_id VARCHAR(5000) PRIMARY KEY
    REFERENCES transactions (transaction_id) ON DELETE CASCADE,
  provider       VARCHAR(1000) NOT NULL,
  state          VARCHAR(5000) UNIQUE,
  nonce          VARCHAR(5000) NOT NULL UNIQUE,
  code_verifier  VARCHAR(5000)
);
`
    : '';
  const upstreamStatusNote = features.googleLogin
    ? ''
    : `
-- (upstream_pending is used by Sign in with Google, --enable google-login.)`;
  return `-- Tables of the generated OpenID Provider (db/stores.ts, db/clients.ts and db/users.ts).
--
-- The tables follow the ER model of the OP: clients, users, authorization
-- transactions, codes and tokens. Each comment names the entity a table
-- stores, and what the OP needs beyond that model is marked "Not in the ER
-- model".
--
-- The same statements run on SQLite, Cloudflare D1 and PostgreSQL. Dates are
-- epoch seconds in BIGINT columns, because the three share no date type that
-- every driver binds and reads the same way. Booleans are BOOLEAN, and JSON is
-- TEXT. Codes and tokens are stored as their SHA-256 hash, client secrets as
-- the hash from hashClientSecret() and passwords as the hash from
-- hashPassword(), so the database holds no credential that works as it is.
--
-- Foreign keys tie together the rows of one client, of one user and of one
-- authorization transaction. Transactions and tokens do not reference clients
-- or users with a foreign key, so the OP still works when clients or users come
-- from elsewhere (options.clientResolver, your own userStore). SQLite checks
-- foreign keys only with PRAGMA foreign_keys = ON, which node:sqlite and D1
-- turn on by default.
--
-- Expired rows are not deleted by the OP. Delete them on a schedule if needed,
-- e.g. DELETE FROM transactions WHERE expired_at <= <now in epoch seconds>.

-- Client: a registered client, id being its client_id. The OP does not know a
-- deleted client (is_deleted).
CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,
  name        VARCHAR(1000),
  client_type VARCHAR(1000) NOT NULL CHECK (client_type IN ('public', 'confidential')),
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE
);

-- Client_auth: how the client authenticates at the token endpoint. A public
-- client has none, and a confidential client has one. Another method (such as
-- private_key_jwt) is added here, with a table of its own like client_secrets,
-- when the OP supports it.
CREATE TABLE IF NOT EXISTS client_auths (
  id               TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  client_auth_type VARCHAR(1000) NOT NULL
    CHECK (client_auth_type IN ('client_secret_basic', 'client_secret_post')),
  UNIQUE (id, client_auth_type)
);
CREATE INDEX IF NOT EXISTS client_auths_client_id_idx ON client_auths (client_id);

-- Client_secret: the secret of a client_secret_basic / client_secret_post
-- row. client_auth_type is part of the foreign key, so it always equals the
-- type of its client_auths row. secret is the hash from hashClientSecret().
CREATE TABLE IF NOT EXISTS client_secrets (
  id               TEXT PRIMARY KEY,
  client_auth_type VARCHAR(1000) NOT NULL
    CHECK (client_auth_type IN ('client_secret_basic', 'client_secret_post')),
  secret           VARCHAR(5000) NOT NULL,
  FOREIGN KEY (id, client_auth_type)
    REFERENCES client_auths (id, client_auth_type) ON DELETE CASCADE
);

-- Redirect_Uri: the redirect URIs of the client.
CREATE TABLE IF NOT EXISTS client_redirect_uris (
  id        TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  value     VARCHAR(5000) NOT NULL
);
CREATE INDEX IF NOT EXISTS client_redirect_uris_client_id_idx ON client_redirect_uris (client_id);

-- Grant: the grant types the client may use. A client without rows may use
-- authorization_code only.
CREATE TABLE IF NOT EXISTS client_grant_types (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  grant_type VARCHAR(1000) NOT NULL
);
CREATE INDEX IF NOT EXISTS client_grant_types_client_id_idx ON client_grant_types (client_id);

-- Scope: the scopes the client may request. A request for any other scope is
-- rejected with invalid_scope. A client without rows may request every scope
-- the OP accepts.
CREATE TABLE IF NOT EXISTS client_scopes (
  id        TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  value     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS client_scopes_client_id_idx ON client_scopes (client_id);

-- User: a user of the OP. email and is_verified are the email and
-- email_verified claims. password_hash is the hash from hashPassword()
-- (users.ts), and NULL for a user who has no password and signs in another
-- way (such as Sign in with Google).
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         VARCHAR(1000),
  is_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash VARCHAR(1000),
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  -- Not in the ER model: the other claims of the user (name, address, ...) as JSON.
  claims        TEXT
);
${federatedIdentityTable}
-- Transaction: one authorization request, from /authorize until its code is
-- exchanged. status moves requested -> upstream_pending -> authenticated ->
-- code_issued -> token_issued, or ends as failed without a code.${upstreamStatusNote}
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id VARCHAR(5000) PRIMARY KEY,
  status         VARCHAR(1000) NOT NULL CHECK (status IN
    ('requested', 'upstream_pending', 'authenticated', 'code_issued', 'token_issued', 'failed')),
  created_at     BIGINT NOT NULL,
  expired_at     BIGINT NOT NULL,
  -- Not in the ER model: the CSRF token, the count of failed logins and the
  -- hash that binds the transaction to its browser, as JSON.
  payload        TEXT NOT NULL
);

-- Authentication_request: the validated parameters of the authorization request.
CREATE TABLE IF NOT EXISTS authentication_requests (
  transaction_id        VARCHAR(5000) PRIMARY KEY
    REFERENCES transactions (transaction_id) ON DELETE CASCADE,
  client_id             VARCHAR(5000) NOT NULL,
  redirect_uri          TEXT NOT NULL,
  state                 VARCHAR(5000),
  nonce                 VARCHAR(5000),
  code_challenge        VARCHAR(5000),
  code_challenge_method VARCHAR(5000),
  response_type         VARCHAR(5000) NOT NULL,
  scope                 TEXT,
  -- Always NULL: the OP verifies a Request Object and keeps its parameters in
  -- the other columns, not the object itself.
  request_object        TEXT,
  -- Not in the ER model: the other parameters (prompt, max_age, claims, ...) as JSON.
  payload               TEXT NOT NULL
);
${upstreamAuthRequestTable}
-- Auth_user: who signed in for the transaction, handed from the login step to
-- the consent step. auth_type is password (the login form of the OP) or the
-- provider of a federated sign-in, such as google.
CREATE TABLE IF NOT EXISTS auth_users (
  transaction_id VARCHAR(5000) PRIMARY KEY
    REFERENCES transactions (transaction_id) ON DELETE CASCADE,
  user_id        VARCHAR(5000) NOT NULL,
  auth_type      VARCHAR(5000) NOT NULL,
  -- Not in the ER model: when the user signed in, and the browser session it started.
  auth_time      BIGINT NOT NULL,
  session_id     TEXT
);

-- Code: an authorization code. id is the SHA-256 hash of the code.
CREATE TABLE IF NOT EXISTS codes (
  id             TEXT PRIMARY KEY,
  transaction_id VARCHAR(5000) REFERENCES transactions (transaction_id) ON DELETE SET NULL,
  expired_at     BIGINT NOT NULL,
  is_used        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Not in the ER model: the grant the tokens of the code belong to, and the
  -- rest of the code (client, redirect_uri, scope, user, PKCE, ...) as JSON.
  grant_id       TEXT NOT NULL,
  payload        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS codes_grant_id_idx ON codes (grant_id);

-- Access_token: an issued access token. id is its jti. The token itself is not
-- stored: it is looked up by token_hash, its SHA-256 hash.
CREATE TABLE IF NOT EXISTS access_tokens (
  id                    TEXT PRIMARY KEY,
  sub                   VARCHAR(5000) NOT NULL,
  exp                   BIGINT NOT NULL,
  iat                   BIGINT,
  iss                   VARCHAR(5000),
  client_id             VARCHAR(5000) NOT NULL,
  scope                 TEXT,
  -- Always NULL: the OP does not issue authorization_details (RFC 9396) yet.
  authorization_details TEXT,
  transaction_id        VARCHAR(5000) REFERENCES transactions (transaction_id) ON DELETE SET NULL,
  -- Not in the ER model: the lookup hash, the grant, and the rest of the token
  -- (nbf, audience, claims) as JSON.
  token_hash            TEXT NOT NULL UNIQUE,
  grant_id              TEXT,
  payload               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS access_tokens_grant_id_idx ON access_tokens (grant_id);

-- Refresh_token: an issued refresh token. id is the SHA-256 hash of the token,
-- and access_token_id the access token of the same token response.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              TEXT PRIMARY KEY,
  access_token_id TEXT REFERENCES access_tokens (id) ON DELETE SET NULL,
  exp             BIGINT NOT NULL,
  iat             BIGINT,
  is_used         BOOLEAN NOT NULL DEFAULT FALSE,
  -- Not in the ER model: the grant, and the rest of the token (user, scope,
  -- auth_time, the session it is bound to, ...) as JSON.
  grant_id        TEXT NOT NULL,
  payload         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refresh_tokens_grant_id_idx ON refresh_tokens (grant_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_access_token_id_idx ON refresh_tokens (access_token_id);

-- Not in the ER model: OP browser sessions (the session_id cookie) for SSO,
-- prompt=none and max_age.
CREATE TABLE IF NOT EXISTS browser_sessions (
  session_id TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  auth_time  BIGINT NOT NULL
);

-- Not in the ER model: the scopes a user granted to a client, one row per scope.
CREATE TABLE IF NOT EXISTS consent_scopes (
  subject   TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope     TEXT NOT NULL,
  PRIMARY KEY (subject, client_id, scope)
);

-- Not in the ER model: the grants issued under a consent, so revoking the
-- consent revokes their tokens.
CREATE TABLE IF NOT EXISTS consent_grants (
  subject   TEXT NOT NULL,
  client_id TEXT NOT NULL,
  grant_id  TEXT NOT NULL,
  PRIMARY KEY (subject, client_id, grant_id)
);
`;
}

export function dbSchemaModuleTemplate(features: OidcFeatureConfig = DEFAULT_FEATURES): string {
  return `/**
 * The statements of db/schema.sql, for databases that are set up at startup
 * (for example node:sqlite: database.exec(SCHEMA_SQL)). Every statement is
 * CREATE ... IF NOT EXISTS, so running it again is harmless.
 */
export const SCHEMA_SQL = \`${dbSchemaSql(features)}\`;
`;
}

export function dbStoresTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const googleLoginTypeImport = features.googleLogin
    ? `
import type { GoogleLoginNonceStore } from '${GOOGLE_LOGIN_PACKAGE}';`
    : '';
  const googleStoreImport = features.googleLogin ? '\n  googleAccountToClaims,' : '';
  const googleNonceKeyPrefix = features.googleLogin
    ? `
/** google-login prefixes the nonce of every GoogleLoginNonceStore key with this. */
const GOOGLE_LOGIN_NONCE_KEY_PREFIX = 'google_login_nonce:';
`
    : '';
  // auth_type of auth_users: the provider of the user's federated identity, or
  // password. Without google-login there is no federated identity.
  const authTypeHelper = features.googleLogin
    ? `
  // auth_type of a sign-in (auth_users): the provider of the user's federated
  // identity, or password. A user created by Sign in with Google has no
  // password, and registerUser() (users.ts) creates no federated identity, so
  // each user signs in one way only unless you link a Google account to a
  // user with a password yourself.
  const authTypeOf = async (userId: string): Promise<string> => {
    const [row] = await db.all<{ provider: string }>({
      sql: 'SELECT provider FROM federated_identities WHERE user_id = ? ORDER BY created_at LIMIT 1',
      params: [userId],
    });
    return row?.provider ?? 'password';
  };
`
    : '';
  const authTypeValue = features.googleLogin ? 'await authTypeOf(info.subject)' : "'password'";
  const googleUserHelpers = features.googleLogin
    ? `
  // EXTENSION (google-login): the user linked to a Google account, if any.
  const findGoogleUser = async (googleSub: string): Promise<string | undefined> => {
    const [row] = await db.all<{ user_id: string }>({
      sql: "SELECT user_id FROM federated_identities WHERE provider = 'google' AND provider_sub = ?",
      params: [googleSub],
    });
    return row?.user_id;
  };

  // EXTENSION (google-login): create the user of a Google account on its first
  // sign-in, under a new random id. Two first sign-ins of one account may race:
  // UNIQUE (provider, provider_sub) keeps one federated identity, and the user
  // created by the other request is removed again.
  const createGoogleUser = async (googleSub: string): Promise<string> => {
    const userId = crypto.randomUUID();
    const now = nowSeconds();
    await db.run({
      sql: 'INSERT INTO users (id, is_verified, created_at, updated_at) VALUES (?, FALSE, ?, ?)',
      params: [userId, now, now],
    });
    await db.run({
      sql:
        'INSERT INTO federated_identities (id, user_id, provider, provider_sub, created_at, updated_at) ' +
        "VALUES (?, ?, 'google', ?, ?, ?) ON CONFLICT (provider, provider_sub) DO NOTHING",
      params: [crypto.randomUUID(), userId, googleSub, now, now],
    });
    const linkedUserId = (await findGoogleUser(googleSub)) ?? userId;
    if (linkedUserId !== userId) {
      await db.run({ sql: 'DELETE FROM users WHERE id = ?', params: [userId] });
    }
    return linkedUserId;
  };

  // EXTENSION (google-login): save the claims Google asserted to the user:
  // email and email_verified to their columns, the others to claims as JSON.
  // password_hash is left as it is.
  const saveGoogleClaims = async (claims: UserClaims): Promise<void> => {
    const { sub, email, email_verified, ...otherClaims } = claims;
    await db.run({
      sql:
        'UPDATE users SET email = ?, is_verified = ' + sqlBoolean(email_verified === true) + ', ' +
        'updated_at = ?, claims = ? WHERE id = ?',
      params: [email ?? null, nowSeconds(), JSON.stringify(otherClaims), sub],
    });
  };
`
    : '';
  const linkGoogleAccount = features.googleLogin
    ? `
    // EXTENSION (google-login): find or create the user of a verified Google
    // account by its federated identity (never by email), and save the claims
    // Google asserted.
    async linkGoogleAccount(account) {
      const userId = (await findGoogleUser(account.sub)) ?? (await createGoogleUser(account.sub));
      const claims: UserClaims = { ...googleAccountToClaims(account), sub: userId };
      await saveGoogleClaims(claims);
      return claims;
    },`
    : '';
  const googleLoginNonceStore = features.googleLogin
    ? `
  // EXTENSION (google-login): the nonce of the Google button, kept as the
  // upstream_auth_requests row of its transaction. A transaction has one row,
  // so a newer login page replaces the nonce of an older one. The record
  // expires with the transaction.
  const googleLoginNonceStore: GoogleLoginNonceStore = {
    async get(key) {
      const [row] = await db.all<{ transaction_id: string; expired_at: number | string }>({
        sql:
          'SELECT u.transaction_id, t.expired_at FROM upstream_auth_requests u ' +
          'JOIN transactions t ON t.transaction_id = u.transaction_id ' +
          'WHERE u.nonce = ? AND t.expired_at > ?',
        params: [withoutPrefix(key, GOOGLE_LOGIN_NONCE_KEY_PREFIX), nowSeconds()],
      });
      return row ? { transactionId: row.transaction_id, expiresAt: Number(row.expired_at) * 1000 } : null;
    },
    async put(key, value, _ttlSeconds) {
      await db.run({
        sql:
          "INSERT INTO upstream_auth_requests (transaction_id, provider, nonce) VALUES (?, 'google', ?) " +
          'ON CONFLICT (transaction_id) DO UPDATE SET provider = excluded.provider, nonce = excluded.nonce',
        params: [value.transactionId, withoutPrefix(key, GOOGLE_LOGIN_NONCE_KEY_PREFIX)],
      });
      await db.run({
        sql: "UPDATE transactions SET status = 'upstream_pending' WHERE transaction_id = ? AND status = 'requested'",
        params: [value.transactionId],
      });
    },
    async delete(key) {
      await db.run({
        sql: 'DELETE FROM upstream_auth_requests WHERE nonce = ?',
        params: [withoutPrefix(key, GOOGLE_LOGIN_NONCE_KEY_PREFIX)],
      });
    },
  };
`
    : '';
  const googleLoginNonceStoreEntry = features.googleLogin ? '\n    googleLoginNonceStore,' : '';
  return `/**
 * ProviderStores (store.ts) on the tables of db/schema.sql: the stores the OP
 * uses when no other storage is passed in. Every SQL statement runs through
 * the SqlDatabase that db/instance.ts creates. An operation that touches two
 * tables (a transaction and its request, a code and the status of its
 * transaction) runs its statements one after another.
 *
 * Rewriting this file for another driver or an ORM is fine, but keep these
 * behaviors - routes/ and resolvers.ts rely on them:
 *
 * 1. Keep the ProviderStores types (method names, parameters, return values).
 * 2. authCodeStore.consume and refreshTokenStore.consume flip is_used from
 *    FALSE to TRUE in ONE conditional UPDATE, and throw TokenError
 *    (invalid_grant) when it changed no row. A SELECT followed by an UPDATE
 *    lets two concurrent requests both see an unused code and both receive
 *    tokens (OAuth 2.1 §4.1.2).
 * 3. consume never deletes the row. A used code or a rotated refresh token has
 *    to stay readable, so a replay is detected and the grant's tokens revoked.
 * 4. get never returns an expired row, and does return used ones.
 * 5. revokeByGrantId also removes the rotated (used) refresh tokens of the grant.
 * 6. hasConsent is true only when every requested scope was granted.
 * 7. Codes and tokens are stored and looked up by their SHA-256 hash; the raw
 *    value is never written to the database.
 * 8. transactionStore.get returns a transaction only while it is in progress
 *    (requested, upstream_pending, authenticated), and delete ends it instead
 *    of removing the row: its status becomes failed, then code_issued if a code
 *    is issued from it, and token_issued once that code is exchanged.
 */
import {
  TokenError,
  TokenErrorCode,
  type AccessTokenInfo,
  type AuthTransaction,
  type AuthTransactionStore,
  type AuthorizationCodeData,
  type AuthorizationCodeInfo,
  type RefreshTokenInfo,
  type UserClaims,
} from '${corePkg}';${googleLoginTypeImport}
import {${googleStoreImport}
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
import { verifyPassword } from './users.js';

/** core prefixes the id of every AuthTransactionStore key with this. */
const TRANSACTION_KEY_PREFIX = 'auth_txn:';
${googleNonceKeyPrefix}
/** The statuses of a transaction in progress. */
const IN_PROGRESS = "('requested', 'upstream_pending', 'authenticated')";

export function createSqlProviderStores(db: SqlDatabase): ProviderStores {
  // Transaction + Authentication_request: what the authorization request asked
  // for goes to authentication_requests, the state of the flow to transactions.
  const transactionStore: AuthTransactionStore = {
    async get(key) {
      const [row] = await db.all<TransactionRow>({
        sql:
          'SELECT t.created_at, t.expired_at, t.payload AS transaction_payload, r.client_id, ' +
          'r.redirect_uri, r.state, r.nonce, r.code_challenge, r.code_challenge_method, ' +
          'r.response_type, r.scope, r.payload AS request_payload FROM transactions t ' +
          'JOIN authentication_requests r ON r.transaction_id = t.transaction_id ' +
          'WHERE t.transaction_id = ? AND t.status IN ' + IN_PROGRESS + ' AND t.expired_at > ?',
        params: [withoutPrefix(key, TRANSACTION_KEY_PREFIX), nowSeconds()],
      });
      if (!row) return null;
      const transaction: AuthTransaction = {
        ...(JSON.parse(row.request_payload) as OtherRequestParameters),
        ...(JSON.parse(row.transaction_payload) as TransactionPayload),
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        responseType: row.response_type,
        scope: row.scope ?? '',
        createdAt: Number(row.created_at) * 1000,
        expiresAt: Number(row.expired_at) * 1000,
      };
      if (row.state !== null) transaction.state = row.state;
      if (row.nonce !== null) transaction.nonce = row.nonce;
      if (row.code_challenge !== null) transaction.codeChallenge = row.code_challenge;
      if (row.code_challenge_method !== null) {
        transaction.codeChallengeMethod = row.code_challenge_method as 'S256';
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
      // A new transaction starts as requested. Saving it again (a failed login
      // attempt) keeps its status.
      await db.run({
        sql:
          'INSERT INTO transactions (transaction_id, status, created_at, expired_at, payload) ' +
          "VALUES (?, 'requested', ?, ?, ?) " +
          'ON CONFLICT (transaction_id) DO UPDATE SET expired_at = excluded.expired_at, payload = excluded.payload',
        params: [
          transactionId,
          Math.floor(createdAt / 1000),
          Math.ceil(expiresAt / 1000),
          JSON.stringify({ csrfToken, failedAttempts, bindingHash }),
        ],
      });
      await db.run({
        sql:
          'INSERT INTO authentication_requests (transaction_id, client_id, redirect_uri, state, nonce, ' +
          'code_challenge, code_challenge_method, response_type, scope, payload) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT (transaction_id) DO UPDATE SET client_id = excluded.client_id, ' +
          'redirect_uri = excluded.redirect_uri, state = excluded.state, nonce = excluded.nonce, ' +
          'code_challenge = excluded.code_challenge, code_challenge_method = excluded.code_challenge_method, ' +
          'response_type = excluded.response_type, scope = excluded.scope, payload = excluded.payload',
        params: [
          transactionId,
          clientId,
          redirectUri,
          state ?? null,
          nonce ?? null,
          codeChallenge ?? null,
          codeChallengeMethod ?? null,
          responseType,
          scope,
          JSON.stringify(otherParameters),
        ],
      });
    },
    // One-time use: the transaction is no longer in progress, and its row stays.
    async delete(key) {
      await db.run({
        sql: "UPDATE transactions SET status = 'failed' WHERE transaction_id = ? AND status IN " + IN_PROGRESS,
        params: [withoutPrefix(key, TRANSACTION_KEY_PREFIX)],
      });
    },
  };

  const authCodeStore: AuthorizationCodeStorage = {
    async set(code, info) {
      // The routes pass core's AuthorizationCodeData, which names the
      // transaction the code was issued from. Neither the raw code nor a value
      // with its own column goes into payload.
      const { code: _code, used, expiresAt, grantId, transactionId, ...payload } =
        info as AuthorizationCodeInfo & Pick<AuthorizationCodeData, 'transactionId'>;
      await db.run({
        sql:
          'INSERT INTO codes (id, transaction_id, expired_at, is_used, grant_id, payload) ' +
          'VALUES (?, ?, ?, ' + sqlBoolean(used) + ', ?, ?)',
        params: [await hashKey(code), transactionId ?? null, expiresAt, grantId, JSON.stringify(payload)],
      });
      if (transactionId !== undefined) {
        await db.run({
          sql: "UPDATE transactions SET status = 'code_issued' WHERE transaction_id = ?",
          params: [transactionId],
        });
      }
    },
    async get(code) {
      const [row] = await db.all<CodeRow>({
        sql: 'SELECT expired_at, is_used, grant_id, payload FROM codes WHERE id = ? AND expired_at > ?',
        params: [await hashKey(code), nowSeconds()],
      });
      if (!row) return undefined;
      const payload = JSON.parse(row.payload) as Omit<
        AuthorizationCodeInfo,
        'code' | 'used' | 'expiresAt' | 'grantId'
      >;
      return {
        ...payload,
        code,
        grantId: row.grant_id,
        expiresAt: Number(row.expired_at),
        used: toBoolean(row.is_used),
      };
    },
    // Only one of two concurrent requests changes the row; the other one finds
    // the code already used and must not receive tokens.
    async consume(code) {
      const { changes } = await db.run({
        sql: 'UPDATE codes SET is_used = TRUE WHERE id = ? AND is_used = FALSE',
        params: [await hashKey(code)],
      });
      if (changes === 0) {
        throw new TokenError(TokenErrorCode.InvalidGrant, 'Authorization code has already been used');
      }
    },
    async delete(code) {
      await db.run({ sql: 'DELETE FROM codes WHERE id = ?', params: [await hashKey(code)] });
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
      const { sub, scope, clientId, expiresAt, iat, issuer, jti, grantId, ...payload } = info;
      const tokenHash = await hashKey(token);
      await db.run({
        sql:
          'INSERT INTO access_tokens (id, sub, exp, iat, iss, client_id, scope, transaction_id, ' +
          'token_hash, grant_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ' +
          // The transaction of the code the grant came from. A grant without a
          // code (the device flow, CIBA) has none.
          '(SELECT transaction_id FROM codes WHERE grant_id = ? LIMIT 1), ?, ?, ?)',
        params: [
          // A token issued without a jti is kept under its hash.
          jti ?? tokenHash,
          sub,
          expiresAt,
          iat ?? null,
          issuer ?? null,
          clientId,
          joinScope(scope),
          grantId ?? null,
          tokenHash,
          grantId ?? null,
          JSON.stringify(payload),
        ],
      });
      if (grantId !== undefined) {
        await db.run({
          sql:
            "UPDATE transactions SET status = 'token_issued' WHERE status = 'code_issued' " +
            'AND transaction_id = (SELECT transaction_id FROM codes WHERE grant_id = ? LIMIT 1)',
          params: [grantId],
        });
      }
    },
    async get(token) {
      const tokenHash = await hashKey(token);
      const [row] = await db.all<AccessTokenRow>({
        sql:
          'SELECT id, sub, exp, iat, iss, client_id, scope, grant_id, payload FROM access_tokens ' +
          'WHERE token_hash = ? AND exp > ?',
        params: [tokenHash, nowSeconds()],
      });
      if (!row) return undefined;
      const info: AccessTokenInfo = {
        ...(JSON.parse(row.payload) as Omit<AccessTokenInfo, AccessTokenColumn>),
        sub: row.sub,
        clientId: row.client_id,
        scope: splitScope(row.scope),
        expiresAt: Number(row.exp),
      };
      if (row.id !== tokenHash) info.jti = row.id;
      if (row.iat !== null) info.iat = Number(row.iat);
      if (row.iss !== null) info.issuer = row.iss;
      if (row.grant_id !== null) info.grantId = row.grant_id;
      return info;
    },
    delete: deleteAccessToken,
    revoke: deleteAccessToken,
    async revokeByGrantId(grantId) {
      await db.run({ sql: 'DELETE FROM access_tokens WHERE grant_id = ?', params: [grantId] });
    },
  };

  const deleteRefreshToken = async (token: string): Promise<void> => {
    await db.run({ sql: 'DELETE FROM refresh_tokens WHERE id = ?', params: [await hashKey(token)] });
  };

  const refreshTokenStore: RefreshTokenStorage = {
    async set(token, info) {
      const { used, expiresAt, iat, grantId, ...payload } = info;
      await db.run({
        sql:
          'INSERT INTO refresh_tokens (id, access_token_id, exp, iat, is_used, grant_id, payload) VALUES (?, ' +
          // The access token of the same token response: the token endpoint
          // stores it just before, with the same grant and iat, and no refresh
          // token links it yet.
          '(SELECT a.id FROM access_tokens a WHERE a.grant_id = ? AND a.iat = ? ' +
          'AND NOT EXISTS (SELECT 1 FROM refresh_tokens r WHERE r.access_token_id = a.id) ' +
          'ORDER BY a.id LIMIT 1), ?, ?, ' + sqlBoolean(used) + ', ?, ?)',
        params: [
          await hashKey(token),
          grantId,
          iat ?? null,
          expiresAt,
          iat ?? null,
          grantId,
          JSON.stringify(payload),
        ],
      });
    },
    async get(token) {
      const [row] = await db.all<RefreshTokenRow>({
        sql: 'SELECT exp, iat, is_used, grant_id, payload FROM refresh_tokens WHERE id = ? AND exp > ?',
        params: [await hashKey(token), nowSeconds()],
      });
      if (!row) return undefined;
      const info: RefreshTokenInfo = {
        ...(JSON.parse(row.payload) as Omit<RefreshTokenInfo, 'used' | 'expiresAt' | 'iat' | 'grantId'>),
        grantId: row.grant_id,
        expiresAt: Number(row.exp),
        used: toBoolean(row.is_used),
      };
      if (row.iat !== null) info.iat = Number(row.iat);
      return info;
    },
    // Rotation: like authCodeStore.consume, exactly one request wins.
    async consume(token) {
      const { changes } = await db.run({
        sql: 'UPDATE refresh_tokens SET is_used = TRUE WHERE id = ? AND is_used = FALSE',
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
${authTypeHelper}
  // Auth_user: the sign-in handed from /login to /consent, per transaction.
  const authSessionStore: AuthSessionStorage = {
    async set(transactionId, info) {
      await db.run({
        sql:
          'INSERT INTO auth_users (transaction_id, user_id, auth_type, auth_time, session_id) ' +
          'VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT (transaction_id) DO UPDATE SET user_id = excluded.user_id, ' +
          'auth_type = excluded.auth_type, auth_time = excluded.auth_time, session_id = excluded.session_id',
        params: [transactionId, info.subject, ${authTypeValue}, info.authTime, info.sessionId ?? null],
      });
      await db.run({
        sql:
          "UPDATE transactions SET status = 'authenticated' " +
          "WHERE transaction_id = ? AND status IN ('requested', 'upstream_pending')",
        params: [transactionId],
      });
    },
    async get(transactionId) {
      const [row] = await db.all<{ user_id: string; auth_time: number | string; session_id: string | null }>({
        sql: 'SELECT user_id, auth_time, session_id FROM auth_users WHERE transaction_id = ?',
        params: [transactionId],
      });
      if (!row) return undefined;
      const info: AuthSessionInfo = { subject: row.user_id, authTime: Number(row.auth_time) };
      if (row.session_id !== null) info.sessionId = row.session_id;
      return info;
    },
    async delete(transactionId) {
      await db.run({ sql: 'DELETE FROM auth_users WHERE transaction_id = ?', params: [transactionId] });
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
      const [row] = await db.all<{ subject: string; auth_time: number | string }>({
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
      const [row] = await db.all<{ granted: number | string }>({
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

${googleUserHelpers}
  // User: the users table. Put users there with registerUser() (users.ts).
  const userStore: UserStorage = {
    // The password form checks users.id as the username. Look the row up by
    // email instead to sign in with an email address.
    async authenticate(username, password) {
      const [row] = await db.all<UserRow & { password_hash: string | null }>({
        sql: 'SELECT email, is_verified, password_hash, claims FROM users WHERE id = ?',
        params: [username],
      });
      // verifyPassword() takes as long without a hash, so the response time does
      // not tell whether the user exists. A user without a password (such as one
      // created by Sign in with Google) cannot sign in with the form.
      const passwordHash = row?.password_hash ?? null;
      if (!(await verifyPassword(password, passwordHash)) || !row || passwordHash === null) {
        return undefined;
      }
      return { ...userClaims(username, row), password: passwordHash };
    },
    async getClaims(sub) {
      const [row] = await db.all<UserRow>({
        sql: 'SELECT email, is_verified, claims FROM users WHERE id = ?',
        params: [sub],
      });
      return row ? userClaims(sub, row) : undefined;
    },${linkGoogleAccount}
  };
${googleLoginNonceStore}
  return {
    transactionStore,
    authCodeStore,
    accessTokenStore,
    refreshTokenStore,
    authSessionStore,
    browserSessionStore,
    consentStore,
    userStore,${googleLoginNonceStoreEntry}
  };
}

/** The values of an AuthTransaction kept in transactions.payload. */
type TransactionPayload = Pick<AuthTransaction, 'csrfToken' | 'failedAttempts' | 'bindingHash'>;

/** The values of an AuthTransaction kept in authentication_requests.payload. */
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

/** The values of an AccessTokenInfo with a column of their own in access_tokens. */
type AccessTokenColumn = 'sub' | 'scope' | 'clientId' | 'expiresAt' | 'iat' | 'issuer' | 'jti' | 'grantId';

// Rows as the drivers return them: a BIGINT may come back as a string (pg) and
// a BOOLEAN as 1 / 0 (SQLite), so they are read with Number() and toBoolean().

interface TransactionRow {
  created_at: number | string;
  expired_at: number | string;
  transaction_payload: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  nonce: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  response_type: string;
  scope: string | null;
  request_payload: string;
}

interface CodeRow {
  expired_at: number | string;
  is_used: unknown;
  grant_id: string;
  payload: string;
}

interface AccessTokenRow {
  id: string;
  sub: string;
  exp: number | string;
  iat: number | string | null;
  iss: string | null;
  client_id: string;
  scope: string | null;
  grant_id: string | null;
  payload: string;
}

interface RefreshTokenRow {
  exp: number | string;
  iat: number | string | null;
  is_used: unknown;
  grant_id: string;
  payload: string;
}

interface UserRow {
  email: string | null;
  is_verified: unknown;
  claims: string | null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The claims of a users row: email and email_verified from their columns, the rest from claims. */
function userClaims(sub: string, row: UserRow): UserClaims {
  const claims: UserClaims = {
    ...(row.claims ? (JSON.parse(row.claims) as Partial<UserClaims>) : {}),
    sub,
  };
  if (row.email !== null) {
    claims.email = row.email;
    claims.email_verified = toBoolean(row.is_verified);
  }
  return claims;
}

function withoutPrefix(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/** The scope column: space-separated, NULL when there is none. */
function joinScope(scope: string[]): string | null {
  return scope.length > 0 ? scope.join(' ') : null;
}

function splitScope(scope: string | null): string[] {
  return scope ? scope.split(' ') : [];
}

/**
 * A boolean as SQL text. TRUE / FALSE work on SQLite, D1 and PostgreSQL alike,
 * while a bound number is not a BOOLEAN to every PostgreSQL driver.
 */
function sqlBoolean(value: boolean): 'TRUE' | 'FALSE' {
  return value ? 'TRUE' : 'FALSE';
}

/** A BOOLEAN column as read back: true / false from PostgreSQL, 1 / 0 from SQLite. */
function toBoolean(value: unknown): boolean {
  return value === true || Number(value) === 1;
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

/**
 * db/clients.ts: the ClientResolver on the client tables, and registerClient()
 * to fill them.
 */
export function dbClientsTemplate(corePkg: string): string {
  return `/**
 * Registered clients on the client tables of db/schema.sql: the ClientResolver
 * the OP uses when no other one is passed in, and registerClient() to put a
 * client into those tables.
 *
 * How the tables become a RegisteredClient (config.ts):
 *
 * - clients.client_type public: no client authentication ('none').
 * - client_auths and client_secrets: token_endpoint_auth_method
 *   (client_secret_basic / client_secret_post), and the clientSecretHash the
 *   presented secret is checked against. More than one row per client is a
 *   configuration error, because a client has one registered method.
 * - client_redirect_uris, client_grant_types and client_scopes: redirectUris,
 *   grantTypes and scope. A request for a scope outside scope is rejected with
 *   invalid_scope (validateClientScope() in core). A client without
 *   client_scopes rows may request every scope the OP accepts.
 * - Metadata without a column (response_types, default_max_age, jwks, the ID
 *   Token and UserInfo signing algs) keeps its default.
 */
import {
  hashClientSecret,
  type ClientResolver,
  type TokenClientResolver,
} from '${corePkg}';
import type { RegisteredClient } from '../config.js';
import type { SqlDatabase } from './database.js';

export function createSqlClientResolver(db: SqlDatabase): ClientResolver & TokenClientResolver {
  return {
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      const [client] = await db.all<{ id: string; client_type: string }>({
        sql: 'SELECT id, client_type FROM clients WHERE id = ? AND is_deleted = FALSE',
        params: [clientId],
      });
      if (!client) return null;
      const auths = await db.all<{ client_auth_type: string; secret: string | null }>({
        sql:
          'SELECT a.client_auth_type, s.secret FROM client_auths a ' +
          'LEFT JOIN client_secrets s ON s.id = a.id WHERE a.client_id = ? ORDER BY a.id',
        params: [clientId],
      });
      const redirectUris = await db.all<{ value: string }>({
        sql: 'SELECT value FROM client_redirect_uris WHERE client_id = ? ORDER BY id',
        params: [clientId],
      });
      const grantTypes = await db.all<{ grant_type: string }>({
        sql: 'SELECT grant_type FROM client_grant_types WHERE client_id = ? ORDER BY id',
        params: [clientId],
      });
      const scopes = await db.all<{ value: string }>({
        sql: 'SELECT value FROM client_scopes WHERE client_id = ? ORDER BY id',
        params: [clientId],
      });

      const registered: RegisteredClient = {
        clientId: client.id,
        clientType: client.client_type === 'public' ? 'public' : 'confidential',
        redirectUris: redirectUris.map((row) => row.value),
      };
      if (grantTypes.length > 0) registered.grantTypes = grantTypes.map((row) => row.grant_type);
      if (scopes.length > 0) registered.scope = scopes.map((row) => row.value);

      if (registered.clientType === 'public') {
        registered.tokenEndpointAuthMethod = 'none';
      } else if (auths.length > 1) {
        throw new Error('Client ' + clientId + ' has more than one row in client_auths');
      } else if (auths[0]) {
        registered.tokenEndpointAuthMethod = auths[0].client_auth_type as
          | 'client_secret_basic'
          | 'client_secret_post';
        if (auths[0].secret !== null) registered.clientSecretHash = auths[0].secret;
      }
      // A confidential client without a client_auths row keeps the default
      // client_secret_basic with no secret, so it cannot authenticate.
      return registered;
    },
  };
}

/**
 * Put a client into the client tables, replacing the rows of an earlier
 * registration with the same client_id. Call it from a setup script or at
 * startup, for example for the clients of config.ts:
 *
 *   for (const client of defaultRegisteredClients.values()) {
 *     await registerClient(db, client);
 *   }
 *
 * clientSecret is saved as its hash (hashClientSecret()). The statements run
 * one at a time (SqlDatabase has no transactions), so run it again if it stops
 * halfway.
 */
export async function registerClient(
  db: SqlDatabase,
  client: RegisteredClient & { name?: string },
): Promise<void> {
  const clientType =
    client.clientType ?? (client.tokenEndpointAuthMethod === 'none' ? 'public' : 'confidential');
  await db.run({
    sql:
      'INSERT INTO clients (id, name, client_type, is_deleted) VALUES (?, ?, ?, FALSE) ' +
      'ON CONFLICT (id) DO UPDATE SET name = excluded.name, client_type = excluded.client_type, ' +
      'is_deleted = FALSE',
    params: [client.clientId, client.name ?? null, clientType],
  });

  // Replace the child rows. Secrets go first: they reference client_auths,
  // and SQLite cascades only with foreign keys on.
  const childRows = [
    'DELETE FROM client_secrets WHERE id IN (SELECT id FROM client_auths WHERE client_id = ?)',
    'DELETE FROM client_auths WHERE client_id = ?',
    'DELETE FROM client_redirect_uris WHERE client_id = ?',
    'DELETE FROM client_grant_types WHERE client_id = ?',
    'DELETE FROM client_scopes WHERE client_id = ?',
  ];
  for (const sql of childRows) {
    await db.run({ sql, params: [client.clientId] });
  }

  const secretHash =
    client.clientSecretHash ??
    (client.clientSecret !== undefined ? await hashClientSecret(client.clientSecret) : undefined);
  const authMethod = client.tokenEndpointAuthMethod ?? 'client_secret_basic';
  if (clientType === 'confidential' && authMethod !== 'none' && secretHash !== undefined) {
    const authId = crypto.randomUUID();
    await db.run({
      sql: 'INSERT INTO client_auths (id, client_id, client_auth_type) VALUES (?, ?, ?)',
      params: [authId, client.clientId, authMethod],
    });
    await db.run({
      sql: 'INSERT INTO client_secrets (id, client_auth_type, secret) VALUES (?, ?, ?)',
      params: [authId, authMethod, secretHash],
    });
  }
  const childValues: Array<[table: string, column: string, values: readonly string[]]> = [
    ['client_redirect_uris', 'value', client.redirectUris],
    ['client_grant_types', 'grant_type', client.grantTypes ?? []],
    ['client_scopes', 'value', client.scope ?? []],
  ];
  for (const [table, column, values] of childValues) {
    for (const value of values) {
      await db.run({
        sql: 'INSERT INTO ' + table + ' (id, client_id, ' + column + ') VALUES (?, ?, ?)',
        params: [crypto.randomUUID(), client.clientId, value],
      });
    }
  }
}
`;
}

/**
 * db/users.ts: registerUser() to fill the users table, and the password
 * hashing the password form of the OP checks against.
 */
export function dbUsersTemplate(corePkg: string): string {
  return `/**
 * Users in the users table of db/schema.sql: registerUser() to put a user
 * there, and the password hashing that authenticate() (stores.ts) checks the
 * login form against.
 *
 * Passwords are hashed with PBKDF2-HMAC-SHA256 of the Web Crypto API, which
 * every runtime of the generated OP has. A stored hash records its own
 * iteration count and salt ('pbkdf2-sha256$<iterations>$<salt>$<hash>'), so
 * raising PASSWORD_HASH_ITERATIONS later keeps the existing hashes valid.
 */
import type { UserClaims } from '${corePkg}';
import type { SqlDatabase } from './database.js';

const PASSWORD_HASH_ALGORITHM = 'pbkdf2-sha256';
/**
 * OWASP recommends 600,000 iterations for PBKDF2-HMAC-SHA256, but Cloudflare
 * Workers accept at most 100,000, so the generated code uses that. Raise it
 * where the runtime allows more.
 */
const PASSWORD_HASH_ITERATIONS = 100_000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;

/**
 * Put a user into the users table, replacing an earlier registration with the
 * same id (sub). email and email_verified go to their columns, the other
 * claims to the claims column, and password (when given) is saved as its hash.
 * Without a password the user cannot use the login form of the OP.
 *
 *   await registerUser(db, { sub: 'alice', email: 'alice@example.com', email_verified: true, password: '...' });
 */
export async function registerUser(
  db: SqlDatabase,
  user: UserClaims & { password?: string },
): Promise<void> {
  const { sub, email, email_verified, password, ...otherClaims } = user;
  const now = Math.floor(Date.now() / 1000);
  await db.run({
    sql:
      'INSERT INTO users (id, email, is_verified, password_hash, created_at, updated_at, claims) ' +
      'VALUES (?, ?, ' + (email_verified === true ? 'TRUE' : 'FALSE') + ', ?, ?, ?, ?) ' +
      'ON CONFLICT (id) DO UPDATE SET email = excluded.email, is_verified = excluded.is_verified, ' +
      'password_hash = excluded.password_hash, updated_at = excluded.updated_at, claims = excluded.claims',
    params: [
      sub,
      email ?? null,
      password === undefined ? null : await hashPassword(password),
      now,
      now,
      JSON.stringify(otherClaims),
    ],
  });
}

/** The value of users.password_hash for a password, with a new random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const hash = await derivePasswordHash(password, salt, PASSWORD_HASH_ITERATIONS);
  return [PASSWORD_HASH_ALGORITHM, PASSWORD_HASH_ITERATIONS, toBase64Url(salt), toBase64Url(hash)].join('$');
}

/**
 * Whether a password matches users.password_hash. Without a hash (null, or a
 * value in another format) it still derives a key before answering false, so
 * the time taken does not tell whether the user exists or has a password.
 */
export async function verifyPassword(password: string, passwordHash: string | null): Promise<boolean> {
  const stored = passwordHash === null ? undefined : parsePasswordHash(passwordHash);
  const derived = await derivePasswordHash(
    password,
    stored?.salt ?? new Uint8Array(PASSWORD_SALT_BYTES),
    stored?.iterations ?? PASSWORD_HASH_ITERATIONS,
  );
  return stored !== undefined && constantTimeEqual(derived, stored.hash);
}

async function derivePasswordHash(password: string, salt: ArrayLike<number>, iterations: number) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations },
    key,
    PASSWORD_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function parsePasswordHash(value: string) {
  const [algorithm, iterations, salt, hash, ...rest] = value.split('$');
  const iterationCount = Number(iterations);
  if (
    algorithm !== PASSWORD_HASH_ALGORITHM ||
    rest.length > 0 ||
    !Number.isInteger(iterationCount) ||
    iterationCount < 1 ||
    !salt ||
    !hash
  ) {
    return undefined;
  }
  return { iterations: iterationCount, salt: fromBase64Url(salt), hash: fromBase64Url(hash) };
}

/** Compares in time that does not depend on where the values differ. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
`;
}

const INSTANCE_HEADER = `/**
 * The database instance: the one file in db/ that you write.
 *
 * The CLI creates this file only when it does not exist yet and never
 * overwrites it, not even with --force, so your code here survives
 * re-generation. Everything else in db/ is generated.
 *
 * createDatabase() returns a SqlDatabase (database.ts): two methods that each
 * run one SQL statement with ? placeholders. Wrap the driver or ORM of your
 * project in them; the examples at the end of this file are starting points.
 * The tables are defined in schema.sql: apply it to the database before the
 * first request, or run SCHEMA_SQL (schema.ts) at startup. The OP reads its
 * clients from the client tables, so register them there with registerClient()
 * (clients.ts) or with INSERT statements.`;

const NOT_IMPLEMENTED_ERROR = `    'db/instance.ts: createDatabase() is not implemented yet. ' +
      'Return the database the OP stores its data in (see the examples in that file).',`;

/**
 * PostgreSQL examples: pg, Prisma, Drizzle and Kysely. `parameters` is the
 * parameter list of createDatabase() for the target, so the examples keep the
 * signature the generated app calls.
 */
function postgresExamples(parameters: string): string {
  return `//
// PostgreSQL numbers its placeholders, so the pg, Prisma and Kysely examples
// turn each ? into $1, $2, ... with this helper:
//
//   const numbered = (sql: string): string => {
//     let index = 0;
//     return sql.replace(/\\?/g, () => '$' + ++index);
//   };
//
// PostgreSQL with pg (pnpm add pg):
//
//   import pg from 'pg';
//
//   const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
//
//   export function createDatabase(${parameters}): SqlDatabase {
//     return {
//       async all<Row>(statement: SqlStatement): Promise<Row[]> {
//         const result = await pool.query(numbered(statement.sql), statement.params);
//         return result.rows as Row[];
//       },
//       async run(statement: SqlStatement) {
//         const result = await pool.query(numbered(statement.sql), statement.params);
//         return { changes: result.rowCount ?? 0 };
//       },
//     };
//   }
//
// Prisma on PostgreSQL: only its raw SQL methods are used, no models (prisma
// is your PrismaClient instance):
//
//   export function createDatabase(${parameters}): SqlDatabase {
//     return {
//       all: <Row>(statement: SqlStatement) =>
//         prisma.$queryRawUnsafe<Row[]>(numbered(statement.sql), ...statement.params),
//       run: async (statement: SqlStatement) => ({
//         changes: await prisma.$executeRawUnsafe(numbered(statement.sql), ...statement.params),
//       }),
//     };
//   }
//
// Drizzle on PostgreSQL (drizzle-orm/node-postgres; db is your Drizzle
// instance). The statement is rebuilt with Drizzle's sql tag, which writes the
// placeholders of the dialect itself. Other Drizzle drivers return their own
// result shapes (on D1, use db.all() for rows and db.run() for changes):
//
//   import { sql, type SQL } from 'drizzle-orm';
//
//   const toDrizzleSql = (statement: SqlStatement): SQL => {
//     const query = sql.empty();
//     statement.sql.split('?').forEach((part, index) => {
//       if (index > 0) query.append(sql\`\${statement.params[index - 1]}\`);
//       query.append(sql.raw(part));
//     });
//     return query;
//   };
//
//   export function createDatabase(${parameters}): SqlDatabase {
//     return {
//       async all<Row>(statement: SqlStatement): Promise<Row[]> {
//         const result = await db.execute(toDrizzleSql(statement));
//         return result.rows as Row[];
//       },
//       async run(statement: SqlStatement) {
//         const result = await db.execute(toDrizzleSql(statement));
//         return { changes: result.rowCount ?? 0 };
//       },
//     };
//   }
//
// Kysely on PostgreSQL (PostgresDialect; db is your Kysely instance). With a
// SQLite dialect, pass statement.sql as it is instead of numbered(...):
//
//   import { CompiledQuery } from 'kysely';
//
//   export function createDatabase(${parameters}): SqlDatabase {
//     return {
//       async all<Row>(statement: SqlStatement): Promise<Row[]> {
//         const query = CompiledQuery.raw(numbered(statement.sql), statement.params);
//         return [...(await db.executeQuery<Row>(query)).rows];
//       },
//       async run(statement: SqlStatement) {
//         const query = CompiledQuery.raw(numbered(statement.sql), statement.params);
//         return { changes: Number((await db.executeQuery(query)).numAffectedRows ?? 0) };
//       },
//     };
//   }`;
}

/**
 * node:sqlite example. Hono calls createDatabase() for every request, so its
 * example opens the file once at module level; the other targets call it once
 * (Next.js only on the first query), so theirs opens it inside, and `next build`
 * never creates the file.
 */
function nodeSqliteExample(target: DbInstanceTarget): string {
  const open = `const sqlite = new DatabaseSync(process.env.OIDC_SQLITE_PATH ?? 'oidc.sqlite');
//   sqlite.exec(SCHEMA_SQL);`;
  const [moduleLevel, signature, insideFunction] =
    target === 'hono'
      ? [`//   ${open}\n//\n`, '_c: Context', '']
      : ['', '', `//     ${open.replace('\n//   ', '\n//     ')}\n`];
  return `//
// node:sqlite (built into Node.js 22.13+, no extra dependency):
//
//   import { DatabaseSync } from 'node:sqlite';
//   import { SCHEMA_SQL } from './schema.js';
//
${moduleLevel}//   export function createDatabase(${signature}): SqlDatabase {
${insideFunction}//     return {
//       async all<Row>(statement: SqlStatement): Promise<Row[]> {
//         return sqlite.prepare(statement.sql).all(...statement.params) as Row[];
//       },
//       async run(statement: SqlStatement) {
//         const result = sqlite.prepare(statement.sql).run(...statement.params);
//         return { changes: Number(result.changes) };
//       },
//     };
//   }`;
}

export function dbInstanceTemplate(target: DbInstanceTarget): string {
  if (target === 'hono') {
    return `${INSTANCE_HEADER}
 *
 * The generated app calls createDatabase() for every request with the Hono
 * context, so a binding such as Cloudflare D1 (c.env.DB) can be read from it.
 * Keep a connection that must outlive a request (a PostgreSQL pool, a SQLite
 * file) in a module-level variable instead of opening it here.
 */
import type { Context } from 'hono';
import type { SqlDatabase } from './database.js';

export function createDatabase(_c: Context): SqlDatabase {
  throw new Error(
${NOT_IMPLEMENTED_ERROR}
  );
}

// ---------------------------------------------------------------------------
// Examples. Replace createDatabase() above with one of them, adapted to your
// project; each needs: import type { SqlDatabase, SqlStatement } from './database.js';
//
// Cloudflare D1 (apply schema.sql with wrangler d1 migrations):
//
//   export function createDatabase(c: Context): SqlDatabase {
//     const d1 = c.env.DB as D1Database;
//     return {
//       async all<Row>(statement: SqlStatement): Promise<Row[]> {
//         const result = await d1.prepare(statement.sql).bind(...statement.params).all<Row>();
//         return result.results;
//       },
//       async run(statement: SqlStatement) {
//         const result = await d1.prepare(statement.sql).bind(...statement.params).run();
//         return { changes: result.meta.changes };
//       },
//     };
//   }
${nodeSqliteExample('hono')}
${postgresExamples('_c: Context')}
`;
  }
  const nextJsNote =
    target === 'nextjs'
      ? `
 *
 * provider.ts calls createDatabase() on the first query, not at import, so
 * \`next build\` does not need the database as long as this module does not
 * connect when it is imported (a pg Pool or a PrismaClient connects on its first
 * query). Next.js loads provider.ts once per module layer (Route Handlers,
 * Server Actions), so keep a pool or client on globalThis when the database
 * limits its connections.`
      : `
 *
 * The generated app calls createDatabase() once, when the app is created, so a
 * missing implementation stops the server at startup.`;
  return `${INSTANCE_HEADER}${nextJsNote}
 */
import type { SqlDatabase } from './database.js';

export function createDatabase(): SqlDatabase {
  throw new Error(
${NOT_IMPLEMENTED_ERROR}
  );
}

// ---------------------------------------------------------------------------
// Examples. Replace createDatabase() above with one of them, adapted to your
// project; each needs: import type { SqlDatabase, SqlStatement } from './database.js';
${nodeSqliteExample(target)}
${postgresExamples('')}
`;
}
