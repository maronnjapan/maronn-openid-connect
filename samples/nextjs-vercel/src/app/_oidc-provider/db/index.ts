/**
 * The database of the provider (--db kv): a key-value store (keys.ts) such as
 * Redis or Upstash, through the four methods of KvDatabase (database.ts).
 *
 * provider.ts reads the provider's data through these functions, and so does
 * the code that sets the provider up (registering clients and users). You write
 * one file, db/instance.ts: createDatabase() returns your store.
 */
import type { KvDatabase } from './database';
import { createDatabase as createInstanceDatabase } from './instance';

export type { KvDatabase as Database } from './database';

/**
 * The database the provider reads and writes: the store of db/instance.ts.
 * provider.ts creates its database when a Route Handler module is imported,
 * and `next build` imports them, so createDatabase() of db/instance.ts runs
 * on the first call to a method instead, and only once.
 */
export function createDatabase(): KvDatabase {
  let store: KvDatabase | undefined;
  const open = (): KvDatabase => (store ??= createInstanceDatabase());
  return {
    get: (key) => open().get(key),
    set: (key, value, ttlSeconds) => open().set(key, value, ttlSeconds),
    setIfAbsent: (key, value, ttlSeconds) => open().setIfAbsent(key, value, ttlSeconds),
    delete: (key) => open().delete(key),
  };
}
export { createProviderStores } from './stores';
export { createClientKeyResolver, createClientResolver, registerClient } from './clients';
export { registerUser } from './users';
