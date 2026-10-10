/**
 * The database instance of this sample: the one file in db/ that the CLI
 * leaves to the project (it is created once and never regenerated).
 *
 * Node.js's built-in node:sqlite keeps the OP's data in the file that
 * OIDC_SQLITE_PATH names (.data/oidc.sqlite by default), so no database
 * server, native add-on or extra dependency is needed (Node.js 22.13+). The
 * tables of schema.sql are created at startup.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlStatement } from './database.js';
import { SCHEMA_SQL } from './schema.js';

export function createDatabase(): SqlDatabase {
  const databasePath = resolve(process.env.OIDC_SQLITE_PATH ?? '.data/oidc.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });
  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec(SCHEMA_SQL);
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
