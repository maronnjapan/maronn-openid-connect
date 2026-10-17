/**
 * The database instance of this sample: the one file in db/ that the CLI
 * leaves to the project (it is created once and never regenerated).
 *
 * Node.js's built-in node:sqlite keeps the OP's data in the file that
 * OIDC_SQLITE_PATH names (.data/oidc.sqlite by default), so no database
 * server, native add-on or extra dependency is needed (Node.js 22.13+). The
 * tables of schema.sql are created at startup.
 *
 * The database is opened once and shared: app.ts registers the sample clients
 * through the same connection the generated app reads them from, which also
 * keeps OIDC_SQLITE_PATH=:memory: working.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlStatement } from './database.js';
import { SCHEMA_SQL } from './schema.js';

let database: SqlDatabase | undefined;

export function createDatabase(): SqlDatabase {
  database ??= openDatabase();
  return database;
}

function openDatabase(): SqlDatabase {
  const databasePath = process.env.OIDC_SQLITE_PATH ?? '.data/oidc.sqlite';
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  }
  const sqlite = new DatabaseSync(databasePath === ':memory:' ? databasePath : resolve(databasePath));
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec(SCHEMA_SQL);
  addAccessTokenAcrColumn(sqlite);
  allowPrivateKeyJwtClientAuth(sqlite);
  return {
    async all<Row>(statement: SqlStatement): Promise<Row[]> {
      return sqlite.prepare(statement.sql).all(...statement.params) as Row[];
    },
    async run(statement: SqlStatement) {
      const result = sqlite.prepare(statement.sql).run(...statement.params);
      return { changes: Number(result.changes) };
    },
  };
}

/**
 * Adds access_tokens.acr to a database created before the column was part of
 * schema.sql (a Fly.io volume, an existing .data/oidc.sqlite): CREATE TABLE IF
 * NOT EXISTS leaves an existing table as it is.
 */
function addAccessTokenAcrColumn(sqlite: DatabaseSync): void {
  const columns = sqlite.prepare('PRAGMA table_info(access_tokens)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'acr')) {
    sqlite.exec('ALTER TABLE access_tokens ADD COLUMN acr VARCHAR(5000)');
  }
}

/**
 * Lets client_auths hold the private_key_jwt rows of a database created before
 * that method was part of schema.sql (a Fly.io volume, an existing
 * .data/oidc.sqlite). CREATE TABLE IF NOT EXISTS leaves the table with its old
 * CHECK, and SQLite changes a CHECK only by rebuilding the table. Foreign keys
 * are off while it is rebuilt, so dropping the old table does not delete the
 * client_secrets rows that reference it.
 */
function allowPrivateKeyJwtClientAuth(sqlite: DatabaseSync): void {
  const table = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'client_auths'")
    .get() as { sql: string } | undefined;
  if (!table || table.sql.includes('private_key_jwt')) return;
  sqlite.exec('PRAGMA foreign_keys = OFF');
  try {
    sqlite.exec(`BEGIN;
CREATE TABLE client_auths_rebuilt (
  id               TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  client_auth_type VARCHAR(1000) NOT NULL
    CHECK (client_auth_type IN ('client_secret_basic', 'client_secret_post', 'private_key_jwt')),
  UNIQUE (id, client_auth_type)
);
INSERT INTO client_auths_rebuilt (id, client_id, client_auth_type)
  SELECT id, client_id, client_auth_type FROM client_auths;
DROP TABLE client_auths;
ALTER TABLE client_auths_rebuilt RENAME TO client_auths;
CREATE INDEX IF NOT EXISTS client_auths_client_id_idx ON client_auths (client_id);
COMMIT;`);
  } finally {
    sqlite.exec('PRAGMA foreign_keys = ON');
  }
}
