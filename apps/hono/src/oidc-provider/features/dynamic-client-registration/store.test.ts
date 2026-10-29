import type { ClientKeyResolver } from '@maronn-openid-connect/core';
import type { DynamicallyRegisteredClient } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { describe, expect, it } from 'vitest';
import type { ClientRegistration } from '../../config.js';
import {
  dynamicClientStore,
  InMemoryDynamicallyRegisteredClientStore,
  toClientRegistration,
  withDynamicallyRegisteredClientKeys,
  withDynamicallyRegisteredClients,
} from './store.js';

const RSA_KEY = { kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'client-key', n: 'AQAB', e: 'AQAB' };

function client(clientId: string, redirectUri = 'https://rp.example.com/callback'): ClientRegistration {
  return { clientId, redirectUris: [redirectUri], grantTypes: ['authorization_code'] };
}

/** A configured resolver that knows the given clients. */
function staticResolver(...clients: ClientRegistration[]) {
  return {
    label: 'static',
    async findClient(clientId: string): Promise<ClientRegistration | null> {
      return clients.find((candidate) => candidate.clientId === clientId) ?? null;
    },
  };
}

/** A configured key resolver that knows the keys of one client. */
function staticKeyResolver(clientId: string, keys: Record<string, { keys: unknown[] }>): ClientKeyResolver {
  return {
    async findClientKeys(candidate, purpose) {
      return candidate === clientId ? ((keys[purpose] as { keys: [] }) ?? { keys: [] }) : { keys: [] };
    },
  };
}

function registeredClient(overrides: Partial<DynamicallyRegisteredClient> = {}): DynamicallyRegisteredClient {
  return {
    clientId: 'dcr-record',
    clientSecret: 'secret',
    clientType: 'confidential',
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    responseTypes: ['code'],
    tokenEndpointAuthMethods: ['client_secret_basic'],
    clientIdIssuedAt: 1_767_225_600,
    metadata: {
      redirect_uris: ['https://rp.example.com/callback'],
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: 'Example RP',
    },
    ...overrides,
  };
}

describe('InMemoryDynamicallyRegisteredClientStore', () => {
  it('should return a saved client by its client_id and count the registrations', async () => {
    const store = new InMemoryDynamicallyRegisteredClientStore();

    await store.save(client('dcr-1'));
    await store.save(client('dcr-2'));

    expect(await store.get('dcr-1')).toEqual(client('dcr-1'));
    expect(await store.get('dcr-unknown')).toBeUndefined();
    expect(await store.count()).toBe(2);
  });

  it('should replace a registration saved again under the same client_id', async () => {
    const store = new InMemoryDynamicallyRegisteredClientStore();

    await store.save(client('dcr-1', 'https://old.example.com/cb'));
    await store.save(client('dcr-1', 'https://new.example.com/cb'));

    expect(await store.get('dcr-1')).toEqual(client('dcr-1', 'https://new.example.com/cb'));
    expect(await store.count()).toBe(1);
  });

  it('should delete a registration and leave the others', async () => {
    const store = new InMemoryDynamicallyRegisteredClientStore();
    await store.save(client('dcr-1'));
    await store.save(client('dcr-2'));

    await store.delete('dcr-1');

    expect(await store.get('dcr-1')).toBeUndefined();
    expect(await store.get('dcr-2')).toEqual(client('dcr-2'));
    expect(await store.count()).toBe(1);
  });

  it('should leave the store unchanged when deleting an unknown client_id', async () => {
    const store = new InMemoryDynamicallyRegisteredClientStore();
    await store.save(client('dcr-1'));

    await store.delete('dcr-unknown');

    expect(await store.count()).toBe(1);
  });
});

describe('toClientRegistration', () => {
  // Parity with registerClient() of db/: the record holds the hash, never the plaintext secret.
  it('should build the record of db/ with the secret hash and the registered metadata', () => {
    expect(toClientRegistration(registeredClient(), { clientSecretHash: 'hash', jwksPurposes: ['request_object'] })).toEqual({
      clientId: 'dcr-record',
      clientType: 'confidential',
      redirectUris: ['https://rp.example.com/callback'],
      grantTypes: ['authorization_code'],
      responseTypes: ['code'],
      tokenEndpointAuthMethods: ['client_secret_basic'],
      clientSecretHash: 'hash',
      registrationMetadata: {
        redirect_uris: ['https://rp.example.com/callback'],
        token_endpoint_auth_method: 'client_secret_basic',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        client_name: 'Example RP',
      },
    });
  });

  it('should carry scope, default_max_age and the signed response algs, and leave the secret hash out for a public client', () => {
    const record = toClientRegistration(
      registeredClient({
        clientSecret: undefined,
        clientType: 'public',
        tokenEndpointAuthMethods: ['none'],
        scope: ['openid', 'profile'],
        defaultMaxAge: 60,
        idTokenSignedResponseAlg: 'ES256',
        userinfoSignedResponseAlg: 'RS256',
      }),
      { jwksPurposes: ['request_object'] },
    );

    expect(record).toMatchObject({
      clientType: 'public',
      tokenEndpointAuthMethods: ['none'],
      scope: ['openid', 'profile'],
      defaultMaxAge: 60,
      idTokenSignedResponseAlg: 'ES256',
      userinfoSignedResponseAlg: 'RS256',
    });
    expect(Object.hasOwn(record, 'clientSecretHash')).toBe(false);
    expect(Object.hasOwn(record, 'keys')).toBe(false);
  });

  // OIDC Dynamic Client Registration 1.0 §2: request_uris and
  // request_object_signing_alg reach the authorization endpoint through the client.
  it('should carry request_uris and request_object_signing_alg into the record', () => {
    const record = toClientRegistration(
      registeredClient({
        requestUris: ['https://rp.example.com/requests/a#NjYz'],
        requestObjectSigningAlg: 'RS256',
      }),
      { clientSecretHash: 'hash', jwksPurposes: ['request_object'] },
    );

    expect(record).toMatchObject({
      requestUris: ['https://rp.example.com/requests/a#NjYz'],
      requestObjectSigningAlg: 'RS256',
    });
  });

  // RFC 7591 §2 jwks_uri: the URL is kept for the key resolver to fetch from.
  it('should carry jwks_uri into the record', () => {
    const record = toClientRegistration(registeredClient({ jwksUri: 'https://rp.example.com/jwks.json' }), {
      clientSecretHash: 'hash',
      jwksPurposes: ['request_object'],
    });

    expect(record.jwksUri).toBe('https://rp.example.com/jwks.json');
    expect(Object.hasOwn(record, 'keys')).toBe(false);
  });

  // RFC 7591 §2 jwks: the keys serve every purpose of the config (ClientKeyResolver).
  it('should put the keys of the jwks under every configured purpose', () => {
    const record = toClientRegistration(registeredClient({ jwks: { keys: [RSA_KEY] } }), {
      clientSecretHash: 'hash',
      jwksPurposes: ['request_object', 'private_key_jwt'],
    });

    expect(record.keys).toEqual({ request_object: { keys: [RSA_KEY] }, private_key_jwt: { keys: [RSA_KEY] } });
  });
});

describe('withDynamicallyRegisteredClients', () => {
  it('should find a dynamically registered client the configured resolver does not know', async () => {
    await dynamicClientStore.save(client('dcr-store-test-1'));

    const resolver = withDynamicallyRegisteredClients(staticResolver());

    expect(await resolver.findClient('dcr-store-test-1')).toEqual(client('dcr-store-test-1'));
  });

  // The keys stay with the ClientKeyResolver, as for the clients of db/.
  it('should hand out the client without the keys of its registration', async () => {
    await dynamicClientStore.save({ ...client('dcr-store-test-keys'), keys: { request_object: { keys: [RSA_KEY] } } });

    const resolver = withDynamicallyRegisteredClients(staticResolver());

    expect(await resolver.findClient('dcr-store-test-keys')).toEqual(client('dcr-store-test-keys'));
  });

  it('should answer with the configured client when a dynamic registration has the same client_id', async () => {
    await dynamicClientStore.save(client('shadowed-client', 'https://attacker.example.com/cb'));

    const resolver = withDynamicallyRegisteredClients(staticResolver(client('shadowed-client')));

    expect(await resolver.findClient('shadowed-client')).toEqual(client('shadowed-client'));
  });

  it('should answer null for a client known to neither', async () => {
    const resolver = withDynamicallyRegisteredClients(staticResolver());

    expect(await resolver.findClient('dcr-nobody')).toBeNull();
  });

  it('should keep the other members of the configured resolver', () => {
    expect(withDynamicallyRegisteredClients(staticResolver()).label).toBe('static');
  });
});

/** A fetch that answers every GET with the JWK Set, recording the URLs. */
function jwksFetchStub(keys: unknown[], status = 200): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const stub = (async (input: string | URL | Request) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    return new Response(JSON.stringify({ keys }), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: stub, urls };
}

/** The key settings of config.ts, with the given fetch. */
function keyOptions(jwksUriFetch?: typeof fetch, jwksPurposes: readonly string[] = ['request_object', 'private_key_jwt']) {
  return () => ({ jwksPurposes, jwksUriCacheTtlSeconds: 300, jwksUriFetch });
}

describe('withDynamicallyRegisteredClientKeys', () => {
  it('should hand out the keys of a dynamic registration by purpose when the configured resolver has none', async () => {
    await dynamicClientStore.save({ ...client('dcr-keys-1'), keys: { request_object: { keys: [RSA_KEY] } } });

    const resolver = withDynamicallyRegisteredClientKeys(staticKeyResolver('static-rp', {}), keyOptions());

    expect(await resolver.findClientKeys('dcr-keys-1', 'request_object')).toEqual({ keys: [RSA_KEY] });
    expect(await resolver.findClientKeys('dcr-keys-1', 'dpop')).toEqual({ keys: [] });
  });

  it('should keep the keys of the configured resolver for a client it knows', async () => {
    await dynamicClientStore.save({ ...client('static-rp'), keys: { request_object: { keys: [RSA_KEY] } } });
    const staticKey = { ...RSA_KEY, kid: 'static-key' };

    const resolver = withDynamicallyRegisteredClientKeys(
      staticKeyResolver('static-rp', { request_object: { keys: [staticKey] } }),
      keyOptions(),
    );

    expect(await resolver.findClientKeys('static-rp', 'request_object')).toEqual({ keys: [staticKey] });
  });

  it('should answer an empty key set for a client known to neither', async () => {
    const resolver = withDynamicallyRegisteredClientKeys(staticKeyResolver('static-rp', {}), keyOptions());

    expect(await resolver.findClientKeys('dcr-nobody', 'request_object')).toEqual({ keys: [] });
  });

  // RFC 7591 §2 jwks_uri: the keys come from the client's JWK Set document,
  // fetched with the jwksUriFetch of the config for every configured purpose.
  describe('jwks_uri', () => {
    it('should fetch the JWK Set of a registration that named a jwks_uri, once for every purpose of the config', async () => {
      const jwksUri = 'https://rp.example.com/jwks/dcr-jwks-uri-1';
      await dynamicClientStore.save({ ...client('dcr-jwks-uri-1'), jwksUri });
      const { fetch, urls } = jwksFetchStub([{ kty: 'RSA', kid: 'remote-key', n: 'AQAB', e: 'AQAB' }]);

      const resolver = withDynamicallyRegisteredClientKeys(staticKeyResolver('static-rp', {}), keyOptions(fetch));
      const requestObjectKeys = await resolver.findClientKeys('dcr-jwks-uri-1', 'request_object');
      const privateKeyJwtKeys = await resolver.findClientKeys('dcr-jwks-uri-1', 'private_key_jwt');
      const dpopKeys = await resolver.findClientKeys('dcr-jwks-uri-1', 'dpop');

      expect(requestObjectKeys).toEqual({ keys: [{ kty: 'RSA', kid: 'remote-key', use: 'sig', alg: 'RS256', n: 'AQAB', e: 'AQAB' }] });
      expect(privateKeyJwtKeys).toEqual(requestObjectKeys);
      // dpop is not among the purposes of this config.
      expect(dpopKeys).toEqual({ keys: [] });
      // The document is fetched once and kept (jwksUriCache).
      expect(urls).toEqual([jwksUri]);
    });

    it('should answer an empty key set while the jwks_uri cannot be fetched', async () => {
      const jwksUri = 'https://rp.example.com/jwks/dcr-jwks-uri-2';
      await dynamicClientStore.save({ ...client('dcr-jwks-uri-2'), jwksUri });
      const { fetch } = jwksFetchStub([], 404);

      const resolver = withDynamicallyRegisteredClientKeys(staticKeyResolver('static-rp', {}), keyOptions(fetch));

      expect(await resolver.findClientKeys('dcr-jwks-uri-2', 'request_object')).toEqual({ keys: [] });
    });

    it('should read the settings on every call', async () => {
      const jwksUri = 'https://rp.example.com/jwks/dcr-jwks-uri-3';
      await dynamicClientStore.save({ ...client('dcr-jwks-uri-3'), jwksUri });
      const { fetch, urls } = jwksFetchStub([{ kty: 'RSA', kid: 'remote-key', n: 'AQAB', e: 'AQAB' }]);
      let purposes: readonly string[] = [];
      const resolver = withDynamicallyRegisteredClientKeys(staticKeyResolver('static-rp', {}), () => ({
        jwksPurposes: purposes,
        jwksUriCacheTtlSeconds: 300,
        jwksUriFetch: fetch,
      }));

      const before = await resolver.findClientKeys('dcr-jwks-uri-3', 'request_object');
      purposes = ['request_object'];
      const after = await resolver.findClientKeys('dcr-jwks-uri-3', 'request_object');

      expect(before).toEqual({ keys: [] });
      expect(after.keys).toHaveLength(1);
      expect(urls).toEqual([jwksUri]);
    });
  });
});
