import { hashClientSecret, type Jwk } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { createClientKeyResolver, createClientResolver, registerClient } from './clients.js';
import { createEmptyDatabase } from './database.js';

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
});

describe('createClientResolver', () => {
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
