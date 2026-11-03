/**
 * The jwks_uri of the registered clients (RFC 7591 §2 / OIDC Dynamic Client
 * Registration 1.0 §2): app.ts wraps the ClientKeyResolver (that of db/, or
 * the one passed in) so it hands out the keys of a client's jwks_uri for the
 * purposes of config.clientJwksUriPurposes, so a client rotates its keys by
 * changing its jwks_uri, with no change to the OP.
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
  type ClientJwksUriLoadOptions,
  type ClientKeyResolver,
} from '@maronn-openid-connect/core';
import type { ClientRegistration, ProviderConfig, RegisteredClient } from './config.js';

// Kept on globalThis so every module that asks for the cache gets the same
// one, also where a framework loads a module more than once (dev-mode hot
// reloads, separate module layers).
const registry = globalThis as typeof globalThis & { __oidcClientJwksUriCache?: ClientJwksUriCache };

/** The keys of the jwks_uri this process fetched, by jwks_uri. */
export const clientJwksUriCache: ClientJwksUriCache = (registry.__oidcClientJwksUriCache ??= createClientJwksUriCache());

/**
 * `base`（db/ のリゾルバか、`createApp()` / `applyOidc()` に渡したリゾルバ）を包み、`jwksUri` を持つクライアントには `config.clientJwksUriPurposes` の用途で `jwks_uri` の鍵だけを返すリゾルバを作って返す。
 *
 * それらの用途では、`base` がそのクライアントに持つ鍵は読まない。
 * ほかのクライアントと用途には、`base` の鍵を返す。
 *
 * クライアントは、鍵を求められたときに、そのときのリクエストコンテキストの `clientResolver` で探す。
 * 機能が置いた `clientResolver`（動的クライアント登録は自分のクライアントを足す）も含まれる。
 * 設定は、app.ts がこのリゾルバより先に置くコンテキストの `config` から読む。
 *
 * 使えない `jwks_uri`（宛先の方針で拒否した、応答しない、JWK Set 以外を返した）は、ホストと理由を `console.warn` に書き、エラーをそのまま呼び出し側へ投げる。
 * リクエストオブジェクトは、理由を含まない固定の `error_description` で拒否される。
 *
 * `options.fetch` は `globalThis.fetch` の代わりに使う fetch（`OidcProviderOptions.clientJwksFetch`）、`options.cache` はプロセスのキャッシュの代わりに使うキャッシュ（テスト用）である。
 *
 * @spec RFC 7591 §2
 * @spec OIDC Core 1.0 §10.1.1
 */
export function withRegisteredClientJwksUri(
  c: any,
  base: ClientKeyResolver,
  options: { fetch?: typeof fetch; cache?: ClientJwksUriCache } = {},
): ClientKeyResolver {
  const config: ProviderConfig = c.get('config');
  const cache = options.cache ?? clientJwksUriCache;
  const loadOptions = clientJwksUriLoadOptionsOf(config, options.fetch);
  return withClientJwksUriKeys(base, {
    purposes: config.clientJwksUriPurposes,
    async findJwksUri(clientId) {
      const client = (await c.get('clientResolver').findClient(clientId)) as RegisteredClient | null;
      return client?.jwksUri;
    },
    async load(uri, hint) {
      try {
        return await cache.load(uri, hint, loadOptions);
      } catch (error) {
        // クラスではなく形で見分ける。プロセスで共有するキャッシュは、別に読み込まれた core の複製が作ったものかもしれない（isClientJwksUriError）。
        if (isClientJwksUriError(error)) {
          console.warn(`[oidc-provider] could not use the jwks_uri at ${hostOf(uri)}: ${error.message}`);
        }
        throw error;
      }
    },
  });
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
