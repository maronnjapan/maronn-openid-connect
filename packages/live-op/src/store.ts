/**
 * What a request on the live OP reads and writes of the OP's memory
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
import type { StoreAccess, StoreChange, StoreRead } from './api.js';

/** The records of the OP's memory database as plain JSON (a Map as an object, a Set as an array), by collection (`codes`, `clients`, …), then by key. */
export type PlainDatabase = Record<string, Record<string, unknown>>;

/** The reads of a request as it runs: the first of each place (Place), in order, and the places the request wrote itself, whose reads are its own. */
interface ReadLog {
  reads: StoreRead[];
  seen: Set<string>;
  written: Set<string>;
}

/** Where a read or a write is in the database: a collection, a record of it (none for the whole collection), and a member of the record's own Map (none for the whole record). */
interface Place {
  collection: string;
  key?: string | undefined;
  member?: string | undefined;
}

/** The key a place is noted by in a read log (a key of `*` is a key, not a walk). */
function logKey(place: Place): string {
  return JSON.stringify([place.collection, place.key ?? null, place.member ?? null]);
}

/** Note a read of a place, unless one of it was noted already or the request wrote it itself. */
function noteRead(log: ReadLog, place: Place, found: boolean): void {
  const noted = logKey(place);
  if (log.seen.has(noted) || (place.key !== undefined && log.written.has(noted))) return;
  log.seen.add(noted);
  log.reads.push({ collection: place.collection, ...(place.key === undefined ? {} : { key: place.key }), ...(place.member === undefined ? {} : { member: place.member }), found });
}

/**
 * A Map of the database that notes in a read log what is read from it and
 * the keys written to it: a collection (its keys are records), or the Map a
 * record of a collection is (its keys are members of the record: the
 * client_ids of a user's consents).
 */
class WatchedMap<K, V> extends Map<K, V> {
  readonly #collection: string;
  readonly #record: string | undefined;
  readonly #log: ReadLog;

  constructor(collection: string, log: ReadLog, entries: Map<K, V>, record?: string) {
    super();
    this.#collection = collection;
    this.#record = record;
    this.#log = log;
    for (const [key, value] of Map.prototype.entries.call(entries) as MapIterator<[K, V]>) super.set(key, value);
  }

  /** The place of a key of this Map: a record of the collection, or a member of the record. */
  #placeOf(key: K): Place {
    return this.#record === undefined ? { collection: this.#collection, key: String(key) } : { collection: this.#collection, key: this.#record, member: String(key) };
  }

  /** Note a walk over this Map: over the collection, or over the record whole. */
  #noteWalk(): void {
    noteRead(this.#log, { collection: this.#collection, key: this.#record }, this.size > 0);
  }

  override get(key: K): V | undefined {
    noteRead(this.#log, this.#placeOf(key), super.has(key));
    return super.get(key);
  }

  override has(key: K): boolean {
    noteRead(this.#log, this.#placeOf(key), super.has(key));
    return super.has(key);
  }

  override set(key: K, value: V): this {
    this.#log.written.add(logKey(this.#placeOf(key)));
    return super.set(key, value);
  }

  override delete(key: K): boolean {
    this.#log.written.add(logKey(this.#placeOf(key)));
    return super.delete(key);
  }

  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    this.#noteWalk();
    super.forEach(callback, thisArg);
  }

  override entries(): MapIterator<[K, V]> {
    this.#noteWalk();
    return super.entries();
  }

  override keys(): MapIterator<K> {
    this.#noteWalk();
    return super.keys();
  }

  override values(): MapIterator<V> {
    this.#noteWalk();
    return super.values();
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

/**
 * Put Maps that note what is read into a database, in place of its own,
 * holding the same records, and return the reads they note: the first read
 * of each record (its collection and key, and whether the database held it),
 * of each member of a record that is a Map itself (a user's consent to a
 * client: the record's key and the member's), and of each collection walked
 * whole, in the order read, but the reads of what the request wrote before
 * it read it, which are its own.
 */
export function watchDatabase(db: MemoryDatabase): StoreRead[] {
  const log: ReadLog = { reads: [], seen: new Set(), written: new Set() };
  const collections = db as unknown as Record<string, unknown>;
  for (const [collection, records] of Object.entries(collections)) {
    if (!(records instanceof Map)) continue;
    const watched = new WatchedMap(collection, log, records);
    for (const [key, record] of Map.prototype.entries.call(watched) as MapIterator<[unknown, unknown]>) {
      if (record instanceof Map) Map.prototype.set.call(watched, key, new WatchedMap(collection, log, record, String(key)));
    }
    collections[collection] = watched;
  }
  return log.reads;
}

/** A value as plain JSON: a Map as an object of its entries by key, a Set as an array of its members, an object and an array member by member, the members of an object that are undefined left out (as JSON leaves them out). */
export function plainOf(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries([...Map.prototype.entries.call(value)].map(([key, member]) => [String(key), plainOf(member)]));
  if (value instanceof Set) return [...value].map(plainOf);
  if (Array.isArray(value)) return value.map(plainOf);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined).map(([key, member]) => [key, plainOf(member)]));
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
            if (!(key in is)) changes.push({ collection, key, change: 'removed', before: structuredClone(was[key]) });
      else if (!(key in was)) changes.push({ collection, key, change: 'added', value: is[key] });
      else if (JSON.stringify(was[key]) !== JSON.stringify(is[key])) changes.push({ collection, key, change: 'changed', value: is[key], before: structuredClone(was[key]), fields: changedFields(was[key], is[key]) });
    }
  }
  return changes;
}

/** What a request read and wrote of a database: the reads noted while it ran, and the changes from the records before it. */
export function storeAccess(reads: readonly StoreRead[], before: PlainDatabase, db: MemoryDatabase): StoreAccess {
  return { read: [...reads], wrote: changesBetween(before, plainDatabase(db)) };
}
