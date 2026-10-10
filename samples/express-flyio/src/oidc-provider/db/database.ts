/**
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
