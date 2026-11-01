import {
  ClientJwksUriError,
  createClientJwksUriCache,
  type ClientJwksUriCache,
  type Jwk,
} from '@maronn-openid-connect/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextOf } from '../test-support/context.js';
import { clientJwksUriCache, withRegisteredClientJwksUri } from './client-jwks-uri.js';
import { createProviderConfig, type ProviderConfig, type RegisteredClient } from './config.js';

const JWKS_URI = 'https://rp.example.com/jwks.json';
const storedKey: Jwk = { kty: 'RSA', kid: 'stored', use: 'sig', alg: 'RS256', n: 'n', e: 'AQAB' };

let rsaN: string | undefined;

async function rsaModulus(): Promise<string> {
  if (rsaN === undefined) {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    rsaN = (await crypto.subtle.exportKey('jwk', pair.publicKey)).n!;
  }
  return rsaN;
}

async function jwkSetResponse(kids: string[]): Promise<Response> {
  const n = await rsaModulus();
  return new Response(JSON.stringify({ keys: kids.map((kid) => ({ kty: 'RSA', kid, n, e: 'AQAB' })) }), { status: 200 });
}

function clientsOf(...clients: RegisteredClient[]) {
  return {
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      return clients.find((client) => client.clientId === clientId) ?? null;
    },
  };
}

function setUp(
  input: {
    config?: Partial<ProviderConfig>;
    clients?: RegisteredClient[];
    fetch?: typeof fetch;
    cache?: ClientJwksUriCache;
  } = {},
) {
  const base = { findClientKeys: vi.fn(async () => ({ keys: [storedKey] })) };
  const fetch = vi.fn(input.fetch ?? (async () => jwkSetResponse(['k1'])));
  const c = contextOf(undefined, {
    config: createProviderConfig(input.config),
    clientResolver: clientsOf(...(input.clients ?? [])),
  });
  const resolver = withRegisteredClientJwksUri(c, base, { fetch, cache: input.cache ?? createClientJwksUriCache() });
  return { c, base, fetch, resolver };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withRegisteredClientJwksUri', () => {
  // UC-1: the keys of a client with a jwksUri come from its jwks_uri (RFC 7591 §2).
  it('should return the keys of the jwks_uri of a client with a jwksUri', async () => {
    const { base, fetch, resolver } = setUp({
      clients: [{ clientId: 'rp', redirectUris: ['https://rp.example.com/cb'], jwksUri: JWKS_URI }],
    });

    const jwks = await resolver.findClientKeys('rp', 'request_object', { kid: 'k1' });

    expect(jwks.keys.map((key) => ({ kid: key.kid, alg: key.alg, use: key.use }))).toEqual([
      { kid: 'k1', alg: 'RS256', use: 'sig' },
    ]);
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([JWKS_URI]);
    expect(base.findClientKeys).not.toHaveBeenCalled();
  });

  // UC-3: the DCR feature replaces clientResolver in its context hook, after
  // app.ts wrapped the ClientKeyResolver, so the client is looked up on use.
  it('should look the client up with the clientResolver the context holds when the keys are asked for', async () => {
    const { c, resolver } = setUp();
    c.set('clientResolver', clientsOf({ clientId: 'dcr-1', redirectUris: ['https://rp.example.com/cb'], jwksUri: JWKS_URI }));

    const jwks = await resolver.findClientKeys('dcr-1', 'request_object');

    expect(jwks.keys.map((key) => key.kid)).toEqual(['k1']);
  });

  it('should return the keys of the base, with the hint, for a client without a jwksUri', async () => {
    const { base, fetch, resolver } = setUp({
      clients: [{ clientId: 'rp', redirectUris: ['https://rp.example.com/cb'] }],
    });

    expect(await resolver.findClientKeys('rp', 'request_object', { kid: 'stored' })).toEqual({ keys: [storedKey] });
    expect(base.findClientKeys).toHaveBeenCalledWith('rp', 'request_object', { kid: 'stored' });
    expect(fetch).not.toHaveBeenCalled();
  });

  // D-18: clientJwksUriPurposes decides which purposes the jwks_uri serves.
  it('should return the keys of the base for a purpose outside clientJwksUriPurposes', async () => {
    const { base, fetch, resolver } = setUp({
      config: { clientJwksUriPurposes: ['request_object'] },
      clients: [{ clientId: 'rp', redirectUris: ['https://rp.example.com/cb'], jwksUri: JWKS_URI }],
    });

    expect(await resolver.findClientKeys('rp', 'dpop')).toEqual({ keys: [storedKey] });
    expect(base.findClientKeys).toHaveBeenCalledWith('rp', 'dpop', undefined);
    expect(fetch).not.toHaveBeenCalled();
  });

  // UC-6 / UC-7: the settings of the config reach the fetch.
  describe('settings', () => {
    it('should refuse an http loopback jwks_uri without allowInsecureClientJwksUri', async () => {
      const { fetch, resolver } = setUp({
        clients: [{ clientId: 'rp', redirectUris: ['https://rp.example.com/cb'], jwksUri: 'http://127.0.0.1:3020/jwks.json' }],
      });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(resolver.findClientKeys('rp', 'request_object')).rejects.toThrow(
        new ClientJwksUriError('jwks_uri must use https'),
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should fetch an http loopback jwks_uri with allowInsecureClientJwksUri', async () => {
      const { fetch, resolver } = setUp({
        config: { allowInsecureClientJwksUri: true },
        clients: [{ clientId: 'rp', redirectUris: ['https://rp.example.com/cb'], jwksUri: 'http://127.0.0.1:3020/jwks.json' }],
      });

      expect((await resolver.findClientKeys('rp', 'request_object')).keys.map((key) => key.kid)).toEqual(['k1']);
      expect(fetch.mock.calls.map(([input]) => input)).toEqual(['http://127.0.0.1:3020/jwks.json']);
    });

    it('should apply clientJwksUriMaxKeys', async () => {
      const { resolver } = setUp({
        config: { clientJwksUriMaxKeys: 1 },
        clients: [{ clientId: 'rp', redirectUris: ['https://rp.example.com/cb'], jwksUri: JWKS_URI }],
        fetch: async () => jwkSetResponse(['k1', 'k2']),
      });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(resolver.findClientKeys('rp', 'request_object')).rejects.toThrow(
        new ClientJwksUriError('the jwks_uri JWK Set has more than 1 keys'),
      );
    });

    it('should refetch an unknown kid at once with clientJwksUriRefetchIntervalSeconds 0', async () => {
      const responses = [['k1'], ['k1', 'k2']];
      const { fetch, resolver } = setUp({
        config: { clientJwksUriRefetchIntervalSeconds: 0 },
        clients: [{ clientId: 'rp', redirectUris: ['https://rp.example.com/cb'], jwksUri: JWKS_URI }],
        fetch: async () => jwkSetResponse(responses.shift()!),
      });

      await resolver.findClientKeys('rp', 'request_object', { kid: 'k1' });
      const rotated = await resolver.findClientKeys('rp', 'request_object', { kid: 'k2' });

      expect(rotated.keys.map((key) => key.kid)).toEqual(['k1', 'k2']);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  // D-14: the reason goes to the log of the OP, not to the client.
  it('should log the host and the reason of a failure and throw it again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { resolver } = setUp({
      clients: [{ clientId: 'rp', redirectUris: ['https://rp.example.com/cb'], jwksUri: JWKS_URI }],
      fetch: async () => new Response('missing', { status: 404 }),
    });

    await expect(resolver.findClientKeys('rp', 'request_object')).rejects.toThrow(
      new ClientJwksUriError('the jwks_uri answered HTTP 404'),
    );
    expect(warn.mock.calls).toEqual([
      ['[oidc-provider] could not use the jwks_uri at rp.example.com: the jwks_uri answered HTTP 404'],
    ]);
  });

  // A cache shared by the process may come from another copy of core (Next.js
  // bundles instrumentation.ts apart from the Route Handlers), so its errors
  // are told apart by shape.
  it('should log a failure the cache throws from another copy of core', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = Object.assign(new Error('the jwks_uri answered HTTP 404'), { name: 'ClientJwksUriError' });
    const { resolver } = setUp({
      clients: [{ clientId: 'rp', redirectUris: ['https://rp.example.com/cb'], jwksUri: JWKS_URI }],
      cache: {
        load: async () => {
          throw failure;
        },
      },
    });

    await expect(resolver.findClientKeys('rp', 'request_object')).rejects.toBe(failure);
    expect(warn.mock.calls).toEqual([
      ['[oidc-provider] could not use the jwks_uri at rp.example.com: the jwks_uri answered HTTP 404'],
    ]);
  });
});

describe('clientJwksUriCache', () => {
  // Kept on globalThis like the database and the DCR store, so a module loaded
  // twice (dev-mode reloads, separate bundles) shares one cache.
  it('should be the cache kept on globalThis', () => {
    const registry = globalThis as typeof globalThis & { __oidcClientJwksUriCache?: unknown };

    expect(registry.__oidcClientJwksUriCache).toBe(clientJwksUriCache);
  });
});
