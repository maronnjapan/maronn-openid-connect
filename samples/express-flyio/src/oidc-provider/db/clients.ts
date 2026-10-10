/**
 * Registered clients on the client tables of db/schema.sql: the ClientResolver
 * the OP uses when no other one is passed in, and registerClient() to put a
 * client into those tables.
 *
 * How the tables become a RegisteredClient (config.ts):
 *
 * - clients.client_type public: no client authentication ('none').
 * - client_secret_basic / client_secret_post: the client's one row of these
 *   decides token_endpoint_auth_method, and its client_secrets.secret is the
 *   clientSecretHash the presented secret is checked against. More than one
 *   such row is a configuration error.
 * - private_key_jwt: its jwks are the public keys of the client, used to
 *   verify signed Request Objects. The token endpoint cannot authenticate with
 *   private_key_jwt yet, and jwks_uri is not fetched.
 * - client_redirect_uris and client_grant_types: redirectUris and grantTypes.
 * - client_scopes and client_authorization_details are not read: scopes.ts
 *   decides the scopes of every client, and authorization_details are not
 *   supported yet.
 * - Metadata without a column (response_types, default_max_age, the ID Token
 *   and UserInfo signing algs) keeps its default.
 */
import {
  hashClientSecret,
  type ClientResolver,
  type JwkSet,
  type TokenClientResolver,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../config.js';
import type { SqlDatabase } from './database.js';

export function createSqlClientResolver(db: SqlDatabase): ClientResolver & TokenClientResolver {
  return {
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      const [client] = await db.all<{ id: string; client_type: string }>({
        sql: 'SELECT id, client_type FROM clients WHERE id = ? AND is_deleted = FALSE',
        params: [clientId],
      });
      if (!client) return null;
      const auths = await db.all<{ client_auth_type: string; secret: string | null; jwks: string | null }>({
        sql:
          'SELECT a.client_auth_type, s.secret, k.jwks FROM client_auths a ' +
          'LEFT JOIN client_secrets s ON s.id = a.id ' +
          'LEFT JOIN client_private_key_jwts k ON k.id = a.id ' +
          'WHERE a.client_id = ? ORDER BY a.id',
        params: [clientId],
      });
      const redirectUris = await db.all<{ value: string }>({
        sql: 'SELECT value FROM client_redirect_uris WHERE client_id = ? ORDER BY id',
        params: [clientId],
      });
      const grantTypes = await db.all<{ grant_type: string }>({
        sql: 'SELECT grant_type FROM client_grant_types WHERE client_id = ? ORDER BY id',
        params: [clientId],
      });

      const registered: RegisteredClient = {
        clientId: client.id,
        clientType: client.client_type === 'public' ? 'public' : 'confidential',
        redirectUris: redirectUris.map((row) => row.value),
      };
      if (grantTypes.length > 0) registered.grantTypes = grantTypes.map((row) => row.grant_type);

      const secretAuths = auths.filter((row) => row.client_auth_type !== 'private_key_jwt');
      if (registered.clientType === 'public') {
        registered.tokenEndpointAuthMethod = 'none';
      } else if (secretAuths.length > 1) {
        throw new Error(
          'Client ' + clientId + ' has more than one client_secret_basic / client_secret_post row in client_auths',
        );
      } else if (secretAuths[0]) {
        registered.tokenEndpointAuthMethod = secretAuths[0].client_auth_type as
          | 'client_secret_basic'
          | 'client_secret_post';
        if (secretAuths[0].secret !== null) registered.clientSecretHash = secretAuths[0].secret;
      }
      // A confidential client without such a row keeps the default
      // client_secret_basic with no secret, so it cannot authenticate.

      const jwks = auths.find((row) => row.jwks !== null)?.jwks;
      if (jwks) registered.jwks = JSON.parse(jwks) as JwkSet;
      return registered;
    },
  };
}

/**
 * Put a client into the client tables, replacing the rows of an earlier
 * registration with the same client_id. Call it from a setup script or at
 * startup, for example for the clients of config.ts:
 *
 *   for (const client of defaultRegisteredClients.values()) {
 *     await registerClient(db, client);
 *   }
 *
 * clientSecret is saved as its hash (hashClientSecret()), and jwks as a
 * private_key_jwt row. The statements run one at a time (SqlDatabase has no
 * transactions), so run it again if it stops halfway.
 */
export async function registerClient(
  db: SqlDatabase,
  client: RegisteredClient & { name?: string },
): Promise<void> {
  const clientType =
    client.clientType ?? (client.tokenEndpointAuthMethod === 'none' ? 'public' : 'confidential');
  await db.run({
    sql:
      'INSERT INTO clients (id, name, client_type, is_deleted) VALUES (?, ?, ?, FALSE) ' +
      'ON CONFLICT (id) DO UPDATE SET name = excluded.name, client_type = excluded.client_type, ' +
      'is_deleted = FALSE',
    params: [client.clientId, client.name ?? null, clientType],
  });

  // Replace the child rows. Secrets and keys go first: they reference
  // client_auths, and SQLite cascades only with foreign keys on.
  const childRows = [
    'DELETE FROM client_secrets WHERE id IN (SELECT id FROM client_auths WHERE client_id = ?)',
    'DELETE FROM client_private_key_jwts WHERE id IN (SELECT id FROM client_auths WHERE client_id = ?)',
    'DELETE FROM client_auths WHERE client_id = ?',
    'DELETE FROM client_redirect_uris WHERE client_id = ?',
    'DELETE FROM client_grant_types WHERE client_id = ?',
  ];
  for (const sql of childRows) {
    await db.run({ sql, params: [client.clientId] });
  }

  const secretHash =
    client.clientSecretHash ??
    (client.clientSecret !== undefined ? await hashClientSecret(client.clientSecret) : undefined);
  const authMethod = client.tokenEndpointAuthMethod ?? 'client_secret_basic';
  if (clientType === 'confidential' && authMethod !== 'none' && secretHash !== undefined) {
    const authId = crypto.randomUUID();
    await db.run({
      sql: 'INSERT INTO client_auths (id, client_id, client_auth_type) VALUES (?, ?, ?)',
      params: [authId, client.clientId, authMethod],
    });
    await db.run({
      sql: 'INSERT INTO client_secrets (id, client_auth_type, secret) VALUES (?, ?, ?)',
      params: [authId, authMethod, secretHash],
    });
  }
  if (client.jwks !== undefined) {
    const authId = crypto.randomUUID();
    await db.run({
      sql: "INSERT INTO client_auths (id, client_id, client_auth_type) VALUES (?, ?, 'private_key_jwt')",
      params: [authId, client.clientId],
    });
    await db.run({
      sql: "INSERT INTO client_private_key_jwts (id, client_auth_type, jwks) VALUES (?, 'private_key_jwt', ?)",
      params: [authId, JSON.stringify(client.jwks)],
    });
  }
  for (const redirectUri of client.redirectUris) {
    await db.run({
      sql: 'INSERT INTO client_redirect_uris (id, client_id, value) VALUES (?, ?, ?)',
      params: [crypto.randomUUID(), client.clientId, redirectUri],
    });
  }
  for (const grantType of client.grantTypes ?? []) {
    await db.run({
      sql: 'INSERT INTO client_grant_types (id, client_id, grant_type) VALUES (?, ?, ?)',
      params: [crypto.randomUUID(), client.clientId, grantType],
    });
  }
}
