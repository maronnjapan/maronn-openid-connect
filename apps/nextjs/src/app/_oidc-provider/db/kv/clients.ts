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
 *   (tokenEndpointAuthMethods: client_secret_basic, client_secret_post,
 *   private_key_jwt, or several of them), and the clientSecretHash the
 *   presented secret is checked against whichever secret method the request
 *   uses. A client has one client_secret (RFC 7591 §2), so secret-method
 *   entries with different secrets are a configuration error. A
 *   private_key_jwt entry has no secret: the client assertion (OIDC Core 1.0
 *   §9) is verified with the keys of the private_key_jwt purpose, or the keys
 *   of the jwks_uri. A confidential client without entries keeps the default
 *   client_secret_basic with no secret, so it cannot authenticate.
 * - redirect_uris, grant_types and scopes: redirectUris, grantTypes and scope.
 *   A request for a scope outside scope is rejected with invalid_scope
 *   (validateClientScope() in core). A client without scopes may request every
 *   scope the OP accepts.
 * - response_types: responseTypes, the response types the client may use at
 *   the authorization endpoint (id_token and id_token token for the Implicit
 *   Flow). A client without them may use code only.
 * - request_uris: requestUris, the request_uri values the client uses (OIDC
 *   Core 1.0 §6.2).
 * - The single-valued metadata, each left out of the RegisteredClient when
 *   null (OIDC Dynamic Client Registration 1.0 §2): jwks_uri is jwksUri, the
 *   jwks_uri the OP fetches the client's keys from (RFC 7591 §2); a client
 *   with one gets the keys of its jwks_uri, not those of keys.clientJwks(),
 *   for the purposes of clientJwksUriPurposes. request_object_signing_alg is
 *   requestObjectSigningAlg, the alg every Request Object of the client must
 *   be signed with, and token_endpoint_auth_signing_alg is
 *   tokenEndpointAuthSigningAlg, the alg every private_key_jwt client
 *   assertion must be signed with. name, logo_uri, policy_uri, tos_uri and
 *   client_uri are clientName, logoUri, policyUri, tosUri and clientUri, what
 *   the login and consent screens show.
 * - Metadata without a field (default_max_age, the ID Token and UserInfo
 *   signing algs) keeps its default.
 *
 * The client's public keys (keys.clientJwks(), one record per purpose) are not
 * part of the RegisteredClient. A process that needs them asks the
 * ClientKeyResolver for the keys of its own purpose (ClientKeyResolver in
 * core): the OP verifies signed Request Objects with those of request_object
 * and client assertions with those of private_key_jwt, and a process a
 * project adds reads its own purpose (dpop, for one).
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
import { assertClientJwksUriRegistration } from '../../client-jwks-uri';
import type { ClientRegistration, RegisteredClient } from '../../config';
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
 * - コンフィデンシャルクライアントなら、`client_auths` の各エントリーの方式（`client_secret_basic`、`client_secret_post`、`private_key_jwt`）を登録した順に `tokenEndpointAuthMethods` に、シークレットの方式のエントリーのシークレットを `clientSecretHash` にする。
 * - `client_auths` が空のコンフィデンシャルクライアントは、既定の `client_secret_basic` のままシークレットを持たないので、認証できない。
 * - `grant_types`、`scopes`、`response_types`、`request_uris` は、空でなければそれぞれ `grantTypes`、`scope`、`responseTypes`、`requestUris` にし、空なら設定せずに既定の扱いに任せる。
 * - `jwks_uri`、`request_object_signing_alg`、`token_endpoint_auth_signing_alg`、`name`、`logo_uri`、`policy_uri`、`tos_uri`、`client_uri` は、`null` でなければそれぞれ `jwksUri`、`requestObjectSigningAlg`、`tokenEndpointAuthSigningAlg`、`clientName`、`logoUri`、`policyUri`、`tosUri`、`clientUri` にする。
 *
 * @throws {Error} 返したリゾルバの `findClient()` が、シークレットの方式のエントリーどうしでシークレットが違うクライアントを読んだとき
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
      if (client.response_types.length > 0) registered.responseTypes = client.response_types;
      if (client.jwks_uri !== null) registered.jwksUri = client.jwks_uri;
      if (client.request_object_signing_alg !== null) {
        registered.requestObjectSigningAlg = client.request_object_signing_alg;
      }
      if (client.token_endpoint_auth_signing_alg !== null) {
        registered.tokenEndpointAuthSigningAlg = client.token_endpoint_auth_signing_alg;
      }
      if (client.request_uris.length > 0) registered.requestUris = client.request_uris;
      if (client.name !== null) registered.clientName = client.name;
      if (client.logo_uri !== null) registered.logoUri = client.logo_uri;
      if (client.policy_uri !== null) registered.policyUri = client.policy_uri;
      if (client.tos_uri !== null) registered.tosUri = client.tos_uri;
      if (client.client_uri !== null) registered.clientUri = client.client_uri;
      if (registered.clientType === 'public') {
        registered.tokenEndpointAuthMethods = ['none'];
      } else if (client.client_auths.length > 0) {
        registered.tokenEndpointAuthMethods = client.client_auths.map((auth) => auth.client_auth_type);
        // `private_key_jwt` のエントリーはシークレットを持たない（OIDC Core 1.0 §9）ので、シークレットの方式のエントリーだけを調べる。
        const secretAuths = client.client_auths.filter((auth) => 'secret' in auth);
        if (secretAuths[0]) {
          // クライアントの `client_secret` は、どのシークレットの方式で提示されても一つである（RFC 7591 §2）。
          // そのため、最初のエントリーとシークレットが違うエントリーがあれば、設定の誤りとして投げる。
          const secret = secretAuths[0].secret;
          if (secretAuths.some((auth) => auth.secret !== secret)) {
            throw new Error('Client ' + clientId + ' has client_auths entries with different secrets');
          }
          registered.clientSecretHash = secret;
        }
      }
      // どの方式もないコンフィデンシャルクライアントは、既定の `client_secret_basic` のままシークレットを持たないので、認証できない。
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
 * `tokenEndpointAuthMethods` のシークレットの方式（`client_secret_basic` と `client_secret_post`）は、それぞれ同じシークレットを持つ `client_auths` のエントリーになる。
 * シークレットのないクライアントには、シークレットの方式のエントリーを作らない。
 * `private_key_jwt` は、シークレットを持たない `client_auths` のエントリーになる（OIDC Core 1.0 §9）。
 * エントリーは `tokenEndpointAuthMethods` の順に並ぶ。
 * パブリッククライアントには、`client_auths` のエントリーを作らない。
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
 * `requestUris` は `request_uris` に書き、渡されなければ空の配列にする。
 * `clientName`、`jwksUri`、`requestObjectSigningAlg`、`tokenEndpointAuthSigningAlg`、`logoUri`、`policyUri`、`tosUri`、`clientUri` は、クライアントのレコードのそれぞれ `name`、`jwks_uri`、`request_object_signing_alg`、`token_endpoint_auth_signing_alg`、`logo_uri`、`policy_uri`、`tos_uri`、`client_uri` に書き、渡されなければ `null` にする。
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
export async function registerClient(db: KvDatabase, client: ClientRegistration): Promise<void> {
  assertClientJwksUriRegistration(client);
  const clientType = client.clientType ?? (isPublicTokenClient(client) ? 'public' : 'confidential');
  const secretHash =
    client.clientSecretHash ??
    (client.clientSecret !== undefined ? await hashClientSecret(client.clientSecret) : undefined);
  const methods =
    clientType === 'confidential'
      ? selectRegisteredClientAuthMethods(client).filter(
        (method): method is ClientAuthRecord['client_auth_type'] => method !== 'none',
      )
      : [];
  // シークレットの方式のエントリーはシークレットを持ち、`private_key_jwt` のエントリーはシークレットを持たない（OIDC Core 1.0 §9）。
  const clientAuths = methods.flatMap((method): ClientAuthRecord[] =>
    method === 'private_key_jwt'
      ? [{ client_auth_type: method }]
      : secretHash === undefined
        ? []
        : [{ client_auth_type: method, secret: secretHash }],
  );
  const record: ClientRecord = {
    name: client.clientName ?? null,
    client_type: clientType,
    is_deleted: false,
    client_auths: clientAuths,
    redirect_uris: [...client.redirectUris],
    grant_types: [...(client.grantTypes ?? [])],
    scopes: [...(client.scope ?? [])],
    response_types: [...(client.responseTypes ?? [])],
    jwks_uri: client.jwksUri ?? null,
    request_object_signing_alg: client.requestObjectSigningAlg ?? null,
    token_endpoint_auth_signing_alg: client.tokenEndpointAuthSigningAlg ?? null,
    request_uris: [...(client.requestUris ?? [])],
    logo_uri: client.logoUri ?? null,
    policy_uri: client.policyUri ?? null,
    tos_uri: client.tosUri ?? null,
    client_uri: client.clientUri ?? null,
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
