/**
 * Registered clients in the clients Map of database.ts: the ClientResolver and
 * the ClientKeyResolver the OP uses when no other ones are passed in, and
 * registerClient() to put a client there.
 *
 * findClient() and findClientKeys() read the Map on every call, so a client
 * registered while the OP runs takes effect from the next request.
 */
import {
  createClientKeyResolver as createKeyResolver,
  hashClientSecret,
  type ClientKeyResolver,
  type ClientResolver,
  type TokenClientResolver,
} from '@maronn-openid-connect/core';
import type { ClientRegistration, RegisteredClient } from '../../config.js';
import type { MemoryDatabase } from './database.js';

export function createClientResolver(db: MemoryDatabase): ClientResolver & TokenClientResolver {
  return {
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      const registration = db.clients.get(clientId);
      if (!registration) return null;
      const { keys: _keys, ...client } = registration;
      return { ...client };
    },
  };
}

/**
 * The public keys of the clients (ClientRegistration.keys), one purpose at a
 * time. The OP verifies a signed Request Object with the keys of
 * request_object.
 */
export function createClientKeyResolver(db: MemoryDatabase): ClientKeyResolver {
  return createKeyResolver((clientId) => db.clients.get(clientId)?.keys);
}

/**
 * Put a client into the database, replacing an earlier registration with the
 * same client_id. clientSecret is kept as its hash (hashClientSecret()), and
 * the client authenticates with any of its tokenEndpointAuthMethods.
 *
 *   await registerClient(db, {
 *     clientId: 'my-client',
 *     clientSecret: '...',
 *     redirectUris: ['https://rp.example.com/callback'],
 *     grantTypes: ['authorization_code', 'refresh_token'],
 *     tokenEndpointAuthMethods: ['client_secret_basic'],
 *   });
 */
export async function registerClient(db: MemoryDatabase, client: ClientRegistration): Promise<void> {
  const { clientSecret, ...registration } = client;
  db.clients.set(client.clientId, {
    ...registration,
    ...(clientSecret === undefined ? {} : { clientSecretHash: await hashClientSecret(clientSecret) }),
  });
}
