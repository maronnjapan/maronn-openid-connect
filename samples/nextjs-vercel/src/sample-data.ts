/**
 * The clients and users of this sample. The generated OP (src/app, --db)
 * reads both from the tables of src/app/_oidc-provider/db/, so
 * instrumentation.ts registers them there when a server instance starts.
 */
import type { RegisteredClient } from './app/_oidc-provider/config';
import { registerClient } from './app/_oidc-provider/db/clients';
import { createDatabase } from './app/_oidc-provider/db/instance';
import { createSqlProviderStores } from './app/_oidc-provider/db/stores';
import { registerUser } from './app/_oidc-provider/db/users';
import { UserStore } from './app/_oidc-provider/store';

export async function registerSampleData(): Promise<void> {
  const db = createDatabase();

  // registerClient() replaces an earlier registration of the same client_id,
  // so a restart picks up changed clients. It writes the same rows when the
  // values are the same, so instances that start at the same moment do not
  // conflict.
  for (const client of readRegisteredClients().values()) {
    await registerClient(db, client);
  }

  // E2E and the conformance suite sign in as the development users of
  // store.ts (testuser / otheruser, password "password"). registerUser()
  // hashes the password with PBKDF2, which would slow down every cold start
  // on Vercel, so a user that is already registered is left as it is.
  const { userStore } = createSqlProviderStores(db);
  const developmentUsers = new UserStore();
  for (const username of ['testuser', 'otheruser']) {
    if (await userStore.getClaims(username)) continue;
    const user = developmentUsers.authenticate(username, 'password');
    if (user) await registerUser(db, user);
  }
}

/**
 * OIDC_CLIENTS_JSON (a JSON array of RegisteredClient), or a single
 * confidential client from OIDC_CLIENT_ID / OIDC_CLIENT_SECRET /
 * OIDC_CLIENT_REDIRECT_URI, plus a resource server client when
 * OIDC_RESOURCE_SERVER_CLIENT_ID and OIDC_RESOURCE_SERVER_CLIENT_SECRET are
 * set.
 */
function readRegisteredClients(): ReadonlyMap<string, RegisteredClient> {
  const encoded = process.env.OIDC_CLIENTS_JSON;
  if (encoded) {
    const clients = JSON.parse(encoded) as RegisteredClient[];
    return new Map(clients.map((client) => [client.clientId, client]));
  }

  const clientId = process.env.OIDC_CLIENT_ID ?? process.env.CLIENT_ID ?? 'example-client';
  const clientSecret =
    process.env.OIDC_CLIENT_SECRET ?? process.env.CLIENT_SECRET ?? 'example-secret';
  const clientRedirectUri =
    process.env.OIDC_CLIENT_REDIRECT_URI ??
    process.env.CLIENT_REDIRECT_URI ??
    'http://localhost:3000/callback';

  const clients = new Map<string, RegisteredClient>([
    [
      clientId,
      {
        clientId,
        clientSecret,
        redirectUris: [clientRedirectUri],
        clientType: 'confidential',
        grantTypes: ['authorization_code'],
        tokenEndpointAuthMethod: 'client_secret_post',
        responseTypes: ['code'],
      },
    ],
  ]);

  const resourceServerClientId =
    process.env.OIDC_RESOURCE_SERVER_CLIENT_ID ?? process.env.RESOURCE_SERVER_CLIENT_ID;
  const resourceServerClientSecret =
    process.env.OIDC_RESOURCE_SERVER_CLIENT_SECRET ?? process.env.RESOURCE_SERVER_CLIENT_SECRET;
  const resourceServerRedirectUri =
    process.env.OIDC_RESOURCE_SERVER_REDIRECT_URI ??
    process.env.RESOURCE_SERVER_REDIRECT_URI ??
    'http://localhost:3030/unused-callback';

  if (resourceServerClientId && resourceServerClientSecret) {
    clients.set(resourceServerClientId, {
      clientId: resourceServerClientId,
      clientSecret: resourceServerClientSecret,
      redirectUris: [resourceServerRedirectUri],
      clientType: 'confidential',
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'client_secret_basic',
      responseTypes: ['code'],
    });
  }

  return clients;
}
