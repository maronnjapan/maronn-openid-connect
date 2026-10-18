/**
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
 * (clients.ts) or with INSERT statements.
 *
 * The generated app calls createDatabase() whenever it reads or writes. Keep
 * the connection (a PostgreSQL pool, a SQLite file) on globalThis instead of
 * opening it here: Next.js loads this module once per module layer (Route
 * Handlers, Server Actions, instrumentation.ts), and all of them have to use
 * the same database.
 */
import type { SqlDatabase } from './database';

export function createDatabase(): SqlDatabase {
  throw new Error(
    'db/instance.ts: createDatabase() is not implemented yet. ' +
      'Return the database the OP stores its data in (see the examples in that file).',
  );
}

// ---------------------------------------------------------------------------
// Examples. Replace createDatabase() above with one of them, adapted to your
// project; each needs: import type { SqlDatabase, SqlStatement } from './database';
//
// node:sqlite (built into Node.js 22.13+, no extra dependency):
//
//   import { DatabaseSync } from 'node:sqlite';
//   import { SCHEMA_SQL } from './schema';
//
//   const registry = globalThis as typeof globalThis & { __oidcSqlite?: DatabaseSync };
//   const sqlite = (registry.__oidcSqlite ??= new DatabaseSync(process.env.OIDC_SQLITE_PATH ?? 'oidc.sqlite'));
//   sqlite.exec(SCHEMA_SQL);
//
//   export function createDatabase(): SqlDatabase {
//     return {
//       async all<Row>(statement: SqlStatement): Promise<Row[]> {
//         return sqlite.prepare(statement.sql).all(...statement.params) as Row[];
//       },
//       async run(statement: SqlStatement) {
//         const result = sqlite.prepare(statement.sql).run(...statement.params);
//         return { changes: Number(result.changes) };
//       },
//     };
//   }
//
// PostgreSQL numbers its placeholders, so the pg, Prisma and Kysely examples
// turn each ? into $1, $2, ... with this helper:
//
//   const numbered = (sql: string): string => {
//     let index = 0;
//     return sql.replace(/\?/g, () => '$' + ++index);
//   };
//
// PostgreSQL with pg (pnpm add pg):
//
//   import pg from 'pg';
//
//   const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
//
//   export function createDatabase(): SqlDatabase {
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
//   export function createDatabase(): SqlDatabase {
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
//       if (index > 0) query.append(sql`${statement.params[index - 1]}`);
//       query.append(sql.raw(part));
//     });
//     return query;
//   };
//
//   export function createDatabase(): SqlDatabase {
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
//   export function createDatabase(): SqlDatabase {
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
//   }
