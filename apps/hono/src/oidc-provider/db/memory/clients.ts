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

/**
 * `client_id` でクライアントを取得するリゾルバを返す。
 *
 * 返すリゾルバの `findClient()` は、呼ばれるたびにデータベースの `clients` から登録内容を読み、公開鍵（`keys`）を除いた写しを返す。
 * 登録されていないクライアントには `null` を返す。
 * 認可エンドポイントとトークンエンドポイントは、このリゾルバでクライアントを取得する。
 * 公開鍵は返さない（{@link createClientKeyResolver} のリゾルバが返す）。
 */
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
 * クライアントの公開鍵を用途別に取得するリゾルバを返す。
 *
 * 返すリゾルバの `findClientKeys()` は、呼ばれるたびにデータベースの `clients` から登録内容の `keys`（`ClientRegistration.keys`）を読み、指定された用途の鍵を JWK Set で返す。
 * 登録されていないクライアントと、その用途の鍵がないクライアントには、`keys` が空の JWK Set を返す。
 * OP は、署名付きのリクエストオブジェクトを `request_object` の用途の鍵で検証する。
 */
export function createClientKeyResolver(db: MemoryDatabase): ClientKeyResolver {
  return createKeyResolver((clientId) => db.clients.get(clientId)?.keys);
}

/**
 * クライアントをデータベースに保存する。
 *
 * 登録内容を公開鍵（`keys`）ごと `clients` に入れ、同じ `client_id` で登録済みのクライアントを置き換える。
 * `clientSecret` はハッシュ（`hashClientSecret()`）にして `clientSecretHash` に保存し、`clientSecret` そのものは保存しない。
 * クライアントは、`tokenEndpointAuthMethods` のどの方式でも認証できる。
 *
 * @example
 * ```ts
 * await registerClient(db, {
 *   clientId: 'my-client',
 *   clientSecret: '...',
 *   redirectUris: ['https://rp.example.com/callback'],
 *   grantTypes: ['authorization_code', 'refresh_token'],
 *   tokenEndpointAuthMethods: ['client_secret_basic'],
 * });
 * ```
 */
export async function registerClient(db: MemoryDatabase, client: ClientRegistration): Promise<void> {
  const { clientSecret, ...registration } = client;
  db.clients.set(client.clientId, {
    ...registration,
    ...(clientSecret === undefined ? {} : { clientSecretHash: await hashClientSecret(clientSecret) }),
  });
}
