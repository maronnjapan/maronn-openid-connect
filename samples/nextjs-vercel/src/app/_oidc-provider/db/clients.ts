/**
 * Registered clients in the key-value store: the ClientResolver the OP uses
 * when no other one is passed in, and registerClient() to put a client into
 * the store.
 *
 * A client is one record (ClientRecord in keys.ts), and this is how it becomes
 * a RegisteredClient (config.ts):
 *
 * - client_type public: no client authentication ('none').
 * - client_auth and private_key_jwt: the methods the client may authenticate
 *   with (tokenEndpointAuthMethods). client_auth is client_secret_basic or
 *   client_secret_post with the clientSecretHash the presented secret is
 *   checked against. private_key_jwt lets the client sign a JWT with one of
 *   its keys instead (OIDC Core 1.0 §9). A confidential client with neither
 *   keeps the default client_secret_basic with no secret, so it cannot
 *   authenticate.
 * - keys.clientJwks(): jwks, the client's public keys (ClientJwksRecord). They
 *   verify its private_key_jwt assertions and its signed Request Objects.
 * - redirect_uris, grant_types and scopes: redirectUris, grantTypes and scope.
 *   A request for a scope outside scope is rejected with invalid_scope
 *   (validateClientScope() in core). A client without scopes may request every
 *   scope the OP accepts.
 * - Metadata without a field (response_types, default_max_age, the ID Token
 *   and UserInfo signing algs) keeps its default.
 *
 * findClient() reads both records on every call, so a change made while the
 * OP runs takes effect from the next request. That is how a client starts
 * using private_key_jwt or rotates its keys, without a restart: set
 * private_key_jwt to true in its client record, and put its public keys into
 * keys.clientJwks() as { "keys": [ <JWK>, ... ] }.
 */
import {
  hashClientSecret,
  selectRegisteredClientAuthMethods,
  type ClientResolver,
  type Jwk,
  type TokenClientResolver,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../config';
import { readRecord, writeRecord, type KvDatabase } from './database';
import { keys, type ClientJwksRecord, type ClientRecord } from './keys';

export function createKvClientResolver(db: KvDatabase): ClientResolver & TokenClientResolver {
  return {
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      const client = await readRecord<ClientRecord>(db, keys.client(clientId));
      if (!client || client.is_deleted) return null;
      const jwks = await readRecord<ClientJwksRecord>(db, keys.clientJwks(clientId));
      const registered: RegisteredClient = {
        clientId,
        clientType: client.client_type === 'public' ? 'public' : 'confidential',
        redirectUris: client.redirect_uris,
      };
      if (client.grant_types.length > 0) registered.grantTypes = client.grant_types;
      if (client.scopes.length > 0) registered.scope = client.scopes;
      if (jwks && jwks.keys.length > 0) registered.jwks = { keys: jwks.keys as unknown as Jwk[] };
      if (registered.clientType === 'public') {
        registered.tokenEndpointAuthMethod = 'none';
      } else {
        const methods = [
          ...(client.client_auth ? [client.client_auth.client_auth_type] : []),
          ...(client.private_key_jwt ? (['private_key_jwt'] as const) : []),
        ];
        if (methods.length > 0) registered.tokenEndpointAuthMethods = methods;
        if (client.client_auth) registered.clientSecretHash = client.client_auth.secret;
      }
      return registered;
    },
  };
}

/**
 * Put a client into the store, replacing an earlier registration with the
 * same client_id. Call it from a setup script or at startup, for example for
 * the clients of config.ts:
 *
 *   for (const client of defaultRegisteredClients.values()) {
 *     await registerClient(db, client);
 *   }
 *
 * The whole client is one record written in one set, so every instance of the
 * OP may register its clients at startup, even at the same moment.
 * clientSecret is saved as its hash (hashClientSecret()).
 *
 * private_key_jwt and the keys of jwks are only ever added here: the record
 * keeps private_key_jwt once it is true, and a key of jwks missing from
 * keys.clientJwks() is appended to it. Both may be managed in the store while
 * the OP runs (see the top of this file), and registering the client again at
 * the next start keeps them. To remove one, change it in the store, and drop
 * it from the client passed here too, or the next registration adds it back.
 */
export async function registerClient(
  db: KvDatabase,
  client: RegisteredClient & { name?: string },
): Promise<void> {
  const clientType =
    client.clientType ?? (client.tokenEndpointAuthMethod === 'none' ? 'public' : 'confidential');
  const secretHash =
    client.clientSecretHash ??
    (client.clientSecret !== undefined ? await hashClientSecret(client.clientSecret) : undefined);
  const methods = clientType === 'confidential' ? selectRegisteredClientAuthMethods(client) : [];
  const secretMethod = methods.find(
    (method): method is 'client_secret_basic' | 'client_secret_post' =>
      method === 'client_secret_basic' || method === 'client_secret_post',
  );
  const current = await readRecord<ClientRecord>(db, keys.client(client.clientId));
  const record: ClientRecord = {
    name: client.name ?? null,
    client_type: clientType,
    is_deleted: false,
    client_auth:
      secretMethod !== undefined && secretHash !== undefined
        ? { client_auth_type: secretMethod, secret: secretHash }
        : null,
    redirect_uris: [...client.redirectUris],
    grant_types: [...(client.grantTypes ?? [])],
    scopes: [...(client.scope ?? [])],
  };
  if (methods.includes('private_key_jwt') || current?.private_key_jwt === true) {
    record.private_key_jwt = true;
  }
  await writeRecord(db, keys.client(client.clientId), record);

  const listedKeys = (client.jwks?.keys ?? []) as unknown as Array<Record<string, unknown>>;
  if (listedKeys.length > 0) {
    const stored = (await readRecord<ClientJwksRecord>(db, keys.clientJwks(client.clientId)))?.keys ?? [];
    const storedJson = new Set(stored.map((key) => JSON.stringify(key)));
    const added = listedKeys.filter((key) => !storedJson.has(JSON.stringify(key)));
    if (added.length > 0) {
      const record: ClientJwksRecord = { keys: [...stored, ...added] };
      await writeRecord(db, keys.clientJwks(client.clientId), record);
    }
  }
}
