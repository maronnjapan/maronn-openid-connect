/**
 * The database of the provider, kept in the memory of this process
 * (generated without --db). Generate with --db sql or --db kv to keep the
 * data in a database instead; the functions below keep their names.
 *
 * provider.ts reads the provider's data through these functions, and so does
 * the code that sets the provider up (registering clients and users).
 */
export { createDatabase } from './database';
export type { MemoryDatabase as Database } from './database';
export { createProviderStores } from './stores';
export { createClientKeyResolver, createClientResolver, registerClient } from './clients';
export { registerUser } from './users';
