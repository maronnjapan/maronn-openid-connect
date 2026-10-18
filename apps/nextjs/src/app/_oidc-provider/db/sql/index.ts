/**
 * The database of the provider (--db sql): SQL tables (schema.sql) on any
 * driver or ORM, through the two methods of SqlDatabase (database.ts).
 *
 * app.ts reads the provider's data through these functions, and so does the
 * code that sets the provider up (registering clients and users). You write
 * one file, db/instance.ts: createDatabase() returns your database.
 */
import type { SqlDatabase } from './database';
import { createDatabase as createInstanceDatabase } from './instance';

export type { SqlDatabase as Database } from './database';

/**
 * The database the provider reads and writes: createDatabase() of
 * db/instance.ts, called on every use so that `next build` never opens it.
 */
export const createDatabase: () => SqlDatabase = createInstanceDatabase;
export { createProviderStores } from './stores';
export { createClientKeyResolver, createClientResolver, registerClient } from './clients';
export { registerUser } from './users';
