/**
 * The jwks_uri of the registered clients (RFC 7591 §2 / OIDC Dynamic Client
 * Registration 1.0 §2): the ClientKeyResolver of provider.ts hands out the
 * keys of a client's jwks_uri for the purposes of config.clientJwksUriPurposes,
 * so a client rotates its keys by changing its jwks_uri, with no change to the
 * OP.
 *
 * The keys are fetched when a process needs them (a signed Request Object, for
 * one), never when the client is registered, and kept in a cache shared by the
 * process (createClientJwksUriCache() of core): for the max-age of the
 * response within clientJwksUriCacheMinTtlSeconds and
 * clientJwksUriCacheMaxTtlSeconds, and fetched again for a kid the cached keys
 * do not have, at most once per clientJwksUriRefetchIntervalSeconds (OIDC Core
 * 1.0 §10.1.1). config.ts holds every setting.
 */
import {
  createClientJwksUriCache,
  isClientJwksUriError,
  validateClientJwksUri,
  withClientJwksUriKeys,
  type ClientJwksUriCache,
  type ClientJwksUriKeyOptions,
  type ClientJwksUriLoadOptions,
  type ClientKeyResolver,
  type ClientResolver,
} from '@maronn-openid-connect/core';
import type { ClientRegistration, ProviderConfig, RegisteredClient } from './config';
import { shared } from './shared';

/**
 * The keys of the jwks_uri this process fetched, by jwks_uri. shared(), so the
 * Route Handlers and the Server Actions use one cache.
 */
export const clientJwksUriCache: ClientJwksUriCache = shared('clientJwksUriCache', () => createClientJwksUriCache());

/**
 * `base` を包み、`jwksUri` を持つクライアントには `config.clientJwksUriPurposes` の用途で `jwks_uri` の鍵だけを返すリゾルバを作って返す。
 *
 * それらの用途では、db/ にそのクライアントの鍵があっても読まない。
 * ほかのクライアントと用途には、`base` の鍵を返す。
 *
 * `clientResolver` は、鍵を求められたときにクライアントを探すリゾルバを返す関数である。
 * provider.ts は、機能のフックが組み立てたリゾルバ（動的クライアント登録は自分のクライアントを足す）を返す関数を渡す。
 *
 * 使えない `jwks_uri`（宛先の方針で拒否した、応答しない、JWK Set 以外を返した）は、ホストと理由を `console.warn` に書き、エラーをそのまま呼び出し側へ投げる。
 * リクエストオブジェクトは、理由を含まない固定の `error_description` で拒否される。
 *
 * `options.fetch` は `globalThis.fetch` の代わりに使う fetch（egress プロキシ。宛先の検査が見るのは `jwks_uri` のホスト名で、名前の解決先ではない）、`options.cache` はプロセスのキャッシュの代わりに使うキャッシュ（テスト用）である。
 *
 * @spec RFC 7591 §2
 * @spec OIDC Core 1.0 §10.1.1
 */
export function withRegisteredClientJwksUri(
  config: ProviderConfig,
  clientResolver: () => ClientResolver,
  base: ClientKeyResolver,
  options: { fetch?: typeof fetch; cache?: ClientJwksUriCache } = {},
): ClientKeyResolver {
  const cache = options.cache ?? clientJwksUriCache;
  const jwksUriOptions: Omit<ClientJwksUriKeyOptions, 'purposes'> = {
    async findJwksUri(clientId: string): Promise<string | undefined> {
      const client = (await clientResolver().findClient(clientId)) as RegisteredClient | null;
      return client?.jwksUri;
    },
    async load(uri: string, hint?: { kid?: string }) {
      try {
        return await cache.load(uri, hint, clientJwksUriLoadOptionsOf(config, options.fetch));
      } catch (error) {
        // クラスではなく形で見分ける。プロセスで共有するキャッシュは、別に読み込まれた core の複製が作ったものかもしれない（isClientJwksUriError）。
        if (isClientJwksUriError(error)) {
          console.warn(`[oidc-provider] could not use the jwks_uri at ${hostOf(uri)}: ${error.message}`);
        }
        throw error;
      }
    },
  };
  return {
    ...base,
    // 作ったリゾルバを保持する呼び出し側にも、以降の設定変更が効くようにする。
    findClientKeys: (clientId, purpose, hint) =>
      withClientJwksUriKeys(base, { ...jwksUriOptions, purposes: config.clientJwksUriPurposes }).findClientKeys(
        clientId,
        purpose,
        hint,
      ),
  };
}

/** 設定（`ProviderConfig`）の `jwks_uri` の項目から、core の `createClientJwksUriCache()` の `load()` に渡す設定を作って返す。 */
export function clientJwksUriLoadOptionsOf(config: ProviderConfig, fetch?: typeof globalThis.fetch): ClientJwksUriLoadOptions {
  return {
    ...(fetch === undefined ? {} : { fetch }),
    policy: { allowInsecure: config.allowInsecureClientJwksUri },
    ttlSeconds: config.clientJwksUriCacheTtlSeconds,
    minTtlSeconds: config.clientJwksUriCacheMinTtlSeconds,
    maxTtlSeconds: config.clientJwksUriCacheMaxTtlSeconds,
    refetchIntervalSeconds: config.clientJwksUriRefetchIntervalSeconds,
    timeoutMs: config.clientJwksUriTimeoutMs,
    maxBytes: config.clientJwksUriMaxBytes,
    maxKeys: config.clientJwksUriMaxKeys,
    maxEntries: config.clientJwksUriCacheMaxEntries,
  };
}

/** ログに書くための `jwks_uri` のホストを返し、URL として読めなければ `(an invalid URL)` を返す。 */
function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return '(an invalid URL)';
  }
}

/**
 * 登録するクライアントの `jwksUri` が `http` か `https` の絶対 URL でないとき、または `jwksUri` と `keys` を両方持つときに `Error` を投げ、それ以外は何もしない。
 *
 * db/ の `registerClient()` が、何かを書き込む前に呼ぶ。
 * URL はフラグメントと userinfo を含んではならない。
 * OP がそのホストを取得してよいかは、鍵を取得するときに `allowInsecureClientJwksUri` で決める。
 * `jwksUri` を持つクライアントは `keys` を登録しない。RFC 7591 §2 が `jwks` と `jwks_uri` に求めるとおり、クライアントの鍵の出どころを 1 つにする。
 *
 * @spec RFC 7591 §2
 * @throws {Error} `jwksUri` が正しくないとき、または `jwksUri` と `keys` を両方持つとき
 */
export function assertClientJwksUriRegistration(client: ClientRegistration): void {
  if (client.jwksUri === undefined) return;
  try {
    validateClientJwksUri(client.jwksUri, { allowInsecure: true });
  } catch (error) {
    throw new Error(`Client ${client.clientId} has an invalid jwksUri: ${(error as Error).message}`);
  }
  if (Object.values(client.keys ?? {}).some((keySet) => (keySet?.keys.length ?? 0) > 0)) {
    throw new Error(`Client ${client.clientId} registers both jwksUri and keys: register one of them (RFC 7591 §2)`);
  }
}
