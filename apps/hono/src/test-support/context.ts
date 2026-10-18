/**
 * Request contexts for the tests of the steps.
 *
 * contextOf() is a bare Hono context with the given values set. providerContext()
 * sets the context up the way app.ts sets up every request (setRequestContext()),
 * on an in-memory database of its own, so a step runs against the same
 * stores, resolvers and settings it has in the running provider.
 */
import { Context } from 'hono';
import type { SigningKey } from '@maronn-openid-connect/core';
import { setRequestContext, type OidcProviderOptions } from '../oidc-provider/app.js';
import { createClientKeyResolver, createClientResolver } from '../oidc-provider/db/memory/clients.js';
import { createEmptyDatabase, type MemoryDatabase } from '../oidc-provider/db/memory/database.js';
import { createProviderStores } from '../oidc-provider/db/memory/stores.js';
import type { ProviderStores } from '../oidc-provider/store.js';
import { rs256Key, staticKeyProvider } from './keys.js';

/** The issuer of the provider the tests run. */
export const TEST_ISSUER = 'https://op.example.com';

/** A request to the test issuer. */
export function requestTo(path: string, init?: RequestInit): Request {
  return new Request(new URL(path, TEST_ISSUER), init);
}

/** A form POST to the test issuer. */
export function formPost(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return requestTo(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A Hono context for the request, with the given values set. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function contextOf(request: Request = requestTo('/'), values: Record<string, unknown> = {}): any {
  const c = new Context(request);
  for (const [name, value] of Object.entries(values)) {
    c.set(name as never, value as never);
  }
  return c;
}

export interface ProviderContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any;
  db: MemoryDatabase;
  stores: ProviderStores;
  signingKey: SigningKey;
}

/**
 * A context set up as app.ts sets up a request to the provider, on a new
 * in-memory database (or the one passed in).
 */
export async function providerContext(
  input: {
    request?: Request;
    db?: MemoryDatabase;
    options?: Partial<OidcProviderOptions>;
  } = {},
): Promise<ProviderContext> {
  const db = input.db ?? createEmptyDatabase();
  const stores = createProviderStores(db);
  const signingKey = await rs256Key();
  const c = contextOf(input.request ?? requestTo('/'));
  const failure = await setRequestContext(c, {
    signingKeyProvider: staticKeyProvider(signingKey),
    storage: stores,
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    ...input.options,
    config: { issuer: TEST_ISSUER, ...input.options?.config },
  });
  if (failure) throw new Error(`setRequestContext failed with ${failure.status}`);
  return { c, db, stores, signingKey };
}
