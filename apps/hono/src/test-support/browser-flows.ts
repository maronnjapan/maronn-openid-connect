/**
 * Helpers for the tests of the flows the features add beside the
 * authorization code flow: the device verification screens, the CIBA
 * authentication device screens and RP-Initiated Logout.
 *
 * The records come with fixed values (override what a test is about), a
 * browser session is a store entry plus the Cookie header that names it, and
 * mountPage() serves one page of a feature with every request set up as
 * createApp() sets it up, so a test can put a store of its own over the one
 * the feature keeps on globalThis.
 */
import { Hono } from 'hono';
import { buildIdTokenPayload, generateIdToken } from '@maronn-openid-connect/core';
import type { CibaAuthenticationRequestRecord } from '@maronn-openid-connect/experimental/ciba';
import type { DeviceAuthorizationRecord } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { setRequestContext, type OidcProviderOptions } from '../oidc-provider/app.js';
import { buildSessionCookie } from '../oidc-provider/cookies.js';
import { createClientKeyResolver, createClientResolver } from '../oidc-provider/db/memory/clients.js';
import type { MemoryDatabase } from '../oidc-provider/db/memory/database.js';
import { createProviderStores } from '../oidc-provider/db/memory/stores.js';
import type { ProviderStores } from '../oidc-provider/store.js';
import { TEST_ISSUER } from './context.js';
import { rs256Key } from './keys.js';

/** The auth_time of the browser sessions signInBrowser() creates. */
export const SESSION_AUTH_TIME = 1_700_000_000;

/**
 * Put a browser (OP) session for subject into the stores, and return its id
 * with the Cookie header a browser holding it sends.
 */
export async function signInBrowser(
  stores: ProviderStores,
  subject: string,
  authTime = SESSION_AUTH_TIME,
): Promise<{ sessionId: string; cookie: string }> {
  const sessionId = 'session-' + crypto.randomUUID();
  await stores.browserSessionStore.set(sessionId, { subject, authTime });
  return { sessionId, cookie: cookieHeaderOf([buildSessionCookie(sessionId)]) };
}

/**
 * The Cookie request header a browser sends back for the given Set-Cookie
 * values: the name=value pairs without the attributes, cleared cookies
 * (empty value) left out.
 */
export function cookieHeaderOf(setCookies: readonly string[]): string {
  return setCookies
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

/** The value of the cookie name in a Set-Cookie value, or undefined when it is another cookie. */
export function cookieValueOf(setCookie: string, name: string): string | undefined {
  const pair = setCookie.split(';')[0] ?? '';
  return pair.startsWith(name + '=') ? pair.slice(name.length + 1) : undefined;
}

/** A pending device authorization record (RFC 8628 §3.2) that expires in 600 seconds. */
export function pendingDeviceRecord(overrides: Partial<DeviceAuthorizationRecord> = {}): DeviceAuthorizationRecord {
  const now = Date.now();
  return {
    deviceCode: 'device-code-' + crypto.randomUUID(),
    userCode: 'BCDFGHJK',
    userCodeDisplay: 'BCDF-GHJK',
    clientId: 'device-client',
    scope: ['openid', 'profile'],
    status: 'pending',
    createdAt: new Date(now),
    expiresAt: new Date(now + 600_000),
    interval: 5,
    lastPolledAt: null,
    csrfToken: null,
    bindingHash: null,
    loginAttempts: 0,
    ...overrides,
  };
}

/** A pending CIBA authentication request for alice (CIBA Core 1.0 §7.3) that expires in 120 seconds. */
export function pendingCibaRecord(
  overrides: Partial<CibaAuthenticationRequestRecord> = {},
): CibaAuthenticationRequestRecord {
  const now = Date.now();
  return {
    authReqId: 'auth-req-' + crypto.randomUUID(),
    clientId: 'ciba-client',
    subject: 'alice',
    scope: ['openid', 'profile'],
    status: 'pending',
    createdAt: new Date(now),
    expiresAt: new Date(now + 120_000),
    interval: 5,
    lastPolledAt: null,
    csrfToken: null,
    ...overrides,
  };
}

/**
 * An ID Token the provider of the tests issued (signed with the key of
 * keys.ts that providerContext() and mountPage() use), to present as
 * id_token_hint.
 */
export async function signIdToken(input: {
  subject: string;
  clientId: string;
  issuer?: string;
  expiresIn?: number;
  issuedAt?: number;
  idTokenAudiences?: string[];
}): Promise<string> {
  const key = await rs256Key();
  const payload = buildIdTokenPayload({
    issuer: input.issuer ?? TEST_ISSUER,
    subject: input.subject,
    clientId: input.clientId,
    scope: ['openid'],
    expiresIn: input.expiresIn ?? 3600,
    issuedAt: input.issuedAt,
    idTokenAudiences: input.idTokenAudiences,
  });
  return generateIdToken({ payload, privateKey: key.privateKey, keyId: key.keyId });
}

/** The payload of a JWT, without verifying it. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const segment = jwt.split('.')[1] ?? '';
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/**
 * An app that serves page under path, each request set up as createApp()
 * sets it up (setRequestContext()) on db, with values put over the context
 * afterwards (a store of the test's own, for one).
 */
export function mountPage(
  path: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: Hono<any>,
  input: { db: MemoryDatabase; values?: Record<string, unknown>; options?: Partial<OidcProviderOptions> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Hono<{ Variables: Record<string, any> }> {
  const stores = createProviderStores(input.db);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Variables: Record<string, any> }>();
  app.use('*', async (c, next) => {
    const failure = await setRequestContext(c, {
      signingKeyProvider: { getSigningKeys: async () => [await rs256Key()] },
      storage: stores,
      clientResolver: createClientResolver(input.db),
      clientKeyResolver: createClientKeyResolver(input.db),
      ...input.options,
      config: { issuer: TEST_ISSUER, ...input.options?.config },
    });
    if (failure) return failure;
    for (const [name, value] of Object.entries(input.values ?? {})) {
      c.set(name, value);
    }
    await next();
  });
  app.route(path, page);
  return app;
}
