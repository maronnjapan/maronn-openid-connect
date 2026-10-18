/**
 * The clients and users of this sample. The generated OP (src/app, --db kv)
 * reads both from the key-value store of src/app/_oidc-provider/db/, so
 * instrumentation.ts registers them there when a server instance starts.
 */
import type { ClientRegistration } from './app/_oidc-provider/config';
import { createDatabase, registerClient } from './app/_oidc-provider/db';
import { registerDevelopmentUsers } from './app/_oidc-provider/development';

export async function registerSampleData(): Promise<void> {
  const db = createDatabase();

  // registerClient() replaces an earlier registration of the same client_id,
  // so a restart picks up changed clients. A client is one record written in
  // one set, so instances that start at the same moment do not conflict.
  for (const client of readRegisteredClients().values()) {
    await registerClient(db, client);
  }

  // E2E and the conformance suite sign in as the development users of
  // development.ts (testuser / otheruser, password "password").
  // registerUser() hashes the password with PBKDF2, which would slow down
  // every cold start on Vercel, so registerDevelopmentUsers() leaves a user
  // that is already registered as it is.
  await registerDevelopmentUsers(db);
}

/**
 * OIDC_CLIENTS_JSON (a JSON array of ClientRegistration), or a single
 * confidential client from OIDC_CLIENT_ID / OIDC_CLIENT_SECRET /
 * OIDC_CLIENT_REDIRECT_URI, plus a resource server client when
 * OIDC_RESOURCE_SERVER_CLIENT_ID and OIDC_RESOURCE_SERVER_CLIENT_SECRET are
 * set.
 */
function readRegisteredClients(): ReadonlyMap<string, ClientRegistration> {
  const encoded = process.env.OIDC_CLIENTS_JSON;
  if (encoded) {
    const clients = JSON.parse(encoded) as ClientRegistration[];
    return new Map(clients.map((client) => [client.clientId, client]));
  }

  const clientId = process.env.OIDC_CLIENT_ID ?? process.env.CLIENT_ID ?? 'example-client';
  const clientSecret =
    process.env.OIDC_CLIENT_SECRET ?? process.env.CLIENT_SECRET ?? 'example-secret';
  const clientRedirectUri =
    process.env.OIDC_CLIENT_REDIRECT_URI ??
    process.env.CLIENT_REDIRECT_URI ??
    'http://localhost:3000/callback';

  const clients = new Map<string, ClientRegistration>([
    [
      clientId,
      {
        clientId,
        clientSecret,
        redirectUris: [clientRedirectUri],
        clientType: 'confidential',
        grantTypes: ['authorization_code'],
        tokenEndpointAuthMethods: ['client_secret_post'],
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
      tokenEndpointAuthMethods: ['client_secret_basic'],
      responseTypes: ['code'],
    });
  }

  return clients;
}
