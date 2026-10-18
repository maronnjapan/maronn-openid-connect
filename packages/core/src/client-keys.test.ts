/**
 * クライアントが登録した公開鍵を用途ごとに引く ClientKeyResolver のテスト。
 *
 * createClientJwksKeyResolver() は、クライアントの登録メタデータ jwks
 * （RFC 7591 §2 / ClientInfo.jwks）を、jwks が受け持つ用途の鍵として返す。
 */
import { describe, it, expect } from 'vitest';
import type { ClientInfo, ClientResolver } from './authorization-request.js';
import type { Jwk, JwkSet } from './jwks.js';
import { JWKS_CLIENT_KEY_PURPOSES, createClientJwksKeyResolver } from './client-keys.js';

const signingKey: Jwk = { kty: 'RSA', kid: 'client-key-1', alg: 'RS256', use: 'sig', n: 'n-value', e: 'AQAB' };
const rotatedKey: Jwk = { kty: 'RSA', kid: 'client-key-2', alg: 'RS256', use: 'sig', n: 'n-value-2', e: 'AQAB' };
const emptyKeySet: JwkSet = { keys: [] };

function clientWith(jwks: JwkSet | undefined): ClientInfo {
  return { clientId: 'client-a', redirectUris: ['https://rp.example/cb'], ...(jwks ? { jwks } : {}) };
}

function resolverOf(...clients: ClientInfo[]): ClientResolver {
  return {
    async findClient(clientId) {
      return clients.find((client) => client.clientId === clientId) ?? null;
    },
  };
}

describe('JWKS_CLIENT_KEY_PURPOSES', () => {
  // OIDC Core 1.0 §9 (private_key_jwt) / §6.3.2 (signed Request Objects)
  it('should list the purposes the jwks of a client registration covers', () => {
    expect(JWKS_CLIENT_KEY_PURPOSES).toEqual(['private_key_jwt', 'request_object']);
  });
});

describe('createClientJwksKeyResolver', () => {
  it('should return the jwks of the client for private_key_jwt', async () => {
    const resolver = createClientJwksKeyResolver(resolverOf(clientWith({ keys: [signingKey] })));

    expect(await resolver.findClientKeys('client-a', 'private_key_jwt')).toEqual({ keys: [signingKey] });
  });

  it('should return the jwks of the client for request_object', async () => {
    const resolver = createClientJwksKeyResolver(resolverOf(clientWith({ keys: [signingKey] })));

    expect(await resolver.findClientKeys('client-a', 'request_object')).toEqual({ keys: [signingKey] });
  });

  // RFC 9449 §4.3: a DPoP proof carries its own key, so jwks does not hold DPoP keys.
  it('should return no keys for a purpose the jwks does not cover', async () => {
    const resolver = createClientJwksKeyResolver(resolverOf(clientWith({ keys: [signingKey] })));

    expect(await resolver.findClientKeys('client-a', 'dpop')).toEqual(emptyKeySet);
  });

  it('should return no keys for a client the resolver does not know', async () => {
    const resolver = createClientJwksKeyResolver(resolverOf(clientWith({ keys: [signingKey] })));

    expect(await resolver.findClientKeys('client-b', 'private_key_jwt')).toEqual(emptyKeySet);
  });

  it('should return no keys for a client without jwks', async () => {
    const resolver = createClientJwksKeyResolver(resolverOf(clientWith(undefined)));

    expect(await resolver.findClientKeys('client-a', 'private_key_jwt')).toEqual(emptyKeySet);
  });

  it('should return the jwks for the purposes passed in place of the default ones', async () => {
    const resolver = createClientJwksKeyResolver(resolverOf(clientWith({ keys: [signingKey] })), ['dpop']);

    expect(await resolver.findClientKeys('client-a', 'dpop')).toEqual({ keys: [signingKey] });
    expect(await resolver.findClientKeys('client-a', 'private_key_jwt')).toEqual(emptyKeySet);
  });

  // A key added to or removed from the registration counts from the next call.
  it('should read the client on every call', async () => {
    const registered = clientWith({ keys: [signingKey] });
    const resolver = createClientJwksKeyResolver(resolverOf(registered));
    const first = await resolver.findClientKeys('client-a', 'private_key_jwt');

    registered.jwks = { keys: [rotatedKey] };

    expect(first).toEqual({ keys: [signingKey] });
    expect(await resolver.findClientKeys('client-a', 'private_key_jwt')).toEqual({ keys: [rotatedKey] });
  });

  it('should not share the returned key list with the client registration', async () => {
    const registered = clientWith({ keys: [signingKey] });
    const resolver = createClientJwksKeyResolver(resolverOf(registered));

    const found = await resolver.findClientKeys('client-a', 'private_key_jwt');
    found.keys.push(rotatedKey);

    expect(registered.jwks).toEqual({ keys: [signingKey] });
  });
});
