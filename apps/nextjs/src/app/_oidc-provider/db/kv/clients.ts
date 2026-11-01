/**
 * Registered clients in the key-value store: the ClientResolver and the
 * ClientKeyResolver the OP uses when no other ones are passed in, and
 * registerClient() to put a client into the store.
 *
 * A client is one record (ClientRecord in keys.ts), and this is how it becomes
 * a RegisteredClient (config.ts):
 *
 * - client_type public: no client authentication
 *   (tokenEndpointAuthMethods ['none']).
 * - client_auths: the methods the client may authenticate with
 *   (tokenEndpointAuthMethods: client_secret_basic, client_secret_post or
 *   both), and the clientSecretHash the presented secret is checked against
 *   whichever of them the request uses. A client has one client_secret
 *   (RFC 7591 §2), so entries with different secrets are a configuration
 *   error. A confidential client without entries keeps the default
 *   client_secret_basic with no secret, so it cannot authenticate.
 * - redirect_uris, grant_types and scopes: redirectUris, grantTypes and scope.
 *   A request for a scope outside scope is rejected with invalid_scope
 *   (validateClientScope() in core). A client without scopes may request every
 *   scope the OP accepts.
 * - response_types: responseTypes, the response types the client may use at
 *   the authorization endpoint (id_token and id_token token for the Implicit
 *   Flow). A client without them may use code only.
 * - request_uris: requestUris, the request_uri values the client
 *   pre-registered (OIDC Core 1.0 §6.2). While the OP requires registration,
 *   a client without them cannot pass request_uri.
 * - Metadata without a field (default_max_age, the ID Token and UserInfo
 *   signing algs, request_object_signing_alg) keeps its default.
 *
 * The client's public keys (keys.clientJwks(), one record per purpose) are not
 * part of the RegisteredClient. A process that needs them asks the
 * ClientKeyResolver for the keys of its own purpose (ClientKeyResolver in
 * core): the OP verifies signed Request Objects with those of request_object,
 * and a process a project adds reads its own purpose (private_key_jwt or dpop,
 * for one).
 *
 * findClient() and findClientKeys() read the store on every call, so a change
 * made while the OP runs takes effect from the next request. That is how a
 * client's keys are added or rotated without a restart: write them into
 * keys.clientJwks(client_id, purpose) as { "keys": [ <JWK>, ... ] }.
 */
import {
  hashClientSecret,
  isPublicTokenClient,
  selectRegisteredClientAuthMethods,
  type ClientKeyPurpose,
  type ClientKeyResolver,
  type ClientResolver,
  type Jwk,
  type JwkSet,
  type TokenClientResolver,
} from '@maronn-openid-connect/core';
import type { ClientRegistration, RegisteredClient } from '../../config';
import { readRecord, writeRecord, type KvDatabase } from './database';
import { keys, type ClientAuthRecord, type ClientJwksRecord, type ClientRecord } from './keys';

export function createClientResolver(db: KvDatabase): ClientResolver & TokenClientResolver {
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
      if ((client.response_types ?? []).length > 0) registered.responseTypes = client.response_types;
      if ((client.request_uris ?? []).length > 0) registered.requestUris = client.request_uris;
      if (registered.clientType === 'public') {
        registered.tokenEndpointAuthMethods = ['none'];
      } else if (client.client_auths[0]) {
        // A client has one client_secret (RFC 7591 §2), whichever method
        // presents it.
        const secret = client.client_auths[0].secret;
        if (client.client_auths.some((auth) => auth.secret !== secret)) {
          throw new Error('Client ' + clientId + ' has client_auths entries with different secrets');
        }
        registered.tokenEndpointAuthMethods = client.client_auths.map((auth) => auth.client_auth_type);
        registered.clientSecretHash = secret;
      }
      // A confidential client without client_auths keeps the default
      // client_secret_basic with no secret, so it cannot authenticate.
      return registered;
    },
  };
}

/**
 * The public keys of keys.clientJwks() for one purpose at a time: the
 * ClientKeyResolver the OP uses when no other one is passed in. The OP
 * verifies a signed Request Object with the keys of request_object. A deleted
 * client (is_deleted) has no keys.
 */
export function createClientKeyResolver(db: KvDatabase): ClientKeyResolver {
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
 * same client_id. Call it from a setup script or at startup (register() of
 * instrumentation.ts), with the database of db/ (createDatabase() of
 * db/index.ts) and a ClientRegistration (config.ts):
 *
 *   const db = createDatabase();
 *   await registerClient(db, {
 *     clientId: 'my-client',
 *     clientSecret: '...',
 *     redirectUris: ['https://client.example.com/callback'],
 *     grantTypes: ['authorization_code', 'refresh_token'],
 *     tokenEndpointAuthMethods: ['client_secret_basic'],
 *   });
 *
 * The whole client is one record written in one set, so every instance of the
 * OP may register its clients at startup, even at the same moment.
 * clientSecret is saved as its hash (hashClientSecret()).
 *
 * Each method of tokenEndpointAuthMethods becomes an entry of client_auths,
 * all of them with the same secret.
 *
 * The keys of keys (ClientRegistration.keys) go into keys.clientJwks() of
 * their purpose. They are only ever added here: a key missing from its
 * purpose's keys.clientJwks() is appended to it, and none is removed, so the
 * keys may be managed in the store while the OP runs (see the top of this
 * file), and registering the client again at the next start keeps them. To
 * remove a key, change it in the store, and drop it from the client passed
 * here too, or the next registration adds it back.
 */
export async function registerClient(
  db: KvDatabase,
  client: ClientRegistration & { name?: string },
): Promise<void> {
  const clientType = client.clientType ?? (isPublicTokenClient(client) ? 'public' : 'confidential');
  const secretHash =
    client.clientSecretHash ??
    (client.clientSecret !== undefined ? await hashClientSecret(client.clientSecret) : undefined);
  const methods =
    clientType === 'confidential'
      ? selectRegisteredClientAuthMethods(client).filter(
        (method): method is ClientAuthRecord['client_auth_type'] =>
          method === 'client_secret_basic' || method === 'client_secret_post',
      )
      : [];
  const record: ClientRecord = {
    name: client.name ?? null,
    client_type: clientType,
    is_deleted: false,
    client_auths:
      secretHash === undefined ? [] : methods.map((method) => ({ client_auth_type: method, secret: secretHash })),
    redirect_uris: [...client.redirectUris],
    grant_types: [...(client.grantTypes ?? [])],
    scopes: [...(client.scope ?? [])],
    response_types: [...(client.responseTypes ?? [])],
    request_uris: [...(client.requestUris ?? [])],
  };
  await writeRecord(db, keys.client(client.clientId), record);

  for (const [purpose, keySet] of Object.entries(client.keys ?? {})) {
    const listedKeys = (keySet?.keys ?? []) as unknown as Array<Record<string, unknown>>;
    if (listedKeys.length === 0) continue;
    const recordKey = keys.clientJwks(client.clientId, purpose);
    const stored = (await readRecord<ClientJwksRecord>(db, recordKey))?.keys ?? [];
    const storedJson = new Set(stored.map((jwk) => JSON.stringify(jwk)));
    const added = listedKeys.filter((jwk) => !storedJson.has(JSON.stringify(jwk)));
    if (added.length > 0) {
      const jwksRecord: ClientJwksRecord = { keys: [...stored, ...added] };
      await writeRecord(db, recordKey, jwksRecord);
    }
  }
}
