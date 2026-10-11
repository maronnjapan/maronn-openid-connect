/**
 * The key-value contract of the generated OP (--db kv).
 *
 * db/stores.ts, db/clients.ts and db/users.ts keep every record through these
 * four methods, and db/instance.ts creates the object that implements them for
 * your store. keys.ts lists the keys and the records they hold.
 *
 * - Keys and values are strings. Every value is JSON text.
 * - ttlSeconds is a whole number of seconds, 1 or more. A key past its TTL
 *   reads as missing. A key written without ttlSeconds does not expire.
 * - setIfAbsent stores the value only when the key is missing (or has
 *   expired), in one atomic step: of concurrent calls for one key, exactly one
 *   returns true. Authorization codes and refresh tokens are single-use
 *   because of it. Redis and Upstash have SET NX, DynamoDB a conditional put
 *   with attribute_not_exists, Deno KV an atomic check on a null versionstamp.
 * - A get sees every write that finished before it started. A store that
 *   copies writes to its other locations later (Cloudflare Workers KV) does not:
 *   the token request can reach a location that has not received the code yet.
 *   Workers KV has no atomic write either, so on Cloudflare use D1 (--db sql)
 *   or a store built on Durable Objects.
 * - There is no transaction and no listing of keys. A record the stores read,
 *   change and write back (stores.ts says which) is one the OP's flows change
 *   from one request at a time.
 */
export interface KvDatabase {
  /** The value of key, or null when the key is missing or has expired. */
  get(key: string): Promise<string | null>;
  /** Store value under key, replacing the value that is there. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Store value under key only when the key is missing, atomically; true when it stored the value. */
  setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
  /** Remove key. A missing key is not an error. */
  delete(key: string): Promise<void>;
}

/** The record under key (parsed from JSON), or undefined when the key is missing. */
export async function readRecord<T>(db: KvDatabase, key: string): Promise<T | undefined> {
  const value = await db.get(key);
  return value === null ? undefined : (JSON.parse(value) as T);
}

/** Store record under key as JSON. */
export async function writeRecord(
  db: KvDatabase,
  key: string,
  record: unknown,
  ttlSeconds?: number,
): Promise<void> {
  await db.set(key, JSON.stringify(record), ttlSeconds);
}
