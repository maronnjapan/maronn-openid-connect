/**
 * Registered clients on the client tables of db/schema.sql: the ClientResolver
 * the OP uses when no other one is passed in, and registerClient() to put a
 * client into those tables.
 *
 * How the tables become a RegisteredClient (config.ts):
 *
 * - clients.client_type public: no client authentication ('none').
 * - client_auths: the methods the client may authenticate with
 *   (tokenEndpointAuthMethods). A client_secret_basic or client_secret_post
 *   row carries the clientSecretHash the presented secret is checked against
 *   (client_secrets); more than one of those per client is a configuration
 *   error. A private_key_jwt row lets the client sign a JWT with one of the
 *   keys of client_jwks instead (OIDC Core 1.0 §9).
 * - client_jwks: jwks, the client's public keys. They verify its
 *   private_key_jwt assertions and its signed Request Objects.
 * - client_redirect_uris, client_grant_types and client_scopes: redirectUris,
 *   grantTypes and scope. A request for a scope outside scope is rejected with
 *   invalid_scope (validateClientScope() in core). A client without
 *   client_scopes rows may request every scope the OP accepts.
 * - Metadata without a column (response_types, default_max_age, the ID Token
 *   and UserInfo signing algs) keeps its default.
 *
 * findClient() reads the tables on every call, so a row inserted or deleted
 * while the OP runs takes effect from the next request. That is how a client
 * starts using private_key_jwt or rotates its keys, without a restart:
 *
 *   INSERT INTO client_auths (id, client_id, client_auth_type)
 *     VALUES ('my-client:private_key_jwt', 'my-client', 'private_key_jwt');
 *   INSERT INTO client_jwks (id, client_id, jwk)
 *     VALUES ('my-client:2026-10', 'my-client', '{"kty":"RSA","kid":"2026-10","n":"...","e":"AQAB"}');
 *
 * Keep the client_secret_basic / client_secret_post row while the client
 * moves over, and delete it once the client only signs JWTs. Store public keys
 * only: a client_jwks row is one JWK (RFC 7517) without d or any other private
 * member.
 */
import {
  hashClientSecret,
  selectRegisteredClientAuthMethods,
  type ClientResolver,
  type Jwk,
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
      const auths = await db.all<{ client_auth_type: string; secret: string | null }>({
        sql:
          'SELECT a.client_auth_type, s.secret FROM client_auths a ' +
          'LEFT JOIN client_secrets s ON s.id = a.id WHERE a.client_id = ? ORDER BY a.id',
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
      const scopes = await db.all<{ value: string }>({
        sql: 'SELECT value FROM client_scopes WHERE client_id = ? ORDER BY id',
        params: [clientId],
      });
      const keys = await db.all<{ jwk: string }>({
        sql: 'SELECT jwk FROM client_jwks WHERE client_id = ? ORDER BY id',
        params: [clientId],
      });

      const registered: RegisteredClient = {
        clientId: client.id,
        clientType: client.client_type === 'public' ? 'public' : 'confidential',
        redirectUris: redirectUris.map((row) => row.value),
      };
      if (grantTypes.length > 0) registered.grantTypes = grantTypes.map((row) => row.grant_type);
      if (scopes.length > 0) registered.scope = scopes.map((row) => row.value);
      if (keys.length > 0) registered.jwks = { keys: keys.map((row) => parseJwk(clientId, row.jwk)) };

      if (registered.clientType === 'public') {
        registered.tokenEndpointAuthMethod = 'none';
      } else if (auths.length > 0) {
        const secretAuths = auths.filter((auth) => auth.client_auth_type !== 'private_key_jwt');
        if (secretAuths.length > 1) {
          throw new Error('Client ' + clientId + ' has more than one client_secret method in client_auths');
        }
        registered.tokenEndpointAuthMethods = auths.map((auth) => auth.client_auth_type as ClientAuthType);
        if (secretAuths[0] && secretAuths[0].secret !== null) {
          registered.clientSecretHash = secretAuths[0].secret;
        }
      }
      // A confidential client without a client_auths row keeps the default
      // client_secret_basic with no secret, so it cannot authenticate.
      return registered;
    },
  };
}

type ClientAuthType = 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt';

/** A client_jwks row holds one public JWK as a JSON object. */
function parseJwk(clientId: string, json: string): Jwk {
  let jwk: unknown;
  try {
    jwk = JSON.parse(json);
  } catch {
    jwk = undefined;
  }
  if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) {
    throw new Error('Client ' + clientId + ' has a client_jwks row that is not a JSON JWK');
  }
  return jwk as Jwk;
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
 * Registering a client again with the same values leaves its rows as they
 * are, so every instance of the OP may register its clients at startup, even
 * at the same moment: each row's id comes from the values it holds, so two
 * registrations write the same rows instead of adding copies. When the values
 * change, the new redirect URIs, grant types and scopes go in before the old
 * ones are removed, so requests in between still find the client.
 *
 * clientSecret is saved as its hash (hashClientSecret()). The statements run
 * one at a time (SqlDatabase has no transactions), so run it again if it stops
 * halfway.
 *
 * The private_key_jwt row and the client_jwks rows are only ever added here:
 * registerClient() writes the private_key_jwt row when the client lists that
 * method and a client_jwks row for each key of jwks, and never deletes either.
 * Those rows may be managed in the database while the OP runs (see the top of
 * this file), and registering the client again at the next start keeps them.
 * To remove one, delete it in the database, and drop it from the client
 * passed here too, or the next registration adds it back.
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

  const secretHash =
    client.clientSecretHash ??
    (client.clientSecret !== undefined ? await hashClientSecret(client.clientSecret) : undefined);
  const methods = clientType === 'confidential' ? selectRegisteredClientAuthMethods(client) : [];
  const secretMethod = methods.find(
    (method): method is 'client_secret_basic' | 'client_secret_post' =>
      method === 'client_secret_basic' || method === 'client_secret_post',
  );
  const auth =
    secretMethod !== undefined && secretHash !== undefined
      ? { id: await childRowId(client.clientId, 'client_auths', secretMethod), method: secretMethod, secretHash }
      : undefined;
  const authIds = auth ? [auth.id] : [];
  // The rows of another secret method go first, so the client never has two
  // client_secret rows. Secrets go before their client_auths rows: they
  // reference them, and SQLite cascades only with foreign keys on. The
  // private_key_jwt row is left alone (see above).
  await db.run({
    sql: exceptIds(
      "DELETE FROM client_secrets WHERE id IN (SELECT id FROM client_auths WHERE client_id = ? AND client_auth_type <> 'private_key_jwt')",
      authIds,
    ),
    params: [client.clientId, ...authIds],
  });
  await db.run({
    sql: exceptIds("DELETE FROM client_auths WHERE client_id = ? AND client_auth_type <> 'private_key_jwt'", authIds),
    params: [client.clientId, ...authIds],
  });
  if (auth) {
    await db.run({
      sql: 'INSERT INTO client_auths (id, client_id, client_auth_type) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING',
      params: [auth.id, client.clientId, auth.method],
    });
    await db.run({
      sql:
        'INSERT INTO client_secrets (id, client_auth_type, secret) VALUES (?, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET secret = excluded.secret',
      params: [auth.id, auth.method, auth.secretHash],
    });
  }
  if (methods.includes('private_key_jwt')) {
    await db.run({
      sql: 'INSERT INTO client_auths (id, client_id, client_auth_type) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING',
      params: [await childRowId(client.clientId, 'client_auths', 'private_key_jwt'), client.clientId, 'private_key_jwt'],
    });
  }
  for (const key of client.jwks?.keys ?? []) {
    const jwk = JSON.stringify(key);
    await db.run({
      sql: 'INSERT INTO client_jwks (id, client_id, jwk) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING',
      params: [await childRowId(client.clientId, 'client_jwks', jwk), client.clientId, jwk],
    });
  }

  const childValues: Array<[table: string, column: string, values: readonly string[]]> = [
    ['client_redirect_uris', 'value', client.redirectUris],
    ['client_grant_types', 'grant_type', client.grantTypes ?? []],
    ['client_scopes', 'value', client.scope ?? []],
  ];
  for (const [table, column, values] of childValues) {
    const ids: string[] = [];
    for (const value of values) {
      const id = await childRowId(client.clientId, table, value);
      ids.push(id);
      await db.run({
        sql: 'INSERT INTO ' + table + ' (id, client_id, ' + column + ') VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING',
        params: [id, client.clientId, value],
      });
    }
    await db.run({
      sql: exceptIds('DELETE FROM ' + table + ' WHERE client_id = ?', ids),
      params: [client.clientId, ...ids],
    });
  }
}

/**
 * The id of a row under a client: the SHA-256 (hex) of the client_id, the
 * table and the value the row holds, so the same value always maps to the
 * same row.
 */
async function childRowId(clientId: string, table: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([clientId, table, value])),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A DELETE of a client's rows, narrowed to the rows whose id is not in keep. */
function exceptIds(sql: string, keep: readonly string[]): string {
  return keep.length === 0 ? sql : sql + ' AND id NOT IN (' + keep.map(() => '?').join(', ') + ')';
}
