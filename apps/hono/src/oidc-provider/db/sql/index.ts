/**
 * The database of the provider (--db sql): SQL tables (schema.sql) on any
 * driver or ORM, through the two methods of SqlDatabase (database.ts).
 *
 * app.ts reads the provider's data through these functions, and so does the
 * code that sets the provider up (registering clients and users). You write
 * one file, db/instance.ts: createDatabase() returns your database.
 */
export { createDatabase } from './instance.js';
export type { SqlDatabase as Database } from './database.js';
export { createProviderStores } from './stores.js';
export { createClientKeyResolver, createClientResolver, registerClient } from './clients.js';
export { registerUser } from './users.js';
