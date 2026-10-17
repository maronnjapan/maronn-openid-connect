/**
 * The database instance of this sample: the one file in db/ that the CLI
 * leaves to the project (it is created once and never regenerated).
 *
 * The OP keeps its data in Cloudflare D1, through the DB binding of
 * wrangler.jsonc. Wrangler emulates D1 locally (in .wrangler/state, or the
 * directory OIDC_D1_PERSIST_PATH names), so no database server is needed.
 *
 * The tables of schema.sql are created by the first query of each isolate.
 * Every statement there is CREATE ... IF NOT EXISTS, so running them again on
 * an existing database changes nothing.
 */
import type { Context } from 'hono';
import type { SqlDatabase, SqlStatement } from './database.js';
import { SCHEMA_SQL } from './schema.js';

export function createDatabase(c: Context): SqlDatabase {
  return d1Database(c.env.DB as D1Database);
}

/**
 * A SqlDatabase on a D1 binding. app.ts also uses it with the binding of
 * `env` (cloudflare:workers), for what it sets up outside the generated app.
 */
export function d1Database(d1: D1Database): SqlDatabase {
  return {
    async all<Row>(statement: SqlStatement): Promise<Row[]> {
      await applySchema(d1);
      const result = await d1.prepare(statement.sql).bind(...statement.params).all<Row>();
      return result.results;
    },
    async run(statement: SqlStatement) {
      await applySchema(d1);
      const result = await d1.prepare(statement.sql).bind(...statement.params).run();
      return { changes: result.meta.changes };
    },
  };
}

let schemaApplied = false;

/**
 * Runs the statements of schema.sql as one batch. D1's exec() takes one
 * statement per line, which the multi-line CREATE TABLE statements are not,
 * so the comments are dropped and the rest is split at each semicolon.
 */
async function applySchema(d1: D1Database): Promise<void> {
  if (schemaApplied) return;
  const statements = SCHEMA_SQL.split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0);
  await d1.batch(statements.map((sql) => d1.prepare(sql)));
  await addAccessTokenAcrColumn(d1);
  await allowPrivateKeyJwtClientAuth(d1);
  schemaApplied = true;
}

/**
 * Adds access_tokens.acr to a database created before the column was part of
 * schema.sql (the deployed D1 database, an existing .wrangler/state): CREATE
 * TABLE IF NOT EXISTS leaves an existing table as it is.
 */
async function addAccessTokenAcrColumn(d1: D1Database): Promise<void> {
  const hasAcrColumn = async (): Promise<boolean> => {
    const { results } = await d1.prepare('PRAGMA table_info(access_tokens)').all<{ name: string }>();
    return results.some((column) => column.name === 'acr');
  };
  if (await hasAcrColumn()) return;
  try {
    await d1.prepare('ALTER TABLE access_tokens ADD COLUMN acr VARCHAR(5000)').run();
  } catch (error) {
    // Another isolate added the column first.
    if (!(await hasAcrColumn())) throw error;
  }
}

/**
 * Lets client_auths hold the private_key_jwt rows of a database created before
 * that method was part of schema.sql (the deployed D1 database, an existing
 * .wrangler/state). CREATE TABLE IF NOT EXISTS leaves the table with its old
 * CHECK, and SQLite changes a CHECK only by rebuilding the table.
 *
 * D1 keeps foreign keys on, so dropping the old table deletes the
 * client_secrets rows that reference it (ON DELETE CASCADE): they are kept
 * aside and put back in the same batch, which D1 runs as one transaction.
 * defer_foreign_keys lets the rows wait for the rebuilt table until the end of
 * that transaction.
 */
async function allowPrivateKeyJwtClientAuth(d1: D1Database): Promise<void> {
  const allowsPrivateKeyJwt = async (): Promise<boolean> => {
    const table = await d1
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'client_auths'")
      .first<{ sql: string }>();
    return table === null || table.sql.includes('private_key_jwt');
  };
  if (await allowsPrivateKeyJwt()) return;
  try {
    await d1.batch([
      d1.prepare('PRAGMA defer_foreign_keys = true'),
      d1.prepare('CREATE TABLE client_secrets_kept AS SELECT id, client_auth_type, secret FROM client_secrets'),
      d1.prepare(`CREATE TABLE client_auths_rebuilt (
  id               TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  client_auth_type VARCHAR(1000) NOT NULL
    CHECK (client_auth_type IN ('client_secret_basic', 'client_secret_post', 'private_key_jwt')),
  UNIQUE (id, client_auth_type)
)`),
      d1.prepare(
        'INSERT INTO client_auths_rebuilt (id, client_id, client_auth_type) ' +
          'SELECT id, client_id, client_auth_type FROM client_auths',
      ),
      d1.prepare('DROP TABLE client_auths'),
      d1.prepare('ALTER TABLE client_auths_rebuilt RENAME TO client_auths'),
      d1.prepare('CREATE INDEX IF NOT EXISTS client_auths_client_id_idx ON client_auths (client_id)'),
      d1.prepare(
        'INSERT OR IGNORE INTO client_secrets (id, client_auth_type, secret) ' +
          'SELECT id, client_auth_type, secret FROM client_secrets_kept',
      ),
      d1.prepare('DROP TABLE client_secrets_kept'),
    ]);
  } catch (error) {
    // Another isolate rebuilt the table first.
    if (!(await allowsPrivateKeyJwt())) throw error;
  }
}
