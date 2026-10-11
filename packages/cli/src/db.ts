/**
 * --db: where the generated OP keeps its data. Either kind generates db/, in
 * which the user writes only db/instance.ts.
 *
 * - sql: SQL tables (SQLite, Cloudflare D1, PostgreSQL) through any driver or ORM
 * - kv: a key-value store (Redis, Upstash, Valkey, ...) through four methods
 */
export type DbKind = 'sql' | 'kv';

export const DB_KINDS: readonly DbKind[] = ['sql', 'kv'];

const DB_KINDS_HINT = '--db sql (SQL tables) or --db kv (a key-value store)';

/**
 * The kind of the --db flag: undefined without the flag, null when the flag
 * came without a kind, or the word that followed it.
 */
export function resolveDbKind(value: string | null | undefined): DbKind | undefined {
  if (value === undefined) return undefined;
  if (value === null) {
    throw new Error(`--db needs a kind: ${DB_KINDS_HINT}`);
  }
  if (!isDbKind(value)) {
    throw new Error(`Unknown --db kind: "${value}". Use ${DB_KINDS_HINT}`);
  }
  return value;
}

function isDbKind(value: string): value is DbKind {
  return (DB_KINDS as readonly string[]).includes(value);
}
