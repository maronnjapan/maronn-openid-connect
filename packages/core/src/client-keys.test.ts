/**
 * クライアントが用途ごとに登録した公開鍵を引く ClientKeyResolver のテスト。
 *
 * createClientKeyResolver() は、クライアントごとの「用途 → JWK Set」から、
 * 求められた用途の鍵だけを返す。
 */
import { describe, it, expect } from 'vitest';
import type { Jwk, JwkSet } from './jwks.js';
import { createClientKeyResolver, type ClientKeysByPurpose } from './client-keys.js';

const signingKey: Jwk = { kty: 'RSA', kid: 'client-key-1', alg: 'RS256', use: 'sig', n: 'n-value', e: 'AQAB' };
const requestObjectKey: Jwk = { kty: 'RSA', kid: 'client-key-2', alg: 'RS256', use: 'sig', n: 'n-value-2', e: 'AQAB' };
const emptyKeySet: JwkSet = { keys: [] };

function lookupOf(registered: Record<string, ClientKeysByPurpose>) {
  return (clientId: string): ClientKeysByPurpose | undefined => registered[clientId];
}

describe('createClientKeyResolver', () => {
  it('should return the keys the client registered for the purpose', async () => {
    const resolver = createClientKeyResolver(
      lookupOf({ 'client-a': { private_key_jwt: { keys: [signingKey] } } }),
    );

    expect(await resolver.findClientKeys('client-a', 'private_key_jwt')).toEqual({ keys: [signingKey] });
  });

  // A key registered for signed Request Objects does not verify client assertions.
  it('should keep the keys of each purpose apart', async () => {
    const resolver = createClientKeyResolver(
      lookupOf({
        'client-a': {
          private_key_jwt: { keys: [signingKey] },
          request_object: { keys: [requestObjectKey] },
        },
      }),
    );

    expect(await resolver.findClientKeys('client-a', 'private_key_jwt')).toEqual({ keys: [signingKey] });
    expect(await resolver.findClientKeys('client-a', 'request_object')).toEqual({ keys: [requestObjectKey] });
  });

  it('should return no keys for a purpose the client registered no keys for', async () => {
    const resolver = createClientKeyResolver(
      lookupOf({ 'client-a': { private_key_jwt: { keys: [signingKey] } } }),
    );

    expect(await resolver.findClientKeys('client-a', 'dpop')).toEqual(emptyKeySet);
  });

  it('should return no keys for a client the lookup does not know', async () => {
    const resolver = createClientKeyResolver(
      lookupOf({ 'client-a': { private_key_jwt: { keys: [signingKey] } } }),
    );

    expect(await resolver.findClientKeys('client-b', 'private_key_jwt')).toEqual(emptyKeySet);
  });

  // The purpose is a string, so a process added later brings its own.
  it('should return the keys of a purpose outside the known ones', async () => {
    const resolver = createClientKeyResolver(
      lookupOf({ 'client-a': { attestation: { keys: [signingKey] } } }),
    );

    expect(await resolver.findClientKeys('client-a', 'attestation')).toEqual({ keys: [signingKey] });
  });

  it('should accept a lookup that returns a promise', async () => {
    const resolver = createClientKeyResolver(async (clientId) =>
      clientId === 'client-a' ? { request_object: { keys: [requestObjectKey] } } : undefined,
    );

    expect(await resolver.findClientKeys('client-a', 'request_object')).toEqual({ keys: [requestObjectKey] });
  });

  // A key added to or removed from the registration counts from the next call.
  it('should call the lookup on every call', async () => {
    const registered: Record<string, ClientKeysByPurpose> = {
      'client-a': { private_key_jwt: { keys: [signingKey] } },
    };
    const resolver = createClientKeyResolver(lookupOf(registered));
    const first = await resolver.findClientKeys('client-a', 'private_key_jwt');

    registered['client-a'] = { private_key_jwt: { keys: [requestObjectKey] } };

    expect(first).toEqual({ keys: [signingKey] });
    expect(await resolver.findClientKeys('client-a', 'private_key_jwt')).toEqual({ keys: [requestObjectKey] });
  });

  it('should not share the returned key list with the registration', async () => {
    const registered: ClientKeysByPurpose = { private_key_jwt: { keys: [signingKey] } };
    const resolver = createClientKeyResolver(() => registered);

    const found = await resolver.findClientKeys('client-a', 'private_key_jwt');
    found.keys.push(requestObjectKey);

    expect(registered.private_key_jwt).toEqual({ keys: [signingKey] });
  });
});
