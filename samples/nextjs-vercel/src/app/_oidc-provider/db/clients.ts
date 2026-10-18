/**
 * Registered clients in the key-value store: the ClientResolver and the
 * ClientKeyResolver the OP uses when no other ones are passed in, and
 * registerClient() to put a client into the store.
 *
 * A client is one record (ClientRecord in keys.ts), and this is how it becomes
 * a RegisteredClient (config.ts):
 *
 * - client_type public: no client authentication ('none').
 * - client_auth and private_key_jwt: the methods the client may authenticate
 *   with (tokenEndpointAuthMethods). client_auth is client_secret_basic or
 *   client_secret_post with the clientSecretHash the presented secret is
 *   checked against. private_key_jwt lets the client sign a JWT with one of
 *   its keys of the private_key_jwt purpose instead (OIDC Core 1.0 §9). A
 *   confidential client with neither keeps the default client_secret_basic
 *   with no secret, so it cannot authenticate.
 * - redirect_uris, grant_types and scopes: redirectUris, grantTypes and scope.
 *   A request for a scope outside scope is rejected with invalid_scope
 *   (validateClientScope() in core). A client without scopes may request every
 *   scope the OP accepts.
 * - Metadata without a field (response_types, default_max_age, the ID Token
 *   and UserInfo signing algs) keeps its default.
 *
 * The client's public keys (keys.clientJwks(), one record per purpose) are not
 * part of the RegisteredClient. Each process that needs them asks the
 * ClientKeyResolver for the keys of its own purpose (ClientKeyResolver in
 * core): private_key_jwt for client assertions, request_object for signed
 * Request Objects, and another purpose (dpop, for one) for a process added
 * later.
 *
 * findClient() and findClientKeys() read the store on every call, so a change
 * made while the OP runs takes effect from the next request. That is how a
 * client starts using private_key_jwt or rotates its keys, without a restart:
 * set private_key_jwt to true in its client record, and put its public keys
 * into keys.clientJwks(client_id, 'private_key_jwt') as
 * { "keys": [ <JWK>, ... ] }.
 */
import {
  JWKS_CLIENT_KEY_PURPOSES,
  hashClientSecret,
  selectRegisteredClientAuthMethods,
  type ClientKeyPurpose,
  type ClientKeyResolver,
  type ClientResolver,
  type Jwk,
  type JwkSet,
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
      const registered: RegisteredClient = {
        clientId,
        clientType: client.client_type === 'public' ? 'public' : 'confidential',
        redirectUris: client.redirect_uris,
      };
      if (client.grant_types.length > 0) registered.grantTypes = client.grant_types;
      if (client.scopes.length > 0) registered.scope = client.scopes;
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
 * The public keys of keys.clientJwks() for one purpose at a time: the
 * ClientKeyResolver the OP uses when no other one is passed in. private_key_jwt
 * reads the record of the private_key_jwt purpose and a signed Request Object
 * that of request_object. A deleted client (is_deleted) has no keys.
 */
export function createKvClientKeyResolver(db: KvDatabase): ClientKeyResolver {
  return {
    async findClientKeys(clientId: string, purpose: ClientKeyPurpose): Promise<JwkSet> {
      const client = await readRecord<ClientRecord>(db, keys.client(clientId));
      if (!client || client.is_deleted) return { keys: [] };
      const record = await readRecord<ClientJwksRecord>(db, keys.clientJwks(clientId, purpose));
      return { keys: [...((record?.keys ?? []) as unknown as Jwk[])] };
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
 * jwks is the jwks of client registration (RFC 7591 §2): one set of keys for
 * every purpose it covers (JWKS_CLIENT_KEY_PURPOSES in core: private_key_jwt
 * and request_object). Its keys go into keys.clientJwks() of each of those
 * purposes. Keys for another purpose go into the store directly.
 *
 * private_key_jwt and the keys of jwks are only ever added here: the record
 * keeps private_key_jwt once it is true, and a key of jwks missing from a
 * purpose's keys.clientJwks() is appended to it. Both may be managed in the
 * store while the OP runs (see the top of this file), and registering the
 * client again at the next start keeps them. To remove one, change it in the
 * store, and drop it from the client passed here too, or the next
 * registration adds it back.
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
  if (listedKeys.length === 0) return;
  for (const purpose of JWKS_CLIENT_KEY_PURPOSES) {
    const recordKey = keys.clientJwks(client.clientId, purpose);
    const stored = (await readRecord<ClientJwksRecord>(db, recordKey))?.keys ?? [];
    const storedJson = new Set(stored.map((jwk) => JSON.stringify(jwk)));
    const added = listedKeys.filter((jwk) => !storedJson.has(JSON.stringify(jwk)));
    if (added.length > 0) {
      const record: ClientJwksRecord = { keys: [...stored, ...added] };
      await writeRecord(db, recordKey, record);
    }
  }
}
