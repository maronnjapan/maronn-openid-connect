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
  ClientJwksUriError,
  createClientJwksUriCache,
  validateClientJwksUri,
  withClientJwksUriKeys,
  type ClientJwksUriCache,
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
 * Wrap a ClientKeyResolver so a client with a jwksUri (RegisteredClient) gets
 * the keys of its jwks_uri for the purposes of config.clientJwksUriPurposes,
 * and only those: keys stored for the client in db/ are not read for these
 * purposes. Every other client and purpose goes to base.
 *
 * clientResolver returns the resolver to look the client up with when the
 * keys are asked for: provider.ts hands over the one the features' context
 * hooks built (dynamic client registration adds its clients).
 *
 * A jwks_uri that cannot be used (refused by the destination policy, not
 * answering, answering something else than a JWK Set) is logged with its host
 * and the reason, and the error goes on to the caller: a Request Object is
 * then refused with a fixed error_description that says nothing of the reason.
 *
 * fetch replaces globalThis.fetch (an egress proxy: the destination check sees
 * the host of a jwks_uri, not the addresses its name resolves to), and cache
 * the cache of the process (tests).
 */
export function withRegisteredClientJwksUri(
  config: ProviderConfig,
  clientResolver: () => ClientResolver,
  base: ClientKeyResolver,
  options: { fetch?: typeof fetch; cache?: ClientJwksUriCache } = {},
): ClientKeyResolver {
  const cache = options.cache ?? clientJwksUriCache;
  const jwksUriOptions = {
    async findJwksUri(clientId: string): Promise<string | undefined> {
      const client = (await clientResolver().findClient(clientId)) as RegisteredClient | null;
      return client?.jwksUri;
    },
    async load(uri: string, hint?: { kid?: string }) {
      try {
        return await cache.load(uri, hint, clientJwksUriLoadOptionsOf(config, options.fetch));
      } catch (error) {
        if (error instanceof ClientJwksUriError) {
          console.warn(`[oidc-provider] could not use the jwks_uri at ${hostOf(uri)}: ${error.message}`);
        }
        throw error;
      }
    },
  };
  return {
    ...base,
    // provider.ts builds this resolver once, so the settings are read on every
    // call: a change to config after that counts.
    findClientKeys: (clientId, purpose, hint) =>
      withClientJwksUriKeys(base, { ...jwksUriOptions, purposes: config.clientJwksUriPurposes }).findClientKeys(
        clientId,
        purpose,
        hint,
      ),
  };
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
