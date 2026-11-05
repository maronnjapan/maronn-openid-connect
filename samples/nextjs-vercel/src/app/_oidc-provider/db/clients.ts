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
 * - jwks_uri: jwksUri, the jwks_uri the OP fetches the client's keys from
 *   (RFC 7591 §2). A client with one gets the keys of its jwks_uri, not those
 *   of keys.clientJwks(), for the purposes of clientJwksUriPurposes.
 * - request_object_signing_alg: requestObjectSigningAlg, the alg every Request
 *   Object of the client must be signed with (OIDC Dynamic Client Registration
 *   1.0 §2).
 * - Metadata without a field (default_max_age, the ID Token and UserInfo
 *   signing algs) keeps its default.
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
import { assertClientJwksUriRegistration } from '../client-jwks-uri';
import type { ClientRegistration, RegisteredClient } from '../config';
import { readRecord, writeRecord, type KvDatabase } from './database';
import { keys, type ClientAuthRecord, type ClientJwksRecord, type ClientRecord } from './keys';

/**
 * `client_id` でクライアントを取得するリゾルバを返す。
 *
 * 返すリゾルバの `findClient()` は、呼ばれるたびに `keys.client()` のレコードを読み、`RegisteredClient` に変換して返す。
 * レコードがないクライアントと、`is_deleted` が `true` のクライアントには `null` を返す。
 * 認可エンドポイントとトークンエンドポイントは、このリゾルバでクライアントを取得する。
 * 公開鍵は返さない（{@link createClientKeyResolver} のリゾルバが返す）。
 *
 * レコードの値は、次のように `RegisteredClient` に移す。
 * - `client_type` が `public` なら、`tokenEndpointAuthMethods` を `['none']` にする（クライアント認証をしない）。
 * - コンフィデンシャルクライアントなら、`client_auths` の各エントリーの方式を `tokenEndpointAuthMethods` に、エントリーのシークレットを `clientSecretHash` にする。
 * - `client_auths` が空のコンフィデンシャルクライアントは、既定の `client_secret_basic` のままシークレットを持たないので、認証できない。
 * - `grant_types`、`scopes`、`response_types` は、空でなければそれぞれ `grantTypes`、`scope`、`responseTypes` にし、空なら設定せずに既定の扱いに任せる。
 * - `jwks_uri` と `request_object_signing_alg` は、あればそれぞれ `jwksUri` と `requestObjectSigningAlg` にする。
 *
 * @throws {Error} 返したリゾルバの `findClient()` が、シークレットの違うエントリーを `client_auths` に持つクライアントを読んだとき
 */
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
      if (typeof client.jwks_uri === 'string') registered.jwksUri = client.jwks_uri;
      if (typeof client.request_object_signing_alg === 'string') {
        registered.requestObjectSigningAlg = client.request_object_signing_alg;
      }
      if (registered.clientType === 'public') {
        registered.tokenEndpointAuthMethods = ['none'];
      } else if (client.client_auths[0]) {
        // クライアントの `client_secret` は、どの方式で提示されても一つである（RFC 7591 §2）。
        // そのため、最初のエントリーとシークレットが違うエントリーがあれば、設定の誤りとして投げる。
        const secret = client.client_auths[0].secret;
        if (client.client_auths.some((auth) => auth.secret !== secret)) {
          throw new Error('Client ' + clientId + ' has client_auths entries with different secrets');
        }
        registered.tokenEndpointAuthMethods = client.client_auths.map((auth) => auth.client_auth_type);
        registered.clientSecretHash = secret;
      }
      // `client_auths` が空のコンフィデンシャルクライアントは、既定の `client_secret_basic` のままシークレットを持たないので、認証できない。
      return registered;
    },
  };
}

/**
 * クライアントの公開鍵を用途別に取得するリゾルバを返す。
 *
 * 返すリゾルバの `findClientKeys()` は、呼ばれるたびに用途の `keys.clientJwks()` のレコードを読み、その鍵を JWK Set で返す。
 * クライアントのレコードがないとき、クライアントが削除済み（`is_deleted`）のとき、用途のレコードがないときは、`keys` が空の JWK Set を返す。
 * OP は、署名付きのリクエストオブジェクトを `request_object` の用途の鍵で検証する。
 *
 * OP は、ほかのリゾルバを渡されなければこのリゾルバを使う。
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
 * クライアントをストアに保存し、公開鍵を追加する。
 *
 * クライアントのレコード（`keys.client()`）を書き、同じ `client_id` で登録済みのレコードを置き換える。
 * `clientSecretHash` が渡されればそのまま、`clientSecret` が渡されればハッシュ（`hashClientSecret()`）にして保存する。
 * `tokenEndpointAuthMethods` の方式（`client_secret_basic` と `client_secret_post`）は、それぞれ同じシークレットを持つ `client_auths` のエントリーになる。
 * パブリッククライアントと、シークレットのないクライアントには、エントリーを作らない。
 * `clientType` がなければ、`tokenEndpointAuthMethods` が `none` のクライアントをパブリッククライアントとして保存する。
 *
 * クライアント全体を一つのレコードとして一度の `set` で書くので、OP の複数のインスタンスが起動時に同時にクライアントを登録してもよい。
 *
 * `client.keys` の公開鍵は、用途ごとの `keys.clientJwks()` のレコードに追加する。
 * レコードにない鍵だけを末尾に足し、鍵を取り除くことはない。
 * そのため、OP の動作中にストアで鍵を管理でき、次の起動時にクライアントを登録し直しても、その鍵は残る（ファイルの冒頭を参照）。
 * 鍵を取り除くには、ストアのレコードから消し、ここに渡すクライアントからも外す。
 * 外さなければ、次の登録で鍵が戻る。
 *
 * `jwksUri` と `requestObjectSigningAlg` は、クライアントのレコードの `jwks_uri` と `request_object_signing_alg` に書く。
 * そのため、これらを持たない登録は、登録済みの値を取り除く。
 * クライアントは `jwksUri` と `keys` のどちらか一方だけを登録する（RFC 7591 §2）。
 *
 * セットアップ用のスクリプトや起動時の処理（`instrumentation.ts` の `register()`）から、`db/` のデータベース（`db/index.ts` の `createDatabase()` が返すもの）と `ClientRegistration`（`config.ts`）を渡して呼ぶ。
 *
 * @throws {Error} `jwksUri` が `http` か `https` の絶対 URL でないとき、または `jwksUri` と `keys` を両方持つとき（何も書き込まずに投げる）
 * @throws {Error} `clientType` が `public` でなく、`tokenEndpointAuthMethods` に `none` とほかの方式を並べたとき
 * @example
 * ```ts
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
export async function registerClient(
  db: KvDatabase,
  client: ClientRegistration & { name?: string },
): Promise<void> {
  assertClientJwksUriRegistration(client);
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
    ...(client.jwksUri === undefined ? {} : { jwks_uri: client.jwksUri }),
    ...(client.requestObjectSigningAlg === undefined
      ? {}
      : { request_object_signing_alg: client.requestObjectSigningAlg }),
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
