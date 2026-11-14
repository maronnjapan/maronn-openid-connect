/**
 * The in-process target of apps/hono: createApp() on an in-memory database,
 * requested with app.request(), as endpoints/token/pipeline.test.ts does.
 *
 * Every driver has a database of its own, so a scenario never sees the clients,
 * codes or tokens of another.
 */
import { TEST_ISSUER } from '../../../../apps/hono/src/test-support/context.js';
import { rs256Key, staticKeyProvider } from '../../../../apps/hono/src/test-support/keys.js';
import { confidentialClient, storedAuthorizationCode } from '../../../../apps/hono/src/test-support/token.js';
import { createApp } from '../../../../apps/hono/src/oidc-provider/app.js';
import {
  createClientKeyResolver,
  createClientResolver,
  registerClient,
} from '../../../../apps/hono/src/oidc-provider/db/memory/clients.js';
import { createEmptyDatabase } from '../../../../apps/hono/src/oidc-provider/db/memory/database.js';
import { createProviderStores } from '../../../../apps/hono/src/oidc-provider/db/memory/stores.js';
import type { InProcessDriver } from './driver.js';

/** Opens the OP of apps/hono on a new in-memory database. */
export async function openDriver(): Promise<InProcessDriver> {
  const db = createEmptyDatabase();
  const stores = createProviderStores(db);
  const app = createApp({
    signingKeyProvider: staticKeyProvider(await rs256Key()),
    storage: stores,
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    config: { issuer: TEST_ISSUER },
  });
  return {
    issuer: TEST_ISSUER,
    async registerClient({ clientId, clientSecret, redirectUri, authMethod, grantTypes, scope }) {
      await registerClient(
        db,
        confidentialClient({
          clientId,
          clientSecret,
          redirectUris: [redirectUri],
          tokenEndpointAuthMethods: [authMethod],
          ...(grantTypes === undefined ? {} : { grantTypes }),
          ...(scope === undefined ? {} : { scope }),
        }),
      );
    },
    async storeAuthorizationCode({ code, clientId, redirectUri, scope, codeChallenge }) {
      // The clock is not faked here: the code is valid for five minutes from now.
      const now = Math.floor(Date.now() / 1000);
      await stores.authCodeStore.set(
        code,
        storedAuthorizationCode({
          code,
          grantId: `grant-${code}`,
          clientId,
          redirectUri,
          scope,
          expiresAt: now + 300,
          authTime: now - 600,
          ...(codeChallenge === undefined ? {} : { codeChallenge, codeChallengeMethod: 'S256' }),
        }),
      );
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
      return app.request(request);
    },
    async close() {
      // The database is garbage once the driver is dropped: nothing outlives the scenario.
    },
  };
}
