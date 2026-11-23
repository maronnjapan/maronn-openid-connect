/**
 * The OP of the map on a memory database: the Hono OP of apps/hono with
 * every feature, its stores, clients and keys of clients on that database,
 * signing with a key given, and sending no request out. While it answers,
 * the database is the one the OP's own code finds on the global scope
 * (db/memory/database.ts createDatabase), Date stands still at the clock
 * of the premises (clock.ts), the fetch of the global scope refuses, and a
 * response keeps the cookies it sets in a page too (keepingSetCookies).
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
 * seconds), the fetch of the global scope refusing and responses keeping
 * their Set-Cookie values, and give all four back after: no part of the OP
 * sends a request out, and none finds another database.
 */
export async function onDatabase<T>(db: MemoryDatabase, clock: number, run: () => Promise<T>): Promise<T> {
  return atClock(clock * 1000, () => keepingSetCookies(async () => {
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
  }));
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

/**
 * A request with every header given, Cookie and Origin included. A page
 * makes a Request without the headers only a browser may set (Cookie,
 * Origin, Sec-Fetch-*), so the OP, which reads them, is given the request
 * with headers of its own that keep them all; in Node the Request keeps
 * them already.
 */
export function wholeRequest(url: URL | string, init: { method: string; headers: ReadonlyArray<readonly [string, string]>; body?: string }): Request {
  const request = new Request(url, { method: init.method, headers: init.headers.map(([name, value]): [string, string] => [name, value]), ...(init.body === undefined ? {} : { body: init.body }) });
  const headers = new Headers(init.headers.map(([name, value]): [string, string] => [name, value]));
  if ([...headers.keys()].some((name) => !request.headers.has(name))) Object.defineProperty(request, 'headers', { value: headers });
  return request;
}

/** The Set-Cookie values a response was made with, kept by keepingSetCookies. */
const KEPT_SET_COOKIES = Symbol('set-cookie');

/**
 * Run with the Response of the global scope keeping the Set-Cookie values
 * a response is made with, and give it back after. A page's Response drops
 * them (Set-Cookie is a header a page may not read), so the cookies the OP
 * sets (its transaction, its session) would be lost to the browser of the
 * premises and to the reader of a response.
 */
export async function keepingSetCookies<T>(run: () => Promise<T>): Promise<T> {
  const Base = globalThis.Response;
  /** A Response that keeps the Set-Cookie values of the headers it is made with. */
  class KeepingResponse extends Base {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init);
      Object.defineProperty(this, KEPT_SET_COOKIES, { value: init?.headers === undefined ? [] : new Headers(init.headers).getSetCookie() });
    }
  }
  globalThis.Response = KeepingResponse as typeof Response;
  try {
    return await run();
  } finally {
    globalThis.Response = Base;
  }
}

/** The Set-Cookie values of a response: those its headers give, else those kept when it was made (keepingSetCookies). */
export function setCookiesOf(response: Response): string[] {
  const own = response.headers.getSetCookie();
  if (own.length > 0) return own;
  return ((response as unknown as Record<symbol, string[] | undefined>)[KEPT_SET_COOKIES] ?? []).slice();
}

/** The headers of a response as a message keeps them (lower-case names), with the Set-Cookie values kept when a page's Response dropped them. */
export function responseHeaders(response: Response): Array<[string, string]> {
  const headers = [...response.headers].map(([name, value]): [string, string] => [name.toLowerCase(), value]);
  if (headers.some(([name]) => name === 'set-cookie')) return headers;
  return [...headers, ...setCookiesOf(response).map((value): [string, string] => ['set-cookie', value])];
}
