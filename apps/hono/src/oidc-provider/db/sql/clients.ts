/**
 * Registered clients on the client tables of schema.sql: the ClientResolver
 * and the ClientKeyResolver the OP uses when no other ones are passed in, and
 * registerClient() to put a client into those tables.
 *
 * How the tables become a RegisteredClient (config.ts):
 *
 * - clients.client_type public: no client authentication
 *   (tokenEndpointAuthMethods ['none']).
 * - client_auths and client_secrets: the methods the client may authenticate
 *   with (tokenEndpointAuthMethods: client_secret_basic, client_secret_post,
 *   private_key_jwt, or several of them), and the clientSecretHash the
 *   presented secret is checked against whichever secret method the request
 *   uses. A client has one client_secret (RFC 7591 §2), so secret-method rows
 *   of one client with different secrets are a configuration error. A
 *   private_key_jwt row has no secret: the client assertion (OIDC Core 1.0 §9)
 *   is verified with the client_jwks keys of the private_key_jwt purpose, or
 *   the keys of the jwks_uri.
 * - client_redirect_uris, client_grant_types and client_scopes: redirectUris,
 *   grantTypes and scope. A request for a scope outside scope is rejected with
 *   invalid_scope (validateClientScope() in core). A client without
 *   client_scopes rows may request every scope the OP accepts.
 * - client_response_types: responseTypes, the response types the client may
 *   use at the authorization endpoint (id_token and id_token token for the
 *   Implicit Flow). A client without rows may use code only.
 * - client_request_uris: requestUris, the request_uri values the client uses
 *   (OIDC Core 1.0 §6.2).
 * - The single-valued metadata columns of clients, each left out of the
 *   RegisteredClient when NULL (OIDC Dynamic Client Registration 1.0 §2):
 *   jwks_uri is jwksUri, the jwks_uri the OP fetches the client's keys from
 *   (RFC 7591 §2); a client with one gets the keys of its jwks_uri, not those
 *   of client_jwks, for the purposes of clientJwksUriPurposes.
 *   request_object_signing_alg is requestObjectSigningAlg, the alg every
 *   Request Object of the client must be signed with, and
 *   token_endpoint_auth_signing_alg is tokenEndpointAuthSigningAlg, the alg
 *   every private_key_jwt client assertion must be signed with. name,
 *   logo_uri, policy_uri, tos_uri and client_uri are clientName, logoUri,
 *   policyUri, tosUri and clientUri, what the login and consent screens show.
 * - Metadata without a column (default_max_age, the ID Token and UserInfo
 *   signing algs) keeps its default.
 *
 * The client's public keys (client_jwks) are not part of the RegisteredClient.
 * A process that needs them asks the ClientKeyResolver for the keys of its own
 * purpose (ClientKeyResolver in core): the OP verifies signed Request Objects
 * with those of request_object and client assertions with those of
 * private_key_jwt, and a process a project adds reads its own purpose (dpop,
 * for one).
 *
 * findClient() and findClientKeys() read the tables on every call, so a row
 * inserted or deleted while the OP runs takes effect from the next request.
 * That is how a client's keys are added or rotated without a restart:
 *
 *   INSERT INTO client_jwks (id, client_id, purpose, jwk)
 *     VALUES ('my-client:request_object:2026-10', 'my-client', 'request_object',
 *             '{"kty":"RSA","kid":"2026-10","n":"...","e":"AQAB"}');
 *
 * Store public keys only: a client_jwks row is one JWK (RFC 7517) without d or
 * any other private member.
 */
import {
  hashClientSecret,
  isPublicTokenClient,
  selectRegisteredClientAuthMethods,
  type ClientAuthMethod,
  type ClientKeyPurpose,
  type ClientKeyResolver,
  type ClientResolver,
  type Jwk,
  type JwkSet,
  type TokenClientResolver,
} from '@maronn-openid-connect/core';
import { assertClientJwksUriRegistration } from '../../client-jwks-uri.js';
import type { ClientRegistration, RegisteredClient } from '../../config.js';
import type { SqlDatabase } from './database.js';

/**
 * `client_id` でクライアントを取得するリゾルバを返す。
 *
 * 返すリゾルバの `findClient()` は、呼ばれるたびにクライアントのテーブルを読み、`RegisteredClient` に変換して返す。
 * `clients` に行がないクライアントと、`is_deleted` が真のクライアントには `null` を返す。
 * 認可エンドポイントとトークンエンドポイントは、このリゾルバでクライアントを取得する。
 * 公開鍵は返さない（{@link createClientKeyResolver} のリゾルバが返す）。
 *
 * テーブルの値は、次のように `RegisteredClient` に移す。
 * - `clients.client_type` が `public` なら、`tokenEndpointAuthMethods` を `['none']` にする（クライアント認証をしない）。
 * - コンフィデンシャルクライアントなら、`client_auths` の行の方式（`client_secret_basic`、`client_secret_post`、`private_key_jwt`）を `tokenEndpointAuthMethods` に、シークレットの方式の行の `client_secrets` のシークレットがあればそれを `clientSecretHash` にする。
 * - `client_auths` の行がないコンフィデンシャルクライアントは、既定の `client_secret_basic` のままシークレットを持たないので、認証できない。
 * - `client_redirect_uris` の行は `redirectUris` にする。
 * - `client_grant_types`、`client_scopes`、`client_response_types`、`client_request_uris` の行は、あればそれぞれ `grantTypes`、`scope`、`responseTypes`、`requestUris` にし、なければ設定せずに既定の扱いに任せる。
 * - `clients` の `jwks_uri`、`request_object_signing_alg`、`token_endpoint_auth_signing_alg`、`name`、`logo_uri`、`policy_uri`、`tos_uri`、`client_uri` の列は、NULL でなければそれぞれ `jwksUri`、`requestObjectSigningAlg`、`tokenEndpointAuthSigningAlg`、`clientName`、`logoUri`、`policyUri`、`tosUri`、`clientUri` にする。
 *
 * @throws {Error} 返したリゾルバの `findClient()` が、シークレットの方式の `client_auths` の行どうしでシークレットが違うクライアントを読んだとき
 */
export function createClientResolver(db: SqlDatabase): ClientResolver & TokenClientResolver {
  return {
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      const [client] = await db.all<{
        id: string;
        name: string | null;
        client_type: string;
        jwks_uri: string | null;
        request_object_signing_alg: string | null;
        token_endpoint_auth_signing_alg: string | null;
        logo_uri: string | null;
        policy_uri: string | null;
        tos_uri: string | null;
        client_uri: string | null;
      }>({
        sql:
          'SELECT id, name, client_type, jwks_uri, request_object_signing_alg, token_endpoint_auth_signing_alg, ' +
          'logo_uri, policy_uri, tos_uri, client_uri FROM clients WHERE id = ? AND is_deleted = FALSE',
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
      const responseTypes = await db.all<{ response_type: string }>({
        sql: 'SELECT response_type FROM client_response_types WHERE client_id = ? ORDER BY id',
        params: [clientId],
      });
      const requestUris = await db.all<{ value: string }>({
        sql: 'SELECT value FROM client_request_uris WHERE client_id = ? ORDER BY id',
        params: [clientId],
      });

      const registered: RegisteredClient = {
        clientId: client.id,
        clientType: client.client_type === 'public' ? 'public' : 'confidential',
        redirectUris: redirectUris.map((row) => row.value),
      };
      if (grantTypes.length > 0) registered.grantTypes = grantTypes.map((row) => row.grant_type);
      if (scopes.length > 0) registered.scope = scopes.map((row) => row.value);
      if (responseTypes.length > 0) registered.responseTypes = responseTypes.map((row) => row.response_type);
      if (client.jwks_uri !== null) registered.jwksUri = client.jwks_uri;
      if (client.request_object_signing_alg !== null) {
        registered.requestObjectSigningAlg = client.request_object_signing_alg;
      }
      if (client.token_endpoint_auth_signing_alg !== null) {
        registered.tokenEndpointAuthSigningAlg = client.token_endpoint_auth_signing_alg;
      }
      if (requestUris.length > 0) registered.requestUris = requestUris.map((row) => row.value);
      if (client.name !== null) registered.clientName = client.name;
      if (client.logo_uri !== null) registered.logoUri = client.logo_uri;
      if (client.policy_uri !== null) registered.policyUri = client.policy_uri;
      if (client.tos_uri !== null) registered.tosUri = client.tos_uri;
      if (client.client_uri !== null) registered.clientUri = client.client_uri;

      if (registered.clientType === 'public') {
        registered.tokenEndpointAuthMethods = ['none'];
      } else if (auths.length > 0) {
        registered.tokenEndpointAuthMethods = auths.map((auth) => auth.client_auth_type as ClientAuthType);
        // `private_key_jwt` の行はシークレットを持たない（OIDC Core 1.0 §9）ので、シークレットの方式の行だけを調べる。
        const secretAuths = auths.filter((auth) => auth.client_auth_type !== 'private_key_jwt');
        if (secretAuths[0]) {
          // クライアントの `client_secret` は、どのシークレットの方式で提示されても一つである（RFC 7591 §2）。
          // そのため、最初の行とシークレットが違う行があれば、設定の誤りとして投げる。
          const secret = secretAuths[0].secret;
          if (secretAuths.some((auth) => auth.secret !== secret)) {
            throw new Error('Client ' + clientId + ' has client_auths rows with different secrets');
          }
          if (secret !== null) registered.clientSecretHash = secret;
        }
      }
      // どの方式の行もないコンフィデンシャルクライアントは、既定の `client_secret_basic` のままシークレットを持たないので、認証できない。
      return registered;
    },
  };
}

/** The client_auth_type of a client_auths row: every token endpoint auth method but none. */
type ClientAuthType = Exclude<ClientAuthMethod, 'none'>;

/**
 * クライアントの公開鍵を用途別に取得するリゾルバを返す。
 *
 * 返すリゾルバの `findClientKeys()` は、呼ばれるたびに `client_jwks` から指定された用途の行を読み、各行の JWK を並べた JWK Set を返す。
 * 削除済み（`is_deleted`）のクライアントと、用途の行がないクライアントには、`keys` が空の JWK Set を返す。
 * OP は、署名付きのリクエストオブジェクトを `request_object` の用途の鍵で検証する。
 *
 * OP は、ほかのリゾルバを渡されなければこのリゾルバを使う。
 *
 * @throws {Error} 返したリゾルバの `findClientKeys()` が、JSON のオブジェクトでない `jwk` の行を読んだとき（`parseJwk()`）
 */
export function createClientKeyResolver(db: SqlDatabase): ClientKeyResolver {
  return {
    async findClientKeys(clientId: string, purpose: ClientKeyPurpose): Promise<JwkSet> {
      const rows = await db.all<{ jwk: string }>({
        sql:
          'SELECT k.jwk FROM client_jwks k JOIN clients c ON c.id = k.client_id ' +
          'WHERE k.client_id = ? AND k.purpose = ? AND c.is_deleted = FALSE ORDER BY k.id',
        params: [clientId, purpose],
      });
      return { keys: rows.map((row) => parseJwk(clientId, row.jwk)) };
    },
  };
}

/**
 * `client_jwks` の行の JWK を解析して返す。
 *
 * 行の `jwk` には、一つの公開鍵の JWK を JSON のオブジェクトで保存する。
 *
 * @throws {Error} `jwk` が JSON として正しくないか、JSON のオブジェクトでない（配列や `null` など）とき
 */
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
 * クライアントをテーブルに保存し、公開鍵を追加する。
 *
 * `clients` の行を書き、同じ `client_id` で登録済みのクライアントの行を置き換える。
 * 削除済み（`is_deleted`）のクライアントも、登録し直すと削除済みでなくなる。
 * `clientSecretHash` が渡されればそのまま、`clientSecret` が渡されればハッシュ（`hashClientSecret()`）にして保存する。
 * `tokenEndpointAuthMethods` のシークレットの方式（`client_secret_basic` と `client_secret_post`）は、それぞれ同じシークレットを持つ `client_auths` と `client_secrets` の行になる。
 * シークレットのないクライアントには、シークレットの方式の行を作らない。
 * `private_key_jwt` は、シークレットを持たない `client_auths` の行になる（OIDC Core 1.0 §9）。
 * パブリッククライアントには、`client_auths` の行を作らない。
 * `clientType` がなければ、`tokenEndpointAuthMethods` が `none` のクライアントをパブリッククライアントとして保存する。
 *
 * 同じ値で登録し直しても、行は変わらない。
 * 各行の ID はその行が持つ値から作る（`childRowId()`）ので、二回の登録は複製を足さずに同じ行を書く。
 * そのため、OP の複数のインスタンスが起動時に同時にクライアントを登録してもよい。
 * 値が変わったときは、新しいリダイレクト URI、グラントタイプ、スコープ、レスポンスタイプを入れてから古い行を消すので、そのあいだのリクエストもクライアントを見つけられる。
 *
 * SQL 文は一つずつ実行する（`SqlDatabase` にはトランザクションがない）。
 * 途中で止まったときは、もう一度呼べばよい。
 *
 * `client.keys` の公開鍵は、用途ごとに `client_jwks` の行として追加する。
 * この関数は `client_jwks` の行を消さないので、OP の動作中にデータベースで鍵を管理でき、次の起動時にクライアントを登録し直しても、その鍵は残る（ファイルの冒頭を参照）。
 * 鍵を取り除くには、データベースの行を消し、ここに渡すクライアントからも外す。
 * 外さなければ、次の登録で鍵が戻る。
 *
 * `requestUris` は `client_request_uris` の行になる。
 * `clientName`、`jwksUri`、`requestObjectSigningAlg`、`tokenEndpointAuthSigningAlg`、`logoUri`、`policyUri`、`tosUri`、`clientUri` は、`clients` のそれぞれ `name`、`jwks_uri`、`request_object_signing_alg`、`token_endpoint_auth_signing_alg`、`logo_uri`、`policy_uri`、`tos_uri`、`client_uri` の列になり、渡されなければ NULL になる。
 * クライアントは `jwksUri` と `keys` のどちらか一方だけを登録する（RFC 7591 §2）。
 *
 * セットアップ用のスクリプトや起動時の処理から、`db/` のデータベース（`db/index.ts` の `createDatabase()` が返すもの）と `ClientRegistration`（`config.ts`）を渡して呼ぶ。
 *
 * @throws {Error} `jwksUri` が `http` か `https` の絶対 URL でないとき、または `jwksUri` と `keys` を両方持つとき（何も書き込まずに投げる）
 * @throws {Error} `clientType` が `public` でなく、`tokenEndpointAuthMethods` に `none` とほかの方式を並べたとき
 * @example
 * ```ts
 * // instance.ts がリクエストコンテキストを読むとき（Hono の出力では、D1 などの c.env のバインディング）は、
 * // コンテキストのある場所で createDatabase(c) と呼ぶ
 * const db = createDatabase();
 * await registerClient(db, {
 *   clientId: 'my-client',
 *   clientSecret: '...',
 *   redirectUris: ['https://client.example.com/callback'],
 *   grantTypes: ['authorization_code', 'refresh_token'],
 *   tokenEndpointAuthMethods: ['client_secret_basic'],
 * });
 * ```
 */
export async function registerClient(db: SqlDatabase, client: ClientRegistration): Promise<void> {
  assertClientJwksUriRegistration(client);
  const clientType = client.clientType ?? (isPublicTokenClient(client) ? 'public' : 'confidential');
  await db.run({
    sql:
      'INSERT INTO clients (id, name, client_type, is_deleted, jwks_uri, request_object_signing_alg, ' +
      'token_endpoint_auth_signing_alg, logo_uri, policy_uri, tos_uri, client_uri) ' +
      'VALUES (?, ?, ?, FALSE, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (id) DO UPDATE SET name = excluded.name, client_type = excluded.client_type, ' +
      'is_deleted = FALSE, jwks_uri = excluded.jwks_uri, ' +
      'request_object_signing_alg = excluded.request_object_signing_alg, ' +
      'token_endpoint_auth_signing_alg = excluded.token_endpoint_auth_signing_alg, ' +
      'logo_uri = excluded.logo_uri, policy_uri = excluded.policy_uri, tos_uri = excluded.tos_uri, ' +
      'client_uri = excluded.client_uri',
    params: [
      client.clientId,
      client.clientName ?? null,
      clientType,
      client.jwksUri ?? null,
      client.requestObjectSigningAlg ?? null,
      client.tokenEndpointAuthSigningAlg ?? null,
      client.logoUri ?? null,
      client.policyUri ?? null,
      client.tosUri ?? null,
      client.clientUri ?? null,
    ],
  });

  const secretHash =
    client.clientSecretHash ??
    (client.clientSecret !== undefined ? await hashClientSecret(client.clientSecret) : undefined);
  const methods =
    clientType === 'confidential'
      ? selectRegisteredClientAuthMethods(client).filter((method): method is ClientAuthType => method !== 'none')
      : [];
  // シークレットの方式の行はシークレットを持ち、`private_key_jwt` の行はシークレットを持たない（OIDC Core 1.0 §9）。
  const auths: Array<{ id: string; method: ClientAuthType; secretHash?: string }> = [];
  for (const method of methods) {
    if (method === 'private_key_jwt') {
      auths.push({ id: await childRowId(client.clientId, 'client_auths', method), method });
    } else if (secretHash !== undefined) {
      auths.push({ id: await childRowId(client.clientId, 'client_auths', method), method, secretHash });
    }
  }
  const authIds = auths.map((auth) => auth.id);
  // まず、クライアントが挙げなくなった方式の行を消す。
  // シークレットの行は `client_auths` の行を参照しており、SQLite は外部キーを有効にしたときしか連鎖して消さないので、シークレットの行を先に消す。
  await db.run({
    sql: exceptIds('DELETE FROM client_secrets WHERE id IN (SELECT id FROM client_auths WHERE client_id = ?)', authIds),
    params: [client.clientId, ...authIds],
  });
  await db.run({
    sql: exceptIds('DELETE FROM client_auths WHERE client_id = ?', authIds),
    params: [client.clientId, ...authIds],
  });
  for (const auth of auths) {
    await db.run({
      sql: 'INSERT INTO client_auths (id, client_id, client_auth_type) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING',
      params: [auth.id, client.clientId, auth.method],
    });
    if (auth.secretHash !== undefined) {
      await db.run({
        sql:
          'INSERT INTO client_secrets (id, client_auth_type, secret) VALUES (?, ?, ?) ' +
          'ON CONFLICT (id) DO UPDATE SET secret = excluded.secret',
        params: [auth.id, auth.method, auth.secretHash],
      });
    }
  }
  for (const [purpose, keySet] of Object.entries(client.keys ?? {})) {
    for (const key of keySet?.keys ?? []) {
      const jwk = JSON.stringify(key);
      await db.run({
        sql:
          'INSERT INTO client_jwks (id, client_id, purpose, jwk) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (id) DO NOTHING',
        params: [
          await childRowId(client.clientId, 'client_jwks', JSON.stringify([purpose, jwk])),
          client.clientId,
          purpose,
          jwk,
        ],
      });
    }
  }

  const childValues: Array<[table: string, column: string, values: readonly string[]]> = [
    ['client_redirect_uris', 'value', client.redirectUris],
    ['client_grant_types', 'grant_type', client.grantTypes ?? []],
    ['client_scopes', 'value', client.scope ?? []],
    ['client_response_types', 'response_type', client.responseTypes ?? []],
    ['client_request_uris', 'value', client.requestUris ?? []],
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
 * クライアントに属する行の ID を返す。
 *
 * ID は、`client_id`、テーブル名、行が持つ値を並べた JSON の SHA-256 ハッシュを、16 進数で表した文字列である。
 * 同じ値はいつも同じ行の ID になる。
 */
async function childRowId(clientId: string, table: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([clientId, table, value])),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * `keep` の行を対象から外した `DELETE` 文を返す。
 *
 * `sql` の末尾に `AND id NOT IN (?, ...)` を足し、ID が `keep` にない行だけを消す文にする。
 * `keep` が空なら、`sql` をそのまま返す。
 * 足したプレースホルダーには、呼び出し側が `keep` の ID を順に渡す。
 */
function exceptIds(sql: string, keep: readonly string[]): string {
  return keep.length === 0 ? sql : sql + ' AND id NOT IN (' + keep.map(() => '?').join(', ') + ')';
}
