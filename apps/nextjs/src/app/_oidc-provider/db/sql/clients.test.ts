import { hashClientSecret, type Jwk } from '@maronn-openid-connect/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../../../test-support/databases';
import { createClientKeyResolver, createClientResolver, registerClient } from './clients';
import type { SqlDatabase } from './database';

const requestObjectKey: Jwk = { kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'ro-1', n: 'AQAB-n', e: 'AQAB' };
const privateKeyJwtKey: Jwk = { kty: 'EC', use: 'sig', alg: 'ES256', kid: 'pkj-1', crv: 'P-256', x: 'x-1', y: 'y-1' };

let db: SqlDatabase;

beforeEach(() => {
  db = createSqliteDatabase();
});

function rows(sql: string, ...params: string[]): Promise<unknown[]> {
  return db.all({ sql, params });
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

      expect(await rows('SELECT id, name, client_type, is_deleted FROM clients')).toEqual([
        { id: 'rp-1', name: 'RP One', client_type: 'confidential', is_deleted: 0 },
      ]);
      expect(await rows('SELECT client_id, client_auth_type FROM client_auths')).toEqual([
        { client_id: 'rp-1', client_auth_type: 'client_secret_basic' },
      ]);
      expect(await rows('SELECT client_auth_type, secret FROM client_secrets')).toEqual([
        { client_auth_type: 'client_secret_basic', secret: await hashClientSecret('s3cret') },
      ]);
    });

    // RFC 7591 §2: a client has one client_secret, whichever method presents it.
    it('should give each token endpoint auth method a row of its own with the same secret', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        clientSecret: 's3cret',
        redirectUris: ['https://rp.example.com/callback'],
        tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post'],
      });

      const secretHash = await hashClientSecret('s3cret');
      expect(await rows('SELECT client_auth_type, secret FROM client_secrets ORDER BY client_auth_type')).toEqual([
        { client_auth_type: 'client_secret_basic', secret: secretHash },
        { client_auth_type: 'client_secret_post', secret: secretHash },
      ]);
    });

    // RFC 7591 §2: token_endpoint_auth_method defaults to client_secret_basic.
    it('should save client_secret_basic for a client registered without tokenEndpointAuthMethods', async () => {
      await registerClient(db, { clientId: 'rp-1', clientSecret: 's3cret', redirectUris: ['https://rp.example.com/callback'] });

      expect(await rows('SELECT client_auth_type FROM client_secrets')).toEqual([{ client_auth_type: 'client_secret_basic' }]);
    });

    it('should save a clientSecretHash as it is given', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        clientSecretHash: 'precomputed-hash',
        redirectUris: ['https://rp.example.com/callback'],
      });

      expect(await rows('SELECT secret FROM client_secrets')).toEqual([{ secret: 'precomputed-hash' }]);
    });

    // OAuth 2.1 §2.4: a public client does not authenticate at the token endpoint.
    it('should register a client whose method is none as public, without client authentication rows', async () => {
      await registerClient(db, { clientId: 'spa', redirectUris: ['https://spa.example.com/cb'], tokenEndpointAuthMethods: ['none'] });

      expect(await rows('SELECT id, client_type FROM clients')).toEqual([{ id: 'spa', client_type: 'public' }]);
      expect(await rows('SELECT COUNT(*) AS count FROM client_auths')).toEqual([{ count: 0 }]);
    });

    it('should save no client authentication rows for a confidential client without a secret', async () => {
      await registerClient(db, { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] });

      expect(await rows('SELECT id, client_type FROM clients')).toEqual([{ id: 'rp-1', client_type: 'confidential' }]);
      expect(await rows('SELECT COUNT(*) AS count FROM client_auths')).toEqual([{ count: 0 }]);
    });

    it('should reject tokenEndpointAuthMethods that list none with another method and save nothing', async () => {
      await expect(
        registerClient(db, {
          clientId: 'rp-1',
          redirectUris: ['https://rp.example.com/callback'],
          tokenEndpointAuthMethods: ['none', 'client_secret_basic'],
        }),
      ).rejects.toThrow('tokenEndpointAuthMethods must not list none together with another method');
      expect(await rows('SELECT COUNT(*) AS count FROM clients')).toEqual([{ count: 0 }]);
    });
  });

  describe('Client Metadata', () => {
    it('should save the redirect URIs, grant types and scopes as rows of the client', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        redirectUris: ['https://rp.example.com/callback'],
        grantTypes: ['authorization_code', 'refresh_token'],
        scope: ['openid', 'profile'],
      });

      expect(await rows('SELECT client_id, value FROM client_redirect_uris')).toEqual([
        { client_id: 'rp-1', value: 'https://rp.example.com/callback' },
      ]);
      expect(await rows('SELECT client_id, grant_type FROM client_grant_types ORDER BY grant_type')).toEqual([
        { client_id: 'rp-1', grant_type: 'authorization_code' },
        { client_id: 'rp-1', grant_type: 'refresh_token' },
      ]);
      expect(await rows('SELECT client_id, value FROM client_scopes ORDER BY value')).toEqual([
        { client_id: 'rp-1', value: 'openid' },
        { client_id: 'rp-1', value: 'profile' },
      ]);
    });

    // OIDC Core 1.0 §3.2.2.1: a client of the Implicit Flow registers its response types.
    it('should save the response types as rows of the client', async () => {
      await registerClient(db, {
        clientId: 'spa',
        redirectUris: ['https://spa.example.com/cb'],
        grantTypes: ['implicit'],
        responseTypes: ['id_token token', 'id_token'],
        tokenEndpointAuthMethods: ['none'],
      });

      expect(await rows('SELECT client_id, response_type FROM client_response_types ORDER BY response_type')).toEqual([
        { client_id: 'spa', response_type: 'id_token' },
        { client_id: 'spa', response_type: 'id_token token' },
      ]);
    });

    it('should save no response type rows for a client registered without response types', async () => {
      await registerClient(db, { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] });

      expect(await rows('SELECT response_type FROM client_response_types')).toEqual([]);
    });

    // OIDC Core 1.0 §6.2: the request_uri values the client pre-registered.
    it('should save the request URIs as rows of the client', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        redirectUris: ['https://rp.example.com/callback'],
        requestUris: ['https://rp.example.com/requests/a#NjYz'],
      });

      expect(await rows('SELECT client_id, value FROM client_request_uris')).toEqual([
        { client_id: 'rp-1', value: 'https://rp.example.com/requests/a#NjYz' },
      ]);
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

      expect(await createClientResolver(db).findClient('rp-1')).toEqual({
        clientId: 'rp-1',
        clientType: 'confidential',
        redirectUris: ['https://new.example.com/cb'],
      });
      expect(
        await rows(
          'SELECT (SELECT COUNT(*) FROM client_auths) AS auths, (SELECT COUNT(*) FROM client_secrets) AS secrets, ' +
            '(SELECT COUNT(*) FROM client_redirect_uris) AS redirect_uris, ' +
            '(SELECT COUNT(*) FROM client_grant_types) AS grant_types, (SELECT COUNT(*) FROM client_scopes) AS scopes',
        ),
      ).toEqual([{ auths: 0, secrets: 0, redirect_uris: 1, grant_types: 0, scopes: 0 }]);
    });

    it('should replace the method and the secret of a client registered with new ones', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        clientSecret: 'old',
        redirectUris: ['https://rp.example.com/callback'],
        tokenEndpointAuthMethods: ['client_secret_basic'],
      });
      await registerClient(db, {
        clientId: 'rp-1',
        clientSecret: 'new',
        redirectUris: ['https://rp.example.com/callback'],
        tokenEndpointAuthMethods: ['client_secret_post'],
      });

      expect(await rows('SELECT a.client_auth_type, s.secret FROM client_auths a JOIN client_secrets s ON s.id = a.id')).toEqual([
        { client_auth_type: 'client_secret_post', secret: await hashClientSecret('new') },
      ]);
    });

    it('should replace the secret of a client registered again with the same method', async () => {
      const client = { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] };
      await registerClient(db, { ...client, clientSecret: 'old' });
      await registerClient(db, { ...client, clientSecret: 'new' });

      expect(await rows('SELECT client_auth_type, secret FROM client_secrets')).toEqual([
        { client_auth_type: 'client_secret_basic', secret: await hashClientSecret('new') },
      ]);
    });

    // Every instance of the OP may register its clients at startup: the same values write the same rows.
    it('should leave the rows as they are when the same client is registered again', async () => {
      const client = {
        clientId: 'rp-1',
        clientSecret: 's3cret',
        redirectUris: ['https://rp.example.com/callback'],
        grantTypes: ['authorization_code'],
        scope: ['openid'],
        keys: { request_object: { keys: [requestObjectKey] } },
      };
      const snapshot = () =>
        rows(
          'SELECT id, client_id AS owner FROM client_auths UNION ALL SELECT id, secret FROM client_secrets ' +
            'UNION ALL SELECT id, client_id FROM client_redirect_uris UNION ALL SELECT id, client_id FROM client_grant_types ' +
            'UNION ALL SELECT id, client_id FROM client_scopes UNION ALL SELECT id, client_id FROM client_jwks ORDER BY id',
        );
      await registerClient(db, client);
      const first = await snapshot();

      await registerClient(db, client);

      expect(first).toHaveLength(6);
      expect(await snapshot()).toEqual(first);
    });

    it('should make a deleted client known again when it is registered again', async () => {
      await registerClient(db, { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] });
      await db.run({ sql: "UPDATE clients SET is_deleted = TRUE WHERE id = 'rp-1'", params: [] });

      await registerClient(db, { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] });

      expect(await rows('SELECT is_deleted FROM clients')).toEqual([{ is_deleted: 0 }]);
    });
  });

  describe('Client Keys', () => {
    it('should save each key as a row of its purpose', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        redirectUris: ['https://rp.example.com/callback'],
        keys: { request_object: { keys: [requestObjectKey] }, private_key_jwt: { keys: [privateKeyJwtKey] } },
      });

      expect(await rows('SELECT client_id, purpose, jwk FROM client_jwks ORDER BY purpose')).toEqual([
        { client_id: 'rp-1', purpose: 'private_key_jwt', jwk: JSON.stringify(privateKeyJwtKey) },
        { client_id: 'rp-1', purpose: 'request_object', jwk: JSON.stringify(requestObjectKey) },
      ]);
    });

    it('should save a key listed under two purposes as two rows', async () => {
      await registerClient(db, {
        clientId: 'rp-1',
        redirectUris: ['https://rp.example.com/callback'],
        keys: { request_object: { keys: [requestObjectKey] }, private_key_jwt: { keys: [requestObjectKey] } },
      });

      expect(await rows('SELECT purpose, jwk FROM client_jwks ORDER BY purpose')).toEqual([
        { purpose: 'private_key_jwt', jwk: JSON.stringify(requestObjectKey) },
        { purpose: 'request_object', jwk: JSON.stringify(requestObjectKey) },
      ]);
    });

    it('should keep the keys of an earlier registration and add a listed key only once', async () => {
      const client = { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] };
      await registerClient(db, { ...client, keys: { request_object: { keys: [requestObjectKey] } } });
      await registerClient(db, client);
      await registerClient(db, { ...client, keys: { request_object: { keys: [requestObjectKey] } } });

      expect(await rows('SELECT purpose, jwk FROM client_jwks')).toEqual([
        { purpose: 'request_object', jwk: JSON.stringify(requestObjectKey) },
      ]);
    });
  });
});

describe('createClientResolver', () => {
  it('should turn the rows of a confidential client into a RegisteredClient with the hash of its secret', async () => {
    await registerClient(db, {
      clientId: 'rp-1',
      clientSecret: 's3cret',
      redirectUris: ['https://rp.example.com/callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
      scope: ['openid', 'profile'],
      tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post'],
    });

    // The rows come back in the order of their ids (the SHA-256 of client_id, table and value),
    // not in the order they were registered: refresh_token comes first here.
    expect(await createClientResolver(db).findClient('rp-1')).toEqual({
      clientId: 'rp-1',
      clientType: 'confidential',
      redirectUris: ['https://rp.example.com/callback'],
      grantTypes: ['refresh_token', 'authorization_code'],
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
      responseTypes: ['id_token token', 'id_token'],
      tokenEndpointAuthMethods: ['none'],
    });

    const client = await createClientResolver(db).findClient('spa');

    // The rows come back in the order of their ids, which is not the order they were registered in.
    expect([...(client?.responseTypes ?? [])].sort()).toEqual(['id_token', 'id_token token']);
  });

  // OIDC Core 1.0 §6.2: the request_uri values the client pre-registered, and
  // none for a client that registered none.
  it('should find the request URIs a client registered', async () => {
    await registerClient(db, {
      clientId: 'rp-1',
      redirectUris: ['https://rp.example.com/callback'],
      requestUris: ['https://rp.example.com/requests/a#NjYz'],
    });
    await registerClient(db, { clientId: 'rp-2', redirectUris: ['https://rp.example.com/callback'] });

    expect((await createClientResolver(db).findClient('rp-1'))?.requestUris).toEqual([
      'https://rp.example.com/requests/a#NjYz',
    ]);
    expect(Object.hasOwn((await createClientResolver(db).findClient('rp-2')) ?? {}, 'requestUris')).toBe(false);
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
    await db.run({ sql: "UPDATE clients SET is_deleted = TRUE WHERE id = 'rp-1'", params: [] });

    expect(await createClientResolver(db).findClient('rp-1')).toBeNull();
  });

  // RFC 7591 §2: a client has one client_secret, so rows with two secrets are a configuration error.
  it('should reject a client whose client_auths rows carry different secrets', async () => {
    await registerClient(db, {
      clientId: 'rp-1',
      clientSecret: 's3cret',
      redirectUris: ['https://rp.example.com/callback'],
      tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post'],
    });
    await db.run({ sql: "UPDATE client_secrets SET secret = 'other' WHERE client_auth_type = 'client_secret_post'", params: [] });

    await expect(createClientResolver(db).findClient('rp-1')).rejects.toThrow(
      'Client rp-1 has client_auths rows with different secrets',
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
    await db.run({ sql: "UPDATE clients SET is_deleted = TRUE WHERE id = 'rp-1'", params: [] });

    expect(await createClientKeyResolver(db).findClientKeys('rp-1', 'request_object')).toEqual({ keys: [] });
  });

  it('should return a key inserted into client_jwks while the OP runs from the next call', async () => {
    await registerClient(db, { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] });
    const resolver = createClientKeyResolver(db);
    const before = await resolver.findClientKeys('rp-1', 'dpop');

    await db.run({
      sql: "INSERT INTO client_jwks (id, client_id, purpose, jwk) VALUES ('rp-1:dpop:1', 'rp-1', 'dpop', ?)",
      params: [JSON.stringify(privateKeyJwtKey)],
    });

    expect(before).toEqual({ keys: [] });
    expect(await resolver.findClientKeys('rp-1', 'dpop')).toEqual({ keys: [privateKeyJwtKey] });
  });

  it('should reject a client_jwks row that is not a JSON object', async () => {
    await registerClient(db, { clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] });
    const resolver = createClientKeyResolver(db);
    const insertKey = (purpose: string, jwk: string) =>
      db.run({
        sql: 'INSERT INTO client_jwks (id, client_id, purpose, jwk) VALUES (?, ?, ?, ?)',
        params: [purpose, 'rp-1', purpose, jwk],
      });
    await insertKey('not-json', '{"kty":');
    await insertKey('array', '[{"kty":"RSA"}]');
    await insertKey('null', 'null');

    const message = 'Client rp-1 has a client_jwks row that is not a JSON JWK';
    await expect(resolver.findClientKeys('rp-1', 'not-json')).rejects.toThrow(message);
    await expect(resolver.findClientKeys('rp-1', 'array')).rejects.toThrow(message);
    await expect(resolver.findClientKeys('rp-1', 'null')).rejects.toThrow(message);
  });
});
