import type { ClientKeyResolver, ClientKeysByPurpose, ClientResolver, JwkSet, TokenClientResolver } from '@maronn-openid-connect/core';
import type { DynamicallyRegisteredClient } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import type { ClientRegistration, RegisteredClient } from '../../config';

/**
 * EXPERIMENTAL — store contract for dynamically registered clients (RFC 7591).
 *
 * - get(clientId): return the registration, or undefined when unknown.
 * - save(registration): persist it under registration.clientId. The record is
 *   a ClientRegistration as registerClient() of db/ takes it: the client and
 *   its public keys by purpose (keys), the client_secret as its hash.
 * - count(): how many dynamic registrations exist, for the
 *   maxRegisteredClients inventory cap (RFC 7591 §5 DoS consideration).
 * - delete(clientId): remove one registration — the register endpoint
 *   withdraws its own save when concurrent requests overshot the cap.
 */
export interface DynamicallyRegisteredClientStore {
  get(clientId: string): Promise<ClientRegistration | undefined>;
  /**
   * 新しい登録をストアに保存する。
   *
   * 登録には、クライアント、用途ごとの公開鍵、`client_secret` のハッシュが含まれる。
   */
  save(registration: ClientRegistration): Promise<void>;
  /**
   * 動的に登録されたクライアントの数を返す。
   *
   * `maxRegisteredClients` の上限と比べる登録数である。
   */
  count(): Promise<number>;
  delete(clientId: string): Promise<void>;
}

/**
 * EXPERIMENTAL — in-memory store for dynamically registered clients (RFC 7591).
 *
 * Dynamic registrations live only in this process: they survive neither a
 * restart nor a second instance (the statically registered clients do), so a
 * long-running deployment needs a persistent implementation of the contract
 * above. There is no expiry: RFC 7592 (deregistration) is not implemented, so
 * the inventory cap and a restart are the only ways a registration goes away.
 */
export class InMemoryDynamicallyRegisteredClientStore
  implements DynamicallyRegisteredClientStore
{
  private clients = new Map<string, ClientRegistration>();

  async get(clientId: string): Promise<ClientRegistration | undefined> {
    return this.clients.get(clientId);
  }

  async save(registration: ClientRegistration): Promise<void> {
    this.clients.set(registration.clientId, registration);
  }

  async count(): Promise<number> {
    return this.clients.size;
  }

  async delete(clientId: string): Promise<void> {
    this.clients.delete(clientId);
  }
}

// Kept on globalThis so every module that asks for the store gets the same one,
// also where a framework loads a module more than once (dev-mode hot reloads,
// separate module layers).
const dynamicClientStoreRegistry = globalThis as typeof globalThis & {
  __oidcDynamicallyRegisteredClientStore?: DynamicallyRegisteredClientStore;
};

export const dynamicClientStore: DynamicallyRegisteredClientStore =
  (dynamicClientStoreRegistry.__oidcDynamicallyRegisteredClientStore ??=
    new InMemoryDynamicallyRegisteredClientStore());

/**
 * 登録したクライアントから保存用のレコードを作る。
 *
 * レコードには、OP が読むフィールド（db/ の `registerClient()` が受け取るもの。`jwksUri` と `requestObjectSigningAlg` も含む）、`jwks` の公開鍵を `jwksPurposes` のすべての用途に割り当てたもの（`keys`）、プロジェクト独自のコードが読むための登録したメタデータ（`RegisteredClient.registrationMetadata`）を入れる。
 * `client_secret` は平文では入れず、`clientSecretHash` に渡されたハッシュだけを入れる。
 *
 * experimental パッケージは、認証方式と署名アルゴリズムを文字列の型で表す。
 * パッケージの側には、この OP の認証方式とアルゴリズムの一覧がないためである。
 * 登録エンドポイントがそれらを登録の設定とこの OP の署名鍵に照らして検証済みなので、ここでは検証し直さずに `RegisteredClient` の型に絞り込む。
 *
 * 実験的な機能（RFC 7591）である。
 */
export function toClientRegistration(
  client: DynamicallyRegisteredClient,
  options: { clientSecretHash?: string; jwksPurposes: readonly string[] },
): ClientRegistration {
  const tokenEndpointAuthMethods: readonly string[] = client.tokenEndpointAuthMethods;
  return {
    clientId: client.clientId,
    clientType: client.clientType,
    redirectUris: [...client.redirectUris],
    grantTypes: [...client.grantTypes],
    responseTypes: [...client.responseTypes],
    tokenEndpointAuthMethods: tokenEndpointAuthMethods as RegisteredClient['tokenEndpointAuthMethods'],
    ...(client.scope === undefined ? {} : { scope: [...client.scope] }),
    ...(client.defaultMaxAge === undefined ? {} : { defaultMaxAge: client.defaultMaxAge }),
    ...(client.idTokenSignedResponseAlg === undefined
      ? {}
      : { idTokenSignedResponseAlg: client.idTokenSignedResponseAlg as RegisteredClient['idTokenSignedResponseAlg'] }),
    ...(client.userinfoSignedResponseAlg === undefined
      ? {}
      : { userinfoSignedResponseAlg: client.userinfoSignedResponseAlg as RegisteredClient['userinfoSignedResponseAlg'] }),
    ...(options.clientSecretHash === undefined ? {} : { clientSecretHash: options.clientSecretHash }),
    ...(client.jwks === undefined ? {} : { keys: keysByPurpose(client.jwks, options.jwksPurposes) }),
    ...(client.jwksUri === undefined ? {} : { jwksUri: client.jwksUri }),
    ...(client.requestObjectSigningAlg === undefined ? {} : { requestObjectSigningAlg: client.requestObjectSigningAlg }),
    registrationMetadata: { ...client.metadata },
  };
}

/**
 * 用途ごとに `jwks` の鍵の複製を割り当てて返す。
 *
 * 用途ごとに別の JWK Set を作り、どの JWK Set にも `jwks` のすべての鍵の複製を入れる。
 */
function keysByPurpose(jwks: JwkSet, purposes: readonly string[]): ClientKeysByPurpose {
  const keys: ClientKeysByPurpose = {};
  for (const purpose of purposes) {
    keys[purpose] = { keys: jwks.keys.map((key) => ({ ...key })) };
  }
  return keys;
}

/**
 * `base` になければ動的登録から探すリゾルバを作る。
 *
 * 作るリゾルバの `findClient()` は、まず `base` に問い合わせ、見つかればそのクライアントを返す。
 * 見つからなければ動的登録のストアを探し、登録があれば鍵（`keys`）を除いたクライアントを、なければ `null` を返す。
 * 先に `base` に問い合わせるので、静的に登録したクライアントが動的登録に隠されることはない。
 * そのうえ、`/register` が発行する ID には `dcr-` の接頭辞が付き、人が名付ける静的なクライアントの ID と区別できるようにしてある。
 *
 * 作るリゾルバは `base` と同じ型である。
 * `ClientResolver` と `TokenClientResolver` を兼ねる値はどちらとしても使い続けられ、ストアから返す `RegisteredClient` のレコードはどちらの型も満たす。
 * 登録の鍵は、db/ と同じくクライアントに含めず、`ClientKeyResolver` が用途ごとに返す。
 *
 * 実験的な機能（RFC 7591）である。
 */
export function withDynamicallyRegisteredClients<
  Resolver extends ClientResolver | TokenClientResolver,
>(base: Resolver): Resolver {
  return {
    ...base,
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      const registered = (await base.findClient(clientId)) as RegisteredClient | null;
      if (registered) {
        return registered;
      }
      const registration = await dynamicClientStore.get(clientId);
      if (!registration) {
        return null;
      }
      const { keys: _keys, ...client } = registration;
      return client;
    },
  } as Resolver;
}

/**
 * `base` になければ動的登録の鍵を返すリゾルバを作る。
 *
 * 作るリゾルバの `findClientKeys()` は、まず `base` に問い合わせ、鍵が 1 つ以上あればそれを返す。
 * そのため、db/ に鍵があるクライアントには、db/ の鍵を返す。
 * `base` に鍵がなければ動的登録のストアを探し、登録の `jwks`（RFC 7591 §2）の鍵のうち、その用途（`jwksPurposes` の用途）に割り当てた鍵を返す。
 * どちらにもないクライアントや、鍵のない用途には、空の鍵の集合を返す（core の `ClientKeyResolver` の約束どおり）。
 *
 * 手がかり（`hint`。検証する JWS の `kid`）は、そのまま `base` に渡す。
 * `jwksUri` を持つクライアントの `jwks_uri` の鍵は、使うエンドポイントが呼ぶ provider.ts の `getClientKeyResolver()` が、このリゾルバの外側に加える。
 * 動的に登録したクライアントも、この機能が広げた `clientResolver` で見つかるので、同じく `jwks_uri` の鍵が返る。
 *
 * 実験的な機能（RFC 7591）である。
 */
export function withDynamicallyRegisteredClientKeys(base: ClientKeyResolver): ClientKeyResolver {
  return {
    ...base,
    async findClientKeys(clientId, purpose, hint): Promise<JwkSet> {
      const registered = await base.findClientKeys(clientId, purpose, hint);
      if (registered.keys.length > 0) {
        return registered;
      }
      const registration = await dynamicClientStore.get(clientId);
      return { keys: [...(registration?.keys?.[purpose]?.keys ?? [])] };
    },
  };
}
