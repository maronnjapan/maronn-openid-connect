/**
 * Templates for the db/ directory generated with --db.
 *
 * The generated OP keeps its data in SQL tables instead of the in-memory or
 * JSON key/value stores. Everything in db/ is generated except instance.ts:
 * that file creates the database instance, so it is written by the user,
 * created only when it does not exist yet, and never overwritten.
 *
 * The SQL is written once for every supported database: it only uses what
 * SQLite, Cloudflare D1 and PostgreSQL share (? placeholders, ON CONFLICT,
 * RETURNING, BIGINT), and every value bound to it is a string, a number or null.
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
  ];
}

export function dbDatabaseTemplate(): string {
  return `/**
 * The database contract of the generated OP (--db).
 *
 * db/stores.ts runs every query through these two methods, and db/instance.ts
 * creates the object that implements them for your database. Any driver or ORM
 * can implement them, because every one of them can run raw SQL.
 *
 * - Values are bound with ? placeholders, in order. An adapter for a driver
 *   that numbers its placeholders (PostgreSQL: $1, $2, ...) rewrites each ?
 *   into the next number; the generated SQL never has a ? inside a literal.
 * - Bound values are only strings, numbers and null: booleans are 0 / 1, times
 *   are epoch seconds and objects are JSON text, so every driver binds them the
 *   same way.
 * - There is no transaction API. Each store operation is a single statement,
 *   and the database applies a statement's condition and its change together.
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
 */
export function dbSchemaSql(features: OidcFeatureConfig = DEFAULT_FEATURES): string {
  const googleLoginTables = features.googleLogin
    ? `
-- EXTENSION (google-login): binds a "Sign in with Google" click to the
-- authorization transaction it started from.
CREATE TABLE IF NOT EXISTS google_login_nonces (
  id         TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL,
  payload    TEXT NOT NULL
);

-- EXTENSION (google-login): users provisioned from a verified Google account.
CREATE TABLE IF NOT EXISTS google_users (
  sub    TEXT PRIMARY KEY,
  claims TEXT NOT NULL
);
`
    : '';
  return `-- Tables of the generated OpenID Provider (db/stores.ts).
--
-- The same statements run on SQLite, Cloudflare D1 and PostgreSQL. Times are
-- epoch seconds and booleans are 0 / 1. Only the values a query looks up or
-- updates by are columns, and the rest of each record is JSON in payload, so a
-- new optional field in the core types needs no migration. Codes and tokens
-- are stored as their SHA-256 hash, never as the value itself.
--
-- Expired rows are not deleted by the OP. Remove them on a schedule if needed,
-- e.g. DELETE FROM access_tokens WHERE expires_at <= <now in epoch seconds>.

-- Authorization requests in progress (/authorize -> /login -> /consent).
CREATE TABLE IF NOT EXISTS auth_transactions (
  id         TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL,
  payload    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS authorization_codes (
  code_hash  TEXT PRIMARY KEY,
  grant_id   TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL,
  payload    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id   TEXT,
  client_id  TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS access_tokens_grant_id_idx ON access_tokens (grant_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id   TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refresh_tokens_grant_id_idx ON refresh_tokens (grant_id);

-- The login result handed from /login to /consent, per authorization transaction.
CREATE TABLE IF NOT EXISTS auth_sessions (
  transaction_id TEXT PRIMARY KEY,
  payload        TEXT NOT NULL
);

-- OP browser sessions (the session_id cookie): SSO, prompt=none and max_age.
CREATE TABLE IF NOT EXISTS browser_sessions (
  session_id TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  auth_time  BIGINT NOT NULL
);

-- Granted scopes, one row per scope.
CREATE TABLE IF NOT EXISTS consent_scopes (
  subject   TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope     TEXT NOT NULL,
  PRIMARY KEY (subject, client_id, scope)
);

-- The grants issued under a consent, so revoking the consent revokes their tokens.
CREATE TABLE IF NOT EXISTS consent_grants (
  subject   TEXT NOT NULL,
  client_id TEXT NOT NULL,
  grant_id  TEXT NOT NULL,
  PRIMARY KEY (subject, client_id, grant_id)
);
${googleLoginTables}`;
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
  const googleCoreTypeImport = features.googleLogin ? '\n  type UserClaims,' : '';
  const googleStoreImport = features.googleLogin ? '\n  googleAccountToClaims,' : '';
  const userStorageTypeImport = features.googleLogin ? '\n  type UserStorage,' : '';
  const googleLoginTypeImport = features.googleLogin
    ? `
import type { GoogleLoginNonceRecord, GoogleLoginNonceStore } from '${GOOGLE_LOGIN_PACKAGE}';`
    : '';
  const usersComment = features.googleLogin
    ? `// Password users are the fixed development users of store.ts (testuser /
// otheruser). Users provisioned by "Sign in with Google" are stored in the
// google_users table. Connect your own user table here: authenticate() checks
// a login, getClaims() returns the claims of a subject.`
    : `// Password users are the fixed development users of store.ts (testuser /
// otheruser). Connect your own user table here: authenticate() checks a login,
// getClaims() returns the claims of a subject.`;
  const userStore = features.googleLogin
    ? `  const userStore: UserStorage = {
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

`
    : '';
  const userStoreEntry = features.googleLogin ? '    userStore,\n    googleLoginNonceStore,' : '    userStore: fixedUsers,';
  return `/**
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
  type RefreshTokenInfo,${googleCoreTypeImport}
} from '${corePkg}';${googleLoginTypeImport}
import {
  UserStore,${googleStoreImport}
  type AccessTokenStorage,
  type AuthSessionInfo,
  type AuthSessionStorage,
  type AuthorizationCodeStorage,
  type BrowserSessionStorage,
  type ConsentStorage,
  type ProviderStores,
  type RefreshTokenStorage,${userStorageTypeImport}
} from '../store.js';
import type { SqlDatabase } from './database.js';

${usersComment}
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

${userStore}  return {
    transactionStore,
    authCodeStore,
    accessTokenStore,
    refreshTokenStore,
    authSessionStore,
    browserSessionStore,
    consentStore,
${userStoreEntry}
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
  return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
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
 * first request, or run SCHEMA_SQL (schema.ts) at startup.`;

const NOT_IMPLEMENTED_ERROR = `    'db/instance.ts: createDatabase() is not implemented yet. ' +
      'Return the database the OP stores its data in (see the examples in that file).',`;

/**
 * PostgreSQL (pg) and Prisma examples. `parameters` is the parameter list of
 * createDatabase() for the target, so the examples keep the signature the
 * generated app calls.
 */
function postgresExamples(parameters: string): string {
  return `//
// PostgreSQL numbers its placeholders, so the next two examples turn each ?
// into $1, $2, ... with this helper:
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
// Drizzle: db.$client is the driver Drizzle runs on (a pg Pool, a D1 binding,
// ...), so wrap it as in the matching example.`;
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
