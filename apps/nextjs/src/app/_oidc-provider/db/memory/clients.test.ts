import { hashClientSecret, type Jwk } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { createClientKeyResolver, createClientResolver, registerClient } from './clients';
import { createEmptyDatabase } from './database';

const requestObjectKey: Jwk = { kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'ro-1', n: 'AQAB-n', e: 'AQAB' };

describe('registerClient', () => {
  it('should keep the hash of the client secret, never the secret itself', async () => {
    const db = createEmptyDatabase();

    await registerClient(db, {
      clientId: 'rp-1',
      clientSecret: 's3cret',
      redirectUris: ['https://rp.example.com/callback'],
      tokenEndpointAuthMethods: ['client_secret_basic'],
    });

    expect(db.clients.get('rp-1')).toEqual({
      clientId: 'rp-1',
      clientSecretHash: await hashClientSecret('s3cret'),
      redirectUris: ['https://rp.example.com/callback'],
      tokenEndpointAuthMethods: ['client_secret_basic'],
    });
  });

  it('should keep a client without a secret as it is given', async () => {
    const db = createEmptyDatabase();

    await registerClient(db, { clientId: 'spa', redirectUris: ['https://spa.example.com/cb'], tokenEndpointAuthMethods: ['none'] });

    expect(db.clients.get('spa')).toEqual({
      clientId: 'spa',
      redirectUris: ['https://spa.example.com/cb'],
      tokenEndpointAuthMethods: ['none'],
    });
  });

  it('should replace an earlier registration with the same client_id', async () => {
    const db = createEmptyDatabase();

    await registerClient(db, { clientId: 'rp-1', clientSecret: 'old', redirectUris: ['https://old.example.com/cb'] });
    await registerClient(db, { clientId: 'rp-1', redirectUris: ['https://new.example.com/cb'] });

    expect(db.clients.get('rp-1')).toEqual({ clientId: 'rp-1', redirectUris: ['https://new.example.com/cb'] });
  });

  // UC-1 / UC-8: RFC 7591 §2 jwks_uri and OIDC Dynamic Client Registration 1.0 §2
  // request_object_signing_alg.
  it('should keep the jwksUri and the requestObjectSigningAlg of a client', async () => {
    const db = createEmptyDatabase();

    await registerClient(db, {
      clientId: 'rp-uri',
      redirectUris: ['https://rp.example.com/callback'],
      jwksUri: 'https://rp.example.com/jwks.json',
      requestObjectSigningAlg: 'ES256',
    });

    expect(db.clients.get('rp-uri')).toEqual({
      clientId: 'rp-uri',
      redirectUris: ['https://rp.example.com/callback'],
      jwksUri: 'https://rp.example.com/jwks.json',
      requestObjectSigningAlg: 'ES256',
    });
  });

  // The destination policy (allowInsecureClientJwksUri) applies when the keys are fetched.
  it('should keep an http loopback jwksUri', async () => {
    const db = createEmptyDatabase();

    await registerClient(db, {
      clientId: 'rp-dev',
      redirectUris: ['https://rp.example.com/callback'],
      jwksUri: 'http://127.0.0.1:3020/jwks.json',
    });

    expect(db.clients.get('rp-dev')?.jwksUri).toBe('http://127.0.0.1:3020/jwks.json');
  });

  // UC-20 / D-17: one source of keys per client, as RFC 7591 §2 asks of jwks and jwks_uri.
  it('should reject a client that registers both a jwksUri and keys, and keep nothing', async () => {
    const db = createEmptyDatabase();

    await expect(
      registerClient(db, {
        clientId: 'rp-1',
        redirectUris: ['https://rp.example.com/callback'],
        jwksUri: 'https://rp.example.com/jwks.json',
        keys: { request_object: { keys: [requestObjectKey] } },
      }),
    ).rejects.toThrow('Client rp-1 registers both jwksUri and keys: register one of them (RFC 7591 §2)');
    expect(db.clients.has('rp-1')).toBe(false);
  });

  it('should reject a jwksUri that is not an absolute http or https URL', async () => {
    const db = createEmptyDatabase();

    await expect(
      registerClient(db, { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'], jwksUri: '/jwks.json' }),
    ).rejects.toThrow('Client rp-1 has an invalid jwksUri: jwks_uri must be an absolute URI');
    expect(db.clients.has('rp-1')).toBe(false);
  });
});

describe('createClientResolver', () => {
  it('should find the jwksUri and the requestObjectSigningAlg of a client', async () => {
    const db = createEmptyDatabase();
    await registerClient(db, {
      clientId: 'rp-uri',
      redirectUris: ['https://rp.example.com/callback'],
      jwksUri: 'https://rp.example.com/jwks.json',
      requestObjectSigningAlg: 'RS256',
    });

    expect(await createClientResolver(db).findClient('rp-uri')).toEqual({
      clientId: 'rp-uri',
      redirectUris: ['https://rp.example.com/callback'],
      jwksUri: 'https://rp.example.com/jwks.json',
      requestObjectSigningAlg: 'RS256',
    });
  });

  it('should find a registered client without its public keys', async () => {
    const db = createEmptyDatabase();
    await registerClient(db, {
      clientId: 'rp-1',
      redirectUris: ['https://rp.example.com/callback'],
      keys: { request_object: { keys: [requestObjectKey] } },
    });

    expect(await createClientResolver(db).findClient('rp-1')).toEqual({
      clientId: 'rp-1',
      redirectUris: ['https://rp.example.com/callback'],
    });
  });

  it('should find a client registered after the resolver was created, and null for an unknown one', async () => {
    const db = createEmptyDatabase();
    const resolver = createClientResolver(db);

    await registerClient(db, { clientId: 'late', redirectUris: ['https://late.example.com/cb'] });

    expect(await resolver.findClient('late')).toEqual({ clientId: 'late', redirectUris: ['https://late.example.com/cb'] });
    expect(await resolver.findClient('unknown')).toBeNull();
  });
});

describe('createClientKeyResolver', () => {
  it('should return the keys a client registered for the purpose, and none for another purpose or client', async () => {
    const db = createEmptyDatabase();
    await registerClient(db, {
      clientId: 'rp-1',
      redirectUris: ['https://rp.example.com/callback'],
      keys: { request_object: { keys: [requestObjectKey] } },
    });
    const resolver = createClientKeyResolver(db);

    expect(await resolver.findClientKeys('rp-1', 'request_object')).toEqual({ keys: [requestObjectKey] });
    expect(await resolver.findClientKeys('rp-1', 'private_key_jwt')).toEqual({ keys: [] });
    expect(await resolver.findClientKeys('unknown', 'request_object')).toEqual({ keys: [] });
  });
});

// OIDC Core 1.0 §9 / OIDC Dynamic Client Registration 1.0 §2: private_key_jwt, request_uris
// and what the login and consent screens show about a statically registered client.
describe('registerClient with private_key_jwt and display metadata', () => {
  it('should find a private_key_jwt client with its signing alg, request_uris and display metadata', async () => {
    const db = createEmptyDatabase();
    await registerClient(db, {
      clientId: 'rp-jwt',
      redirectUris: ['https://rp.example.com/callback'],
      tokenEndpointAuthMethods: ['private_key_jwt'],
      tokenEndpointAuthSigningAlg: 'ES256',
      jwksUri: 'https://rp.example.com/jwks.json',
      requestUris: ['https://rp.example.com/ro/1#abc'],
      clientName: 'Example RP',
      logoUri: 'https://rp.example.com/logo.png',
      policyUri: 'https://rp.example.com/privacy',
      tosUri: 'https://rp.example.com/terms',
      clientUri: 'https://rp.example.com/',
    });

    expect(await createClientResolver(db).findClient('rp-jwt')).toEqual({
      clientId: 'rp-jwt',
      redirectUris: ['https://rp.example.com/callback'],
      tokenEndpointAuthMethods: ['private_key_jwt'],
      tokenEndpointAuthSigningAlg: 'ES256',
      jwksUri: 'https://rp.example.com/jwks.json',
      requestUris: ['https://rp.example.com/ro/1#abc'],
      clientName: 'Example RP',
      logoUri: 'https://rp.example.com/logo.png',
      policyUri: 'https://rp.example.com/privacy',
      tosUri: 'https://rp.example.com/terms',
      clientUri: 'https://rp.example.com/',
    });
  });

  it('should keep the methods of a client that registers a secret method and private_key_jwt', async () => {
    const db = createEmptyDatabase();
    await registerClient(db, {
      clientId: 'rp-both',
      clientSecret: 's3cret',
      redirectUris: ['https://rp.example.com/callback'],
      tokenEndpointAuthMethods: ['client_secret_basic', 'private_key_jwt'],
    });

    expect(await createClientResolver(db).findClient('rp-both')).toMatchObject({
      tokenEndpointAuthMethods: ['client_secret_basic', 'private_key_jwt'],
    });
  });
});
