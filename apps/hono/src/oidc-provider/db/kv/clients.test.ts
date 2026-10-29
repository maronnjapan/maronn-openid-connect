import { hashClientSecret, type Jwk } from '@maronn-openid-connect/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMapKvDatabase, type MapKvDatabase } from '../../../test-support/databases.js';
import { createClientKeyResolver, createClientResolver, registerClient } from './clients.js';
import { readRecord, writeRecord } from './database.js';
import { keys, type ClientJwksRecord, type ClientRecord } from './keys.js';

const requestObjectKey: Jwk = { kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'ro-1', n: 'AQAB-n', e: 'AQAB' };
const privateKeyJwtKey: Jwk = { kty: 'EC', use: 'sig', alg: 'ES256', kid: 'pkj-1', crv: 'P-256', x: 'x-1', y: 'y-1' };
const rotatedKey: Jwk = { kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'ro-2', n: 'AQAB-n2', e: 'AQAB' };

let db: MapKvDatabase;

beforeEach(() => {
  db = createMapKvDatabase();
});

function clientRecord(clientId: string): Promise<ClientRecord | undefined> {
  return readRecord<ClientRecord>(db, keys.client(clientId));
}

async function markDeleted(clientId: string): Promise<void> {
  const record = await clientRecord(clientId);
  await writeRecord(db, keys.client(clientId), { ...record, is_deleted: true });
}

describe('registerClient', () => {
  describe('Client Authentication', () => {
    it('should save the hash of the client secret, never the secret itself', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        name: 'RP One',
        clientSecret: 's3cret',
        redirectUris: ['https://rp.example.com/callback'],
        tokenEndpointAuthMethods: ['client_secret_basic'],
      });

      expect(db.entries().map(([key]) => key)).toEqual(['oidc:client:rp-1']);
      expect(await clientRecord('rp-1')).toEqual({
        name: 'RP One',
        client_type: 'confidential',
        is_deleted: false,
        client_auths: [{ client_auth_type: 'client_secret_basic', secret: await hashClientSecret('s3cret') }],
        redirect_uris: ['https://rp.example.com/callback'],
        grant_types: [],
        scopes: [],
        response_types: [],
        request_uris: [],
      });
    });

    // RFC 7591 §2: a client has one client_secret, whichever method presents it.
    it('should give each token endpoint auth method an entry of its own with the same secret', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        clientSecret: 's3cret',
        redirectUris: ['https://rp.example.com/callback'],
        tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post'],
      });

      const secret = await hashClientSecret('s3cret');
      expect((await clientRecord('rp-1'))?.client_auths).toEqual([
        { client_auth_type: 'client_secret_basic', secret },
        { client_auth_type: 'client_secret_post', secret },
      ]);
    });

    // RFC 7591 §2: token_endpoint_auth_method defaults to client_secret_basic.
    it('should save client_secret_basic for a client registered without tokenEndpointAuthMethods', async () => {
      await registerClient(db, { clientId: 'rp-1', clientSecret: 's3cret', redirectUris: ['https://rp.example.com/callback'] });

      expect((await clientRecord('rp-1'))?.client_auths).toEqual([
        { client_auth_type: 'client_secret_basic', secret: await hashClientSecret('s3cret') },
      ]);
    });

    it('should save a clientSecretHash as it is given', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        clientSecretHash: 'precomputed-hash',
        redirectUris: ['https://rp.example.com/callback'],
      });

      expect((await clientRecord('rp-1'))?.client_auths).toEqual([
        { client_auth_type: 'client_secret_basic', secret: 'precomputed-hash' },
      ]);
    });

    // OAuth 2.1 §2.4: a public client does not authenticate at the token endpoint.
    it('should register a client whose method is none as public, without client authentication', async () => {
      await registerClient(db, { clientId: 'spa', redirectUris: ['https://spa.example.com/cb'], tokenEndpointAuthMethods: ['none'] });

      expect(await clientRecord('spa')).toEqual({
        name: null,
        client_type: 'public',
        is_deleted: false,
        client_auths: [],
        redirect_uris: ['https://spa.example.com/cb'],
        grant_types: [],
        scopes: [],
        response_types: [],
        request_uris: [],
      });
    });

    it('should save no client authentication for a confidential client without a secret', async () => {
      await registerClient(db, { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] });

      expect(await clientRecord('rp-1')).toEqual({
        name: null,
        client_type: 'confidential',
        is_deleted: false,
        client_auths: [],
        redirect_uris: ['https://rp.example.com/callback'],
        grant_types: [],
        scopes: [],
        response_types: [],
        request_uris: [],
      });
    });

    it('should reject tokenEndpointAuthMethods that list none with another method and save nothing', async () => {
      await expect(
        registerClient(db, {
          clientId: 'rp-1',
          redirectUris: ['https://rp.example.com/callback'],
          tokenEndpointAuthMethods: ['none', 'client_secret_basic'],
        }),
      ).rejects.toThrow('tokenEndpointAuthMethods must not list none together with another method');
      expect(db.entries()).toEqual([]);
    });
  });

  describe('Client Metadata', () => {
    it('should save the redirect URIs, grant types and scopes in the order they are given', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        redirectUris: ['https://rp.example.com/callback', 'https://rp.example.com/other'],
        grantTypes: ['authorization_code', 'refresh_token'],
        scope: ['openid', 'profile'],
      });

      expect(await clientRecord('rp-1')).toMatchObject({
        redirect_uris: ['https://rp.example.com/callback', 'https://rp.example.com/other'],
        grant_types: ['authorization_code', 'refresh_token'],
        scopes: ['openid', 'profile'],
      });
    });

    // OIDC Core 1.0 §3.2.2.1: a client of the Implicit Flow registers its response types.
    it('should save the response types in the order they are given', async () => {
      await registerClient(db, {
        clientId: 'spa',
        redirectUris: ['https://spa.example.com/cb'],
        grantTypes: ['implicit'],
        responseTypes: ['id_token token', 'id_token'],
        tokenEndpointAuthMethods: ['none'],
      });

      expect(await clientRecord('spa')).toMatchObject({
        grant_types: ['implicit'],
        response_types: ['id_token token', 'id_token'],
      });
    });

    // OIDC Core 1.0 §6.2: the request_uri values the client pre-registered.
    it('should save the request URIs in the record', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        redirectUris: ['https://rp.example.com/callback'],
        requestUris: ['https://rp.example.com/requests/a#NjYz'],
      });

      expect(await clientRecord('rp-1')).toMatchObject({ request_uris: ['https://rp.example.com/requests/a#NjYz'] });
    });
  });

  describe('Registering Again', () => {
    it('should replace an earlier registration with the same client_id', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        clientSecret: 'old',
        redirectUris: ['https://old.example.com/cb'],
        grantTypes: ['refresh_token'],
        scope: ['openid'],
      });
      await registerClient(db, { clientId: 'rp-1', redirectUris: ['https://new.example.com/cb'] });

      expect(await clientRecord('rp-1')).toEqual({
        name: null,
        client_type: 'confidential',
        is_deleted: false,
        client_auths: [],
        redirect_uris: ['https://new.example.com/cb'],
        grant_types: [],
        scopes: [],
        response_types: [],
        request_uris: [],
      });
    });

    it('should make a deleted client known again when it is registered again', async () => {
      await registerClient(db, { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] });
      await markDeleted('rp-1');

      await registerClient(db, { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] });

      expect((await clientRecord('rp-1'))?.is_deleted).toBe(false);
    });
  });

  describe('Client Keys', () => {
    it('should save the keys of each purpose under the key of that purpose', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        redirectUris: ['https://rp.example.com/callback'],
        keys: { request_object: { keys: [requestObjectKey] }, private_key_jwt: { keys: [privateKeyJwtKey] } },
      });

      expect(await readRecord<ClientJwksRecord>(db, keys.clientJwks('rp-1', 'request_object'))).toEqual({
        keys: [requestObjectKey],
      });
      expect(await readRecord<ClientJwksRecord>(db, keys.clientJwks('rp-1', 'private_key_jwt'))).toEqual({
        keys: [privateKeyJwtKey],
      });
    });

    it('should write no key record for a purpose listed without keys', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        redirectUris: ['https://rp.example.com/callback'],
        keys: { request_object: { keys: [] } },
      });

      expect(db.entries().map(([key]) => key)).toEqual(['oidc:client:rp-1']);
    });

    it('should append a new key to the stored keys of its purpose and add a listed key only once', async () => {
      const client = { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] };
      await registerClient(db, { ...client, keys: { request_object: { keys: [requestObjectKey] } } });
      await registerClient(db, client);
      await registerClient(db, { ...client, keys: { request_object: { keys: [rotatedKey, requestObjectKey] } } });

      expect(await readRecord<ClientJwksRecord>(db, keys.clientJwks('rp-1', 'request_object'))).toEqual({
        keys: [requestObjectKey, rotatedKey],
      });
    });
  });
});

describe('createClientResolver', () => {
  it('should turn the record of a confidential client into a RegisteredClient with the hash of its secret', async () => {
    await registerClient(db, {
      clientId: 'rp-1',
      clientSecret: 's3cret',
      redirectUris: ['https://rp.example.com/callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
      scope: ['openid', 'profile'],
      tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post'],
    });

    expect(await createClientResolver(db).findClient('rp-1')).toEqual({
      clientId: 'rp-1',
      clientType: 'confidential',
      redirectUris: ['https://rp.example.com/callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
      scope: ['openid', 'profile'],
      tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post'],
      clientSecretHash: await hashClientSecret('s3cret'),
    });
  });

  // OAuth 2.1 §2.4: a public client presents only its client_id.
  it('should find a public client with the method none and no secret', async () => {
    await registerClient(db, { clientId: 'spa', redirectUris: ['https://spa.example.com/cb'], tokenEndpointAuthMethods: ['none'] });

    expect(await createClientResolver(db).findClient('spa')).toEqual({
      clientId: 'spa',
      clientType: 'public',
      redirectUris: ['https://spa.example.com/cb'],
      tokenEndpointAuthMethods: ['none'],
    });
  });

  it('should find a confidential client without a secret with no method and no secret', async () => {
    await registerClient(db, {
      clientId: 'rp-1',
      redirectUris: ['https://rp.example.com/callback'],
      tokenEndpointAuthMethods: ['client_secret_post'],
    });

    expect(await createClientResolver(db).findClient('rp-1')).toEqual({
      clientId: 'rp-1',
      clientType: 'confidential',
      redirectUris: ['https://rp.example.com/callback'],
    });
  });

  // OIDC Dynamic Client Registration 1.0 §2: response_types decides which
  // response types the authorization endpoint accepts from the client.
  it('should find the response types a client registered', async () => {
    await registerClient(db, {
      clientId: 'spa',
      redirectUris: ['https://spa.example.com/cb'],
      grantTypes: ['implicit'],
      responseTypes: ['id_token token', 'id_token'],
      tokenEndpointAuthMethods: ['none'],
    });

    expect(await createClientResolver(db).findClient('spa')).toEqual({
      clientId: 'spa',
      clientType: 'public',
      redirectUris: ['https://spa.example.com/cb'],
      grantTypes: ['implicit'],
      responseTypes: ['id_token token', 'id_token'],
      tokenEndpointAuthMethods: ['none'],
    });
  });

  // OIDC Core 1.0 §6.2: the request_uri values the client pre-registered.
  it('should find the request URIs a client registered', async () => {
    await registerClient(db, {
      clientId: 'rp-1',
      redirectUris: ['https://rp.example.com/callback'],
      requestUris: ['https://rp.example.com/requests/a#NjYz'],
    });

    expect(await createClientResolver(db).findClient('rp-1')).toEqual({
      clientId: 'rp-1',
      clientType: 'confidential',
      redirectUris: ['https://rp.example.com/callback'],
      requestUris: ['https://rp.example.com/requests/a#NjYz'],
    });
  });

  // A record written before response_types existed keeps the default of code only.
  it('should leave responseTypes out for a record without response_types', async () => {
    const record: ClientRecord = {
      name: null,
      client_type: 'confidential',
      is_deleted: false,
      client_auths: [],
      redirect_uris: ['https://rp.example.com/callback'],
      grant_types: [],
      scopes: [],
    };
    await writeRecord(db, keys.client('rp-1'), record);

    expect(await createClientResolver(db).findClient('rp-1')).toEqual({
      clientId: 'rp-1',
      clientType: 'confidential',
      redirectUris: ['https://rp.example.com/callback'],
    });
  });

  it('should find a registered client without its public keys', async () => {
    await registerClient(db, {
      clientId: 'rp-1',
      redirectUris: ['https://rp.example.com/callback'],
      keys: { request_object: { keys: [requestObjectKey] } },
    });

    expect(await createClientResolver(db).findClient('rp-1')).toEqual({
      clientId: 'rp-1',
      clientType: 'confidential',
      redirectUris: ['https://rp.example.com/callback'],
    });
  });

  it('should find a client registered after the resolver was created, and null for an unknown one', async () => {
    const resolver = createClientResolver(db);

    await registerClient(db, { clientId: 'late', redirectUris: ['https://late.example.com/cb'] });

    expect(await resolver.findClient('late')).toEqual({
      clientId: 'late',
      clientType: 'confidential',
      redirectUris: ['https://late.example.com/cb'],
    });
    expect(await resolver.findClient('unknown')).toBeNull();
  });

  it('should return null for a deleted client', async () => {
    await registerClient(db, { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] });
    await markDeleted('rp-1');

    expect(await createClientResolver(db).findClient('rp-1')).toBeNull();
  });

  // RFC 7591 §2: a client has one client_secret, so entries with two secrets are a configuration error.
  it('should reject a client whose client_auths entries carry different secrets', async () => {
    const record: ClientRecord = {
      name: null,
      client_type: 'confidential',
      is_deleted: false,
      client_auths: [
        { client_auth_type: 'client_secret_basic', secret: 'hash-1' },
        { client_auth_type: 'client_secret_post', secret: 'hash-2' },
      ],
      redirect_uris: ['https://rp.example.com/callback'],
      grant_types: [],
      scopes: [],
    };
    await writeRecord(db, keys.client('rp-1'), record);

    await expect(createClientResolver(db).findClient('rp-1')).rejects.toThrow(
      'Client rp-1 has client_auths entries with different secrets',
    );
  });
});

describe('createClientKeyResolver', () => {
  it('should return the keys a client registered for the purpose, and none for another purpose or client', async () => {
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

  it('should return no keys for a deleted client', async () => {
    await registerClient(db, {
      clientId: 'rp-1',
      redirectUris: ['https://rp.example.com/callback'],
      keys: { request_object: { keys: [requestObjectKey] } },
    });
    await markDeleted('rp-1');

    expect(await createClientKeyResolver(db).findClientKeys('rp-1', 'request_object')).toEqual({ keys: [] });
  });

  it('should return the keys written into the store while the OP runs from the next call', async () => {
    await registerClient(db, { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] });
    const resolver = createClientKeyResolver(db);
    const before = await resolver.findClientKeys('rp-1', 'dpop');

    await writeRecord(db, keys.clientJwks('rp-1', 'dpop'), { keys: [privateKeyJwtKey] });

    expect(before).toEqual({ keys: [] });
    expect(await resolver.findClientKeys('rp-1', 'dpop')).toEqual({ keys: [privateKeyJwtKey] });
  });
});
