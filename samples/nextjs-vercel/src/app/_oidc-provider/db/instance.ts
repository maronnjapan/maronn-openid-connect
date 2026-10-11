/**
 * The database instance of this sample: the one file in db/ that the CLI
 * leaves to the project (it is created once and never regenerated).
 *
 * Locally the OP keeps its data with Node.js's built-in node:sqlite, in the
 * file OIDC_SQLITE_PATH names (.data/oidc.sqlite by default), so no database
 * server, native add-on or extra dependency is needed (Node.js 22.13+).
 *
 * Vercel Functions share no file system, so there the OP uses Turso (libSQL, a
 * database that speaks SQLite) over its HTTP API, with fetch alone, when
 * TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are set. On Vercel without them the
 * first query fails instead of writing to a file no other function reads.
 *
 * Both create the tables of schema.sql before their first query. Every
 * statement there is CREATE ... IF NOT EXISTS, so running them again on an
 * existing database changes nothing.
 *
 * The database is kept on globalThis: Next.js loads this module once per
 * module layer (Route Handlers, Server Actions, instrumentation.ts), and all
 * of them have to use the same database, OIDC_SQLITE_PATH=:memory: included.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlStatement, SqlValue } from './database';
import { SCHEMA_SQL } from './schema';

const registry = globalThis as typeof globalThis & { __oidcSampleDatabase?: SqlDatabase };

export function createDatabase(): SqlDatabase {
  return (registry.__oidcSampleDatabase ??= openDatabase());
}

function openDatabase(): SqlDatabase {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;
  if (tursoUrl && tursoToken) {
    return openTurso(tursoUrl, tursoToken);
  }
  if (process.env.VERCEL) {
    throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required on Vercel');
  }
  return openSqlite(process.env.OIDC_SQLITE_PATH ?? '.data/oidc.sqlite');
}

function openSqlite(path: string): SqlDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const sqlite = new DatabaseSync(path === ':memory:' ? path : resolve(path));
  // Processes that open the same file at once (next build workers, a running
  // next start) wait for its lock instead of failing with "database is locked".
  sqlite.exec('PRAGMA busy_timeout = 5000');
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

/**
 * Turso over its HTTP API (https://docs.turso.tech/sdk/http/reference): each
 * statement is one POST to /v2/pipeline. The libsql:// URL that Turso shows
 * is served over HTTPS at the same host.
 */
function openTurso(databaseUrl: string, authToken: string): SqlDatabase {
  const endpoint = new URL('/v2/pipeline', databaseUrl.replace(/^libsql:/, 'https:'));

  const send = async (request: TursoRequest): Promise<TursoResult | undefined> => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requests: [request, { type: 'close' }] }),
    });
    if (!response.ok) {
      throw new Error(`Turso answered ${response.status}: ${await response.text()}`);
    }
    const { results } = (await response.json()) as { results: TursoStreamResult[] };
    const [result] = results;
    if (result.type === 'error') {
      throw new Error(`Turso: ${result.error.message}`);
    }
    return result.response.result;
  };

  let schemaApplied: Promise<unknown> | undefined;
  const execute = async (statement: SqlStatement): Promise<TursoResult> => {
    schemaApplied ??= send({ type: 'sequence', sql: SCHEMA_SQL }).catch((error: unknown) => {
      schemaApplied = undefined;
      throw error;
    });
    await schemaApplied;
    const result = await send({
      type: 'execute',
      stmt: { sql: statement.sql, args: statement.params.map(toTursoValue) },
    });
    if (!result) {
      throw new Error('Turso returned no result for a statement');
    }
    return result;
  };

  return {
    async all<Row>(statement: SqlStatement): Promise<Row[]> {
      const { cols, rows } = await execute(statement);
      return rows.map(
        (row) =>
          Object.fromEntries(cols.map((col, index) => [col.name, fromTursoValue(row[index])])) as Row,
      );
    },
    async run(statement: SqlStatement) {
      const { affected_row_count } = await execute(statement);
      return { changes: affected_row_count };
    },
  };
}

type TursoValue =
  | { type: 'null' }
  | { type: 'integer'; value: string }
  | { type: 'float'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; base64: string };

type TursoRequest =
  | { type: 'execute'; stmt: { sql: string; args: TursoValue[] } }
  | { type: 'sequence'; sql: string };

interface TursoResult {
  cols: Array<{ name: string }>;
  rows: TursoValue[][];
  affected_row_count: number;
}

type TursoStreamResult =
  | { type: 'ok'; response: { type: string; result?: TursoResult } }
  | { type: 'error'; error: { message: string } };

function toTursoValue(value: SqlValue): TursoValue {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'text', value };
  return Number.isInteger(value)
    ? { type: 'integer', value: String(value) }
    : { type: 'float', value };
}

/** A value the way node:sqlite returns it: integers (and so booleans, 1 / 0) as numbers. */
function fromTursoValue(value: TursoValue): unknown {
  if (value.type === 'null') return null;
  if (value.type === 'integer') return Number(value.value);
  if (value.type === 'blob') return value.base64;
  return value.value;
}
