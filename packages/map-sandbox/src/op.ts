/**
 * The OP of the map on a memory database: the Hono OP of apps/hono with
 * every feature, its stores, clients and keys of clients on that database,
 * signing with a key given, and sending no request out. While it answers,
 * the database is the one the OP's own code finds on the global scope
 * (db/memory/database.ts createDatabase), Date stands still at the clock
 * of the premises (clock.ts), and the fetch of the global scope refuses.
 */
import { createApp } from '../../../apps/hono/src/oidc-provider/app.js';
import { createClientKeyResolver, createClientResolver } from '../../../apps/hono/src/oidc-provider/db/memory/clients.js';
import type { MemoryDatabase } from '../../../apps/hono/src/oidc-provider/db/memory/database.js';
import { createProviderStores } from '../../../apps/hono/src/oidc-provider/db/memory/stores.js';
import { type rs256Key, staticKeyProvider } from '../../../apps/hono/src/test-support/keys.js';
import { atClock } from './clock.js';

/** A key the OP signs with (core SigningKey), as the test support makes one. */
export type SigningKey = Awaited<ReturnType<typeof rs256Key>>;

/** The global the OP's memory database is kept on (db/memory/database.ts createDatabase). */
const DATABASE_KEY = '__oidcMemoryDatabase';

/** The OP's fetch: it refuses, as the OP of the map sends no request out of the page. */
async function refuseFetch(): Promise<never> {
  throw new Error('The OP of the map sends no request out.');
}

/** The OP of the map on a database, signing with a key (see the module comment). */
export function mapOp(db: MemoryDatabase, signingKey: SigningKey, issuer: string): { fetch: (request: Request) => Response | Promise<Response> } {
  return createApp({
    signingKeyProvider: staticKeyProvider(signingKey),
    storage: createProviderStores(db),
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    outboundFetch: refuseFetch,
    config: { issuer },
  });
}

/**
 * Run with the database on the global scope, Date stopped at a clock (Unix
 * seconds) and the fetch of the global scope refusing, and give all three
 * back after: no part of the OP sends a request out, and none finds another
 * database.
 */
export async function onDatabase<T>(db: MemoryDatabase, clock: number, run: () => Promise<T>): Promise<T> {
  return atClock(clock * 1000, async () => {
    const global = globalThis as Record<string, unknown>;
    const databaseBefore = global[DATABASE_KEY];
    const fetchBefore = globalThis.fetch;
    global[DATABASE_KEY] = db;
    globalThis.fetch = refuseFetch;
    try {
      return await run();
    } finally {
      global[DATABASE_KEY] = databaseBefore;
      globalThis.fetch = fetchBefore;
    }
  });
}

/** A signing key exported as JWKs, to make it again on another OP (PreparedPremises.signingKey). */
export async function exportSigningKey(key: SigningKey): Promise<{ keyId: string; privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  return { keyId: key.keyId, privateJwk: await crypto.subtle.exportKey('jwk', key.privateKey), publicJwk: key.publicJwk };
}

/** A signing key made again from its JWKs (exportSigningKey). */
export async function importSigningKey(jwks: { keyId: string; privateJwk: JsonWebKey; publicJwk: JsonWebKey }): Promise<SigningKey> {
  const privateKey = await crypto.subtle.importKey('jwk', jwks.privateJwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);
  return { privateKey, publicJwk: jwks.publicJwk as SigningKey['publicJwk'], keyId: jwks.keyId };
}
