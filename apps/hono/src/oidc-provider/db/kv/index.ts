/**
 * The database of the provider (--db kv): a key-value store (keys.ts) such as
 * Redis or Upstash, through the four methods of KvDatabase (database.ts).
 *
 * app.ts reads the provider's data through these functions, and so does the
 * code that sets the provider up (registering clients and users). You write
 * one file, db/instance.ts: createDatabase() returns your store.
 */
export { createDatabase } from './instance.js';
export type { KvDatabase as Database } from './database.js';
export { createProviderStores } from './stores.js';
export { createClientKeyResolver, createClientResolver, registerClient } from './clients.js';
export { registerUser } from './users.js';
