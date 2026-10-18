/**
 * Databases for the tests of db/sql and db/kv, built in the test process:
 *
 * - createSqliteDatabase(): SQLite in memory (node:sqlite) with the tables of
 *   SCHEMA_SQL, behind the SqlDatabase contract (db/sql/database.ts).
 * - createMapKvDatabase(): a Map behind the KvDatabase contract
 *   (db/kv/database.ts), with its TTLs and its atomic setIfAbsent.
 */
import { DatabaseSync } from 'node:sqlite';
import type { KvDatabase } from '../oidc-provider/db/kv/database.js';
import type { SqlDatabase, SqlStatement } from '../oidc-provider/db/sql/database.js';
import { SCHEMA_SQL } from '../oidc-provider/db/sql/schema.js';

/**
 * A new SQLite database in memory with the tables of schema.sql. node:sqlite
 * turns foreign keys on, as D1 does, so the foreign keys of schema.sql hold.
 */
export function createSqliteDatabase(): SqlDatabase {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA_SQL);
  return {
    async all<Row>(statement: SqlStatement): Promise<Row[]> {
      return sqlite.prepare(statement.sql).all(...statement.params) as Row[];
    },
    async run(statement: SqlStatement): Promise<{ changes: number }> {
      const result = sqlite.prepare(statement.sql).run(...statement.params);
      return { changes: Number(result.changes) };
    },
  };
}

/** A KvDatabase on a Map, which also lists what it holds. */
export interface MapKvDatabase extends KvDatabase {
  /** The keys that have not expired and their values, in the order the keys were first written. */
  entries(): Array<[key: string, value: string]>;
}

/**
 * A KvDatabase on a Map that keeps the contract of database.ts:
 *
 * - a key past its TTL reads as missing, and one written without a TTL never
 *   expires (the clock is Date.now(), so vi.setSystemTime() moves it);
 * - ttlSeconds must be a whole number of seconds, 1 or more, and every value
 *   JSON text: anything else throws, as a store would reject it;
 * - setIfAbsent checks and stores in one synchronous step, so of concurrent
 *   calls for one key exactly one returns true.
 */
export function createMapKvDatabase(): MapKvDatabase {
  const records = new Map<string, { value: string; expiresAt: number | undefined }>();

  const live = (key: string) => {
    const record = records.get(key);
    if (record?.expiresAt !== undefined && Date.now() >= record.expiresAt) {
      records.delete(key);
      return undefined;
    }
    return record;
  };

  const recordOf = (value: string, ttlSeconds: number | undefined) => {
    if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds < 1)) {
      throw new RangeError(`ttlSeconds must be a whole number of seconds, 1 or more: ${ttlSeconds}`);
    }
    JSON.parse(value);
    return { value, expiresAt: ttlSeconds === undefined ? undefined : Date.now() + ttlSeconds * 1000 };
  };

  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ttlSeconds) {
      records.set(key, recordOf(value, ttlSeconds));
    },
    async setIfAbsent(key, value, ttlSeconds) {
      const record = recordOf(value, ttlSeconds);
      if (live(key) !== undefined) return false;
      records.set(key, record);
      return true;
    },
    async delete(key) {
      records.delete(key);
    },
    entries() {
      return [...records.keys()].flatMap((key): Array<[string, string]> => {
        const record = live(key);
        return record === undefined ? [] : [[key, record.value]];
      });
    },
  };
}
