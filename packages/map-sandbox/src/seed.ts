/**
 * The database of the OP of the map as it is configured, before any
 * request: the clients of the premises (premises.ts) registered as an
 * operator registers them, the way the tests register theirs (apps/hono's
 * test support), and the development users. The codes and the tokens come
 * after, from requests (prepare.ts).
 */
import type { MemoryDatabase } from '../../../apps/hono/src/oidc-provider/db/memory/database.js';
import { createEmptyDatabase } from '../../../apps/hono/src/oidc-provider/db/memory/database.js';
import { registerClient } from '../../../apps/hono/src/oidc-provider/db/memory/clients.js';
import { registerDevelopmentUsers } from '../../../apps/hono/src/oidc-provider/development.js';
import { confidentialClient } from '../../../apps/hono/src/test-support/token.js';
import type { Premises } from './premises.js';

/** A memory database that holds what the OP is configured with: the clients of the premises, registered, and the development users. */
export async function configuredDatabase(premises: Premises): Promise<MemoryDatabase> {
  const db = createEmptyDatabase();
  for (const client of premises.clients) {
    await registerClient(
      db,
      confidentialClient({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUris: client.redirectUris,
        grantTypes: client.grantTypes,
        ...(client.responseTypes === undefined ? {} : { responseTypes: client.responseTypes }),
        tokenEndpointAuthMethods: [client.authMethod],
        ...(client.authMethod === 'none' ? { clientType: 'public' } : {}),
        ...(client.scope === undefined ? {} : { scope: client.scope }),
        ...(client.userinfoSignedResponseAlg === undefined ? {} : { userinfoSignedResponseAlg: client.userinfoSignedResponseAlg }),
        ...(client.requestObjectKeys === undefined ? {} : { requestObjectSigningAlg: 'ES256' }),
        ...(client.clientAssertionKeys === undefined ? {} : { tokenEndpointAuthSigningAlg: 'RS256' }),
        keys: {
          ...(client.requestObjectKeys === undefined ? {} : { request_object: { keys: client.requestObjectKeys } }),
          ...(client.clientAssertionKeys === undefined ? {} : { private_key_jwt: { keys: client.clientAssertionKeys } }),
        },
      }),
    );
  }
  await registerDevelopmentUsers(db);
  return db;
}
