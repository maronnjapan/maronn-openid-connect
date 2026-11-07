/**
 * The in-process target of apps/nextjs: the Route Handlers called with a
 * Request, as the route tests of the app do ((dynamic-client-registration)/register/route.test.ts).
 *
 * _oidc-provider/provider.ts builds the stores once per process, on the store
 * db/kv/instance.ts keeps on globalThis (__oidcKvDatabase). Before the provider
 * is first imported, this module puts a store there that hands every call to
 * the store of the current scenario, a Map of test-support/databases.ts: each
 * driver starts a new one, so a scenario never sees the clients, codes or
 * tokens of another. Playwright runs one test at a time in a worker, so one
 * current store per process is enough.
 *
 * The provider reads its issuer from OIDC_ISSUER when it is imported, as in
 * the Vitest config of the app.
 *
 * The code of the app imports the subpaths of next without an extension
 * (`next/script`, `next/server`). The next package has no exports map, so its
 * bundler and Vite resolve them as CommonJS does; the ESM resolver of Node does
 * not, and the driver adds a resolve hook that tries the `.js` file, once per
 * process (resolveNextSubpaths()).
 */
import { registerHooks } from 'node:module';
import { createMapKvDatabase } from '../../../../apps/nextjs/src/test-support/databases';
import { TEST_ISSUER } from '../../../../apps/nextjs/src/test-support/context';
import type { KvDatabase } from '../../../../apps/nextjs/src/app/_oidc-provider/db/kv/database';
import type { InProcessDriver } from './driver.js';

/** The Route Handlers the driver serves, by path. */
const ROUTES = {
  '/token': () => import('../../../../apps/nextjs/src/app/token/route'),
} as const;

let current: KvDatabase | undefined;

/** Opens the Route Handlers of apps/nextjs on a new in-memory store. */
export async function openDriver(): Promise<InProcessDriver> {
  resolveNextSubpaths();
  installScenarioStore();
  const store = createMapKvDatabase();
  current = store;
  const { stores } = await import('../../../../apps/nextjs/src/app/_oidc-provider/provider');
  const { createDatabase, registerClient } = await import('../../../../apps/nextjs/src/app/_oidc-provider/db');
  const database = createDatabase();
  return {
    issuer: TEST_ISSUER,
    async registerClient({ clientId, clientSecret, redirectUri, authMethod }) {
      await registerClient(database, {
        clientId,
        clientSecret,
        redirectUris: [redirectUri],
        clientType: 'confidential',
        grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethods: [authMethod],
        responseTypes: ['code'],
      });
    },
    async storeAuthorizationCode({ code, clientId, redirectUri, scope, codeChallenge }) {
      const now = Math.floor(Date.now() / 1000);
      // The record the consent route stores (createAuthorizationCode() of core)
      // for a user who authenticated ten minutes ago: the store keeps the
      // subject and auth_time besides the fields AuthorizationCodeInfo names.
      const record = {
        code,
        grantId: `grant-${code}`,
        clientId,
        redirectUri,
        redirectUriExplicit: true,
        scope,
        subject: 'user-1',
        used: false,
        expiresAt: now + 300,
        authTime: now - 600,
        nonce: 'nonce-1',
        sessionId: 'session-1',
        ...(codeChallenge === undefined ? {} : { codeChallenge, codeChallengeMethod: 'S256' as const }),
      };
      await stores.authCodeStore.set(code, record);
    },
    async authorizationCodeUsed(code) {
      return (await stores.authCodeStore.get(code))?.used;
    },
    async holdsAccessToken(accessToken) {
      return (await stores.accessTokenStore.get(accessToken)) !== undefined;
    },
    async holdsRefreshToken(refreshToken) {
      return (await stores.refreshTokenStore.get(refreshToken)) !== undefined;
    },
    async request(request) {
      const { pathname } = new URL(request.url);
      if (!isRoute(pathname)) throw new Error(`The Next.js in-process target serves no Route Handler at ${pathname}`);
      const route = await ROUTES[pathname]();
      if (request.method !== 'POST') throw new Error(`The Next.js in-process target serves only POST ${pathname}`);
      return route.POST(request);
    },
    async close() {
      if (current === store) current = undefined;
    },
  };
}

/**
 * Lets the ESM resolver of this process find a subpath of next written without
 * its extension (`next/script` is next/script.js), as the bundler of Next.js does.
 */
function resolveNextSubpaths(): void {
  const registry = globalThis as typeof globalThis & { __oidcNextSubpathsResolved?: boolean };
  if (registry.__oidcNextSubpathsResolved === true) return;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (!/^next\/[^.]+$/.test(specifier) || (error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
        return nextResolve(`${specifier}.js`, context);
      }
    },
  });
  registry.__oidcNextSubpathsResolved = true;
}

/** Whether the driver serves a Route Handler at the path. */
function isRoute(pathname: string): pathname is keyof typeof ROUTES {
  return Object.hasOwn(ROUTES, pathname);
}

/**
 * Puts the store of the scenarios on globalThis, where db/kv/instance.ts
 * looks for it, and fixes the issuer, before the provider is first imported.
 *
 * @throws {Error} when the provider has already opened another store in this process
 */
function installScenarioStore(): void {
  const registry = globalThis as typeof globalThis & {
    __oidcKvDatabase?: KvDatabase;
    __oidcScenarioStoreInstalled?: boolean;
  };
  if (registry.__oidcKvDatabase === undefined) {
    process.env.OIDC_ISSUER = TEST_ISSUER;
    process.env.OIDC_SQLITE_PATH = ':memory:';
    registry.__oidcKvDatabase = {
      get: (key) => scenarioStore().get(key),
      set: (key, value, ttlSeconds) => scenarioStore().set(key, value, ttlSeconds),
      setIfAbsent: (key, value, ttlSeconds) => scenarioStore().setIfAbsent(key, value, ttlSeconds),
      delete: (key) => scenarioStore().delete(key),
    };
    registry.__oidcScenarioStoreInstalled = true;
  }
  if (registry.__oidcScenarioStoreInstalled !== true) {
    throw new Error('The Next.js provider opened its own store before the in-process target could put the scenario store there');
  }
}

/**
 * The store of the current scenario.
 *
 * @throws {Error} when no scenario is running (the driver was closed)
 */
function scenarioStore(): KvDatabase {
  if (current === undefined) throw new Error('No scenario of the Next.js in-process target is running');
  return current;
}
