/**
 * The statements of db/schema.sql, for databases that are set up at startup
 * (for example node:sqlite: database.exec(SCHEMA_SQL)). Every statement is
 * CREATE ... IF NOT EXISTS, so running it again is harmless.
 */
export const SCHEMA_SQL = `-- Tables of the generated OpenID Provider (db/stores.ts).
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
`;
