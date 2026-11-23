/**
 * The database of the OP of the map as a request finds it: the premises
 * (premises.ts) put into a memory database the way the tests put theirs
 * (the records of apps/hono's test support, the development users), made
 * once and copied for every request, since hashing the secrets and the
 * passwords takes a moment.
 */
import type { MemoryDatabase } from '../../../apps/hono/src/oidc-provider/db/memory/database.js';
import { createEmptyDatabase } from '../../../apps/hono/src/oidc-provider/db/memory/database.js';
import { registerClient } from '../../../apps/hono/src/oidc-provider/db/memory/clients.js';
import { createProviderStores } from '../../../apps/hono/src/oidc-provider/db/memory/stores.js';
import { registerDevelopmentUsers } from '../../../apps/hono/src/oidc-provider/development.js';
import { confidentialClient, storedAuthorizationCode, storedRefreshToken } from '../../../apps/hono/src/test-support/token.js';
import type { Premises } from './premises.js';

/** A memory database that holds the premises. */
export async function seededDatabase(premises: Premises): Promise<MemoryDatabase> {
  const db = createEmptyDatabase();
  const stores = createProviderStores(db);
  for (const client of premises.clients) {
    await registerClient(
      db,
      confidentialClient({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUris: client.redirectUris,
        grantTypes: client.grantTypes,
        tokenEndpointAuthMethods: [client.authMethod],
        ...(client.scope === undefined ? {} : { scope: client.scope }),
      }),
    );
  }
  for (const code of premises.codes) {
    await stores.authCodeStore.set(
      code.code,
      storedAuthorizationCode({
        code: code.code,
        clientId: code.clientId,
        redirectUri: code.redirectUri,
        scope: code.scope,
        subject: code.subject,
        nonce: code.nonce,
        expiresAt: premises.now + code.expiresIn,
        used: code.used ?? false,
        ...(code.pkce === undefined ? {} : { codeChallenge: code.pkce.challenge, codeChallengeMethod: code.pkce.method }),
      }),
    );
  }
  for (const token of premises.refreshTokens) {
    await stores.refreshTokenStore.set(token.token, storedRefreshToken({ clientId: token.clientId, subject: token.subject, scope: token.scope, expiresAt: premises.now + token.expiresIn }));
  }
  await registerDevelopmentUsers(db);
  return db;
}
