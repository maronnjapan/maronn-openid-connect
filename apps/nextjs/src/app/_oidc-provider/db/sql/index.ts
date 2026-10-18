/**
 * The database of the provider (--db sql): SQL tables (schema.sql) on any
 * driver or ORM, through the two methods of SqlDatabase (database.ts).
 *
 * provider.ts reads the provider's data through these functions, and so does
 * the code that sets the provider up (registering clients and users). You write
 * one file, db/instance.ts: createDatabase() returns your database.
 */
import type { SqlDatabase } from './database';
import { createDatabase as createInstanceDatabase } from './instance';

export type { SqlDatabase as Database } from './database';

/**
 * The database the provider reads and writes: the database of db/instance.ts.
 * provider.ts creates its database when a Route Handler module is imported,
 * and `next build` imports them, so createDatabase() of db/instance.ts runs
 * on the first statement instead, and only once.
 */
export function createDatabase(): SqlDatabase {
  let database: SqlDatabase | undefined;
  const open = (): SqlDatabase => (database ??= createInstanceDatabase());
  return {
    all: (statement) => open().all(statement),
    run: (statement) => open().run(statement),
  };
}
export { createProviderStores } from './stores';
export { createClientKeyResolver, createClientResolver, registerClient } from './clients';
export { registerUser } from './users';
