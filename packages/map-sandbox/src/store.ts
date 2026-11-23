/**
 * What a request on the OP of the map reads and writes of the OP's memory
 * database (apps/hono db/memory/database.ts): the records it looks up, found
 * or not, the collections it goes through whole, and the records it adds,
 * changes or removes. The reads are seen as they happen, through Maps that
 * note them (watchDatabase); the writes by comparing the records before the
 * request with those after it (changesBetween), since a store changes a
 * record in place too (consume sets `used` on the record it holds). Only the
 * records of the database are seen: a feature that keeps its records apart
 * from it (PAR, device codes, CIBA, a registered client) is not.
 *
 * The reads are noted at the Maps of the database, not at the stores of the
 * OP (store.ts ProviderStores): every part of the OP that reads a record
 * reads it there, the client resolver and the user store included, while
 * the stores are only some of them, and a record read is what the reader
 * looks for, not the method that read it (the map shows the method).
 */
import type { MemoryDatabase } from '../../../apps/hono/src/oidc-provider/db/memory/database.js';
import type { PlainDatabase, StoreAccess, StoreChange, StoreRead } from './api.js';

/** The reads of a request as it runs: the first of each record or collection, in order, and the keys the request wrote itself, whose reads are its own. */
interface ReadLog {
  reads: StoreRead[];
  seen: Set<string>;
  written: Set<string>;
}

/** The key a record is noted by in a read log: its collection and its key, or the collection alone for a walk over all of it. */
function logKey(collection: string, key: string | undefined): string {
  return key === undefined ? `${collection}\n*` : `${collection}\n${key}`;
}

/** Note a read of a record (or, without a key, of the whole collection), unless one of it was noted already or the request wrote it itself. */
function noteRead(log: ReadLog, collection: string, key: string | undefined, found: boolean): void {
  const noted = logKey(collection, key);
  if (log.seen.has(noted) || (key !== undefined && log.written.has(noted))) return;
  log.seen.add(noted);
  log.reads.push({ collection, ...(key === undefined ? {} : { key }), found });
}

/** A Map of the database that notes in a read log the records read from it, and the keys written to it. */
class WatchedMap<K, V> extends Map<K, V> {
  readonly #collection: string;
  readonly #log: ReadLog;

  constructor(collection: string, log: ReadLog, entries: Map<K, V>) {
    super();
    this.#collection = collection;
    this.#log = log;
    for (const [key, value] of entries) super.set(key, value);
  }

  override get(key: K): V | undefined {
    noteRead(this.#log, this.#collection, String(key), super.has(key));
    return super.get(key);
  }

  override has(key: K): boolean {
    noteRead(this.#log, this.#collection, String(key), super.has(key));
    return super.has(key);
  }

  override set(key: K, value: V): this {
    this.#log.written.add(logKey(this.#collection, String(key)));
    return super.set(key, value);
  }

  override delete(key: K): boolean {
    this.#log.written.add(logKey(this.#collection, String(key)));
    return super.delete(key);
  }

  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    noteRead(this.#log, this.#collection, undefined, this.size > 0);
    super.forEach(callback, thisArg);
  }

  override entries(): MapIterator<[K, V]> {
    noteRead(this.#log, this.#collection, undefined, this.size > 0);
    return super.entries();
  }

  override keys(): MapIterator<K> {
    noteRead(this.#log, this.#collection, undefined, this.size > 0);
    return super.keys();
  }

  override values(): MapIterator<V> {
    noteRead(this.#log, this.#collection, undefined, this.size > 0);
    return super.values();
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

/**
 * Put Maps that note what is read into a database, in place of its own,
 * holding the same records, and return the reads they note: the first read
 * of each record (its collection and key, and whether the database held it)
 * or of each collection walked whole, in the order read, but the reads of a
 * record the request wrote before it read it, which are its own.
 */
export function watchDatabase(db: MemoryDatabase): StoreRead[] {
  const log: ReadLog = { reads: [], seen: new Set(), written: new Set() };
  const collections = db as unknown as Record<string, unknown>;
  for (const [collection, records] of Object.entries(collections)) {
    if (records instanceof Map) collections[collection] = new WatchedMap(collection, log, records);
  }
  return log.reads;
}

/** A value as plain JSON: a Map as an object of its entries by key, a Set as an array of its members, an object and an array member by member. */
export function plainOf(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries([...Map.prototype.entries.call(value)].map(([key, member]) => [String(key), plainOf(member)]));
  if (value instanceof Set) return [...value].map(plainOf);
  if (Array.isArray(value)) return value.map(plainOf);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, plainOf(member)]));
  return value;
}

/** The records of a database as plain JSON, by collection and key (plainOf). The reads of a watched database are not noted. */
export function plainDatabase(db: MemoryDatabase): PlainDatabase {
  const plain: PlainDatabase = {};
  for (const [collection, records] of Object.entries(db as unknown as Record<string, unknown>)) {
    if (records instanceof Map) plain[collection] = plainOf(records) as Record<string, unknown>;
  }
  return plain;
}

/** The top-level fields of two records whose values differ. */
function changedFields(before: unknown, after: unknown): string[] {
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => JSON.stringify((before as Record<string, unknown>)[name]) !== JSON.stringify((after as Record<string, unknown>)[name]));
}

/**
 * The records a request added, changed or removed: those of the database
 * after it that it did not hold before, or held with another value, and
 * those it held before and does not hold after, by collection in the order
 * of the database, then by key in the order of the records. A changed
 * record names the fields whose values changed.
 */
export function changesBetween(before: PlainDatabase, after: PlainDatabase): StoreChange[] {
  const changes: StoreChange[] = [];
  for (const collection of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[collection] ?? {};
    const is = after[collection] ?? {};
    for (const key of new Set([...Object.keys(was), ...Object.keys(is)])) {
      if (!(key in is)) changes.push({ collection, key, change: 'removed', before: was[key] });
      else if (!(key in was)) changes.push({ collection, key, change: 'added', value: is[key] });
      else if (JSON.stringify(was[key]) !== JSON.stringify(is[key])) changes.push({ collection, key, change: 'changed', value: is[key], before: was[key], fields: changedFields(was[key], is[key]) });
    }
  }
  return changes;
}

/** What a request read and wrote of a database: the reads noted while it ran, and the changes from the records before it. */
export function storeAccess(reads: readonly StoreRead[], before: PlainDatabase, db: MemoryDatabase): StoreAccess {
  return { read: [...reads], wrote: changesBetween(before, plainDatabase(db)) };
}
