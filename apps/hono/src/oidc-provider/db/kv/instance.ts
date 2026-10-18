/**
 * The key-value store instance: the one file in db/ that you write.
 *
 * The CLI creates this file only when it does not exist yet and never
 * overwrites it, not even with --force, so your code here survives
 * re-generation. Everything else in db/ is generated.
 *
 * createDatabase() returns a KvDatabase (database.ts): get, set, setIfAbsent
 * and delete on string keys and values. Wrap the client of your store in them;
 * the examples at the end of this file are starting points. setIfAbsent must
 * be atomic, and a get must see the writes that finished before it
 * (database.ts says why, and why Cloudflare Workers KV does not fit). The OP
 * reads its clients and users from the store, so register them there with
 * registerClient() (clients.ts) and registerUser() (users.ts).
 *
 * The generated app calls createDatabase() for every request with the Hono
 * context, so the URL and token of a store can be read from its bindings
 * (c.env). Keep a client that must outlive a request in a module-level
 * variable instead of creating it here.
 */
import type { Context } from 'hono';
import type { KvDatabase } from './database.js';

export function createDatabase(_c: Context): KvDatabase {
  throw new Error(
    'db/instance.ts: createDatabase() is not implemented yet. ' +
      'Return the key-value store the OP keeps its data in (see the examples in that file).',
  );
}

// ---------------------------------------------------------------------------
// Examples. Replace createDatabase() above with one of them, adapted to your
// project; each needs: import type { KvDatabase } from './database.js';
//
// Upstash Redis over its REST API (Vercel KV is Upstash too). fetch is all
// it needs, so it runs on Node.js, Vercel and Cloudflare Workers alike:
//
//   const upstash = async (url: string, token: string, command: Array<string | number>) => {
//     const response = await fetch(url, {
//       method: 'POST',
//       headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
//       body: JSON.stringify(command),
//     });
//     const body = (await response.json()) as { result?: unknown; error?: string };
//     if (!response.ok || body.error !== undefined) {
//       throw new Error('Upstash: ' + (body.error ?? 'HTTP ' + response.status));
//     }
//     return body.result;
//   };
//
//   export function createDatabase(c: Context): KvDatabase {
//     const run = (command: Array<string | number>) =>
//       upstash(c.env.UPSTASH_REDIS_REST_URL as string, c.env.UPSTASH_REDIS_REST_TOKEN as string, command);
//     const expiry = (ttlSeconds?: number) => (ttlSeconds === undefined ? [] : ['EX', ttlSeconds]);
//     return {
//       get: async (key) => (await run(['GET', key])) as string | null,
//       set: async (key, value, ttlSeconds) => {
//         await run(['SET', key, value, ...expiry(ttlSeconds)]);
//       },
//       setIfAbsent: async (key, value, ttlSeconds) =>
//         (await run(['SET', key, value, 'NX', ...expiry(ttlSeconds)])) === 'OK',
//       delete: async (key) => {
//         await run(['DEL', key]);
//       },
//     };
//   }
//
// In memory, for trying the OP out: the data lives in the memory of one isolate,
// so it is lost on every restart and never shared between isolates. It fits
// wrangler dev and nothing else:
//
//   const entries = new Map<string, { value: string; expiresAt: number }>();
//   const live = (key: string) => {
//     const entry = entries.get(key);
//     if (entry && entry.expiresAt <= Date.now()) entries.delete(key);
//     return entries.get(key);
//   };
//   const expiry = (ttlSeconds?: number) =>
//     ttlSeconds === undefined ? Number.POSITIVE_INFINITY : Date.now() + ttlSeconds * 1000;
//
//   export function createDatabase(_c: Context): KvDatabase {
//     return {
//       get: async (key) => live(key)?.value ?? null,
//       set: async (key, value, ttlSeconds) => {
//         entries.set(key, { value, expiresAt: expiry(ttlSeconds) });
//       },
//       setIfAbsent: async (key, value, ttlSeconds) => {
//         if (live(key)) return false;
//         entries.set(key, { value, expiresAt: expiry(ttlSeconds) });
//         return true;
//       },
//       delete: async (key) => {
//         entries.delete(key);
//       },
//     };
//   }
