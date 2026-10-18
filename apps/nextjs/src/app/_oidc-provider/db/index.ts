/**
 * The database the provider uses. The CLI writes this file from the --db
 * kind it generates with: the index.ts of db/memory, db/sql or db/kv. This
 * app runs on the key-value one (db/kv/instance.ts: node:sqlite locally,
 * Upstash Redis when its variables are set); switch the line to try another
 * kind.
 */
export * from './kv/index';
