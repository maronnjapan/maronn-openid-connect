/**
 * Helpers for the tests of the Express and Fastify output (src/web/): a
 * local HTTP server on a free port, an IncomingMessage built without a
 * server, the provider options the adapters are applied with, and what the
 * provider answers to OPTIONS on each path it serves.
 */
import { createServer, IncomingMessage, type IncomingHttpHeaders, type RequestListener } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import type { OidcProviderOptions } from '../oidc-provider/app.js';
import { createClientKeyResolver, createClientResolver } from '../oidc-provider/db/memory/clients.js';
import type { MemoryDatabase } from '../oidc-provider/db/memory/database.js';
import { createProviderStores } from '../oidc-provider/db/memory/stores.js';
import { TEST_ISSUER } from './context.js';
import { rs256Key, staticKeyProvider } from './keys.js';

export interface LocalServer {
  /** The origin the server listens on, e.g. http://127.0.0.1:54321. */
  url: string;
  close(): Promise<void>;
}

/** Serve listener on a free port of 127.0.0.1. */
export async function listen(listener: RequestListener): Promise<LocalServer> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // fetch keeps its connections alive; drop them so close() returns.
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * An IncomingMessage as node:http hands one to a request listener, with the
 * given request line, headers and body. Leave method or url out to keep the
 * values a fresh IncomingMessage has (null and '').
 */
export function incomingMessage(
  input: { method?: string; url?: string; originalUrl?: string; headers?: IncomingHttpHeaders; body?: string } = {},
): IncomingMessage & { originalUrl?: string } {
  const incoming: IncomingMessage & { originalUrl?: string } = new IncomingMessage(new Socket());
  if (input.method !== undefined) incoming.method = input.method;
  if (input.url !== undefined) incoming.url = input.url;
  if (input.originalUrl !== undefined) incoming.originalUrl = input.originalUrl;
  incoming.headers = input.headers ?? {};
  if (input.body !== undefined) incoming.push(input.body);
  incoming.push(null);
  return incoming;
}

/**
 * The options providerApp() (screens.ts) creates the provider with: the test
 * signing key and issuer, and the stores and clients of db.
 */
export async function providerOptions(
  db: MemoryDatabase,
  options: Partial<OidcProviderOptions> = {},
): Promise<OidcProviderOptions> {
  return {
    signingKeyProvider: staticKeyProvider(await rs256Key()),
    storage: createProviderStores(db),
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    ...options,
    config: { issuer: TEST_ISSUER, ...options.config },
  };
}

export interface PathPreflight {
  path: string;
  status: number;
  allow: string | null;
  allowOrigin: string | null;
}

/**
 * What the provider answers to OPTIONS on every path of providerRoutes(),
 * the paths below the mount points included. The CORS endpoints answer the
 * preflight with 204 (OAuth 2.1 §4.2, and Discovery / JWKS as public
 * documents); every other path answers 405 with its methods in Allow
 * (RFC 9110 §15.5.6). Either answer only comes from the provider.
 */
export const PROVIDER_PATH_PREFLIGHTS: readonly PathPreflight[] = [
  { path: '/authorize', status: 405, allow: 'GET, POST', allowOrigin: null },
  { path: '/token', status: 204, allow: null, allowOrigin: '*' },
  { path: '/userinfo', status: 204, allow: null, allowOrigin: '*' },
  { path: '/.well-known/jwks.json', status: 204, allow: null, allowOrigin: '*' },
  { path: '/.well-known/openid-configuration', status: 204, allow: null, allowOrigin: '*' },
  { path: '/login', status: 405, allow: 'GET, POST', allowOrigin: null },
  { path: '/consent', status: 405, allow: 'GET, POST', allowOrigin: null },
  { path: '/introspect', status: 204, allow: null, allowOrigin: '*' },
  { path: '/revoke', status: 204, allow: null, allowOrigin: '*' },
  { path: '/par', status: 204, allow: null, allowOrigin: '*' },
  { path: '/device_authorization', status: 204, allow: null, allowOrigin: '*' },
  { path: '/device', status: 405, allow: 'GET, POST', allowOrigin: null },
  { path: '/device/login', status: 405, allow: 'POST', allowOrigin: null },
  { path: '/device/approve', status: 405, allow: 'POST', allowOrigin: null },
  { path: '/backchannel_authentication', status: 204, allow: null, allowOrigin: '*' },
  { path: '/ciba', status: 405, allow: 'GET', allowOrigin: null },
  { path: '/ciba/login', status: 405, allow: 'POST', allowOrigin: null },
  { path: '/ciba/approve', status: 405, allow: 'POST', allowOrigin: null },
  { path: '/logout', status: 405, allow: 'GET, POST', allowOrigin: null },
  { path: '/logout/approve', status: 405, allow: 'POST', allowOrigin: null },
  { path: '/register', status: 204, allow: null, allowOrigin: '*' },
  { path: '/login/google', status: 405, allow: 'POST', allowOrigin: null },
];

/** The value of the hidden field name in a rendered form. */
export function hiddenValueOf(html: string, name: string): string {
  return new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '';
}
