/**
 * The jwks_uri of the registered clients (RFC 7591 §2 / OIDC Dynamic Client
 * Registration 1.0 §2): the ClientKeyResolver app.ts uses when none is passed
 * in hands out the keys of a client's jwks_uri for the purposes of
 * config.clientJwksUriPurposes, so a client rotates its keys by changing its
 * jwks_uri, with no change to the OP.
 *
 * The keys are fetched when a process needs them (a signed Request Object, for
 * one), never when the client is registered, and kept in a cache shared by the
 * process (createClientJwksUriCache() of core): for the max-age of the
 * response within clientJwksUriCacheMinTtlSeconds and
 * clientJwksUriCacheMaxTtlSeconds, and fetched again for a kid the cached keys
 * do not have, at most once per clientJwksUriRefetchIntervalSeconds (OIDC Core
 * 1.0 §10.1.1). config.ts holds every setting.
 *
 * Pass your own ClientKeyResolver to createApp() / applyOidc() and this file
 * is not used: wrap it with withClientJwksUriKeys() of core to keep jwks_uri.
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
 * Wrap the ClientKeyResolver of db/ so a client with a jwksUri
 * (RegisteredClient) gets the keys of its jwks_uri for the purposes of
 * config.clientJwksUriPurposes, and only those: keys stored for the client in
 * db/ are not read for these purposes. Every other client and purpose goes to
 * base.
 *
 * The client is looked up when the keys are asked for, with the clientResolver
 * the request context holds then: the one a feature put there (dynamic client
 * registration adds its clients) included. The settings come from the config
 * of the context, which app.ts sets before this wrapper.
 *
 * A jwks_uri that cannot be used (refused by the destination policy, not
 * answering, answering something else than a JWK Set) is logged with its host
 * and the reason, and the error goes on to the caller: a Request Object is
 * then refused with a fixed error_description that says nothing of the reason.
 *
 * fetch replaces globalThis.fetch (OidcProviderOptions.clientJwksFetch), and
 * cache the cache of the process (tests).
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
        // Told apart by shape: the cache of the process may come from another
        // copy of core (isClientJwksUriError).
        if (isClientJwksUriError(error)) {
          console.warn(`[oidc-provider] could not use the jwks_uri at ${hostOf(uri)}: ${error.message}`);
        }
        throw error;
      }
    },
  });
}

/** The settings of the config for createClientJwksUriCache().load() of core. */
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

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return '(an invalid URL)';
  }
}

/**
 * The check registerClient() of db/ runs on a client before it stores it: a
 * jwksUri must be an absolute http or https URL without a fragment or userinfo
 * (whether the OP may fetch its host is decided when the keys are fetched, by
 * allowInsecureClientJwksUri), and a client with a jwksUri registers no keys —
 * one source of keys per client, as RFC 7591 §2 asks of jwks and jwks_uri.
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
