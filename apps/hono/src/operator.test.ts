import type { Jwk } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { createEmptyDatabase } from './oidc-provider/db/memory/database.js';
import { addClientKey, clearClientKeys, createOperatorApp, presentsOperatorToken, removeClientKey } from './operator.js';

const OPERATOR_TOKEN = 'operator-token';

function key(kid: string): Jwk {
  return { kty: 'RSA', use: 'sig', alg: 'RS256', kid, n: `n-${kid}`, e: 'AQAB' };
}

function databaseWithClient(keys?: Jwk[]) {
  const db = createEmptyDatabase();
  db.clients.set('rp-1', {
    clientId: 'rp-1',
    redirectUris: ['https://rp.example.com/callback'],
    ...(keys ? { keys: { request_object: { keys } } } : {}),
  });
  return db;
}

describe('presentsOperatorToken', () => {
  it('should accept exactly the operator token as a Bearer token', () => {
    expect(presentsOperatorToken('Bearer operator-token', OPERATOR_TOKEN)).toBe(true);
  });

  it('should refuse a missing header, another token and another scheme', () => {
    expect(presentsOperatorToken(undefined, OPERATOR_TOKEN)).toBe(false);
    expect(presentsOperatorToken('Bearer other-token', OPERATOR_TOKEN)).toBe(false);
    expect(presentsOperatorToken('Basic operator-token', OPERATOR_TOKEN)).toBe(false);
  });
});

describe('addClientKey', () => {
  it('should add the key after the keys the client has for the purpose', () => {
    const db = databaseWithClient([key('a')]);

    expect(addClientKey(db, 'rp-1', 'request_object', key('b'))).toBe(true);
    expect(db.clients.get('rp-1')?.keys).toEqual({ request_object: { keys: [key('a'), key('b')] } });
  });

  it('should answer false for a client that is not registered', () => {
    expect(addClientKey(createEmptyDatabase(), 'unknown', 'request_object', key('a'))).toBe(false);
  });
});

describe('removeClientKey', () => {
  it('should remove only the key with the kid', () => {
    const db = databaseWithClient([key('a'), key('b')]);

    expect(removeClientKey(db, 'rp-1', 'request_object', 'a')).toBe(true);
    expect(db.clients.get('rp-1')?.keys).toEqual({ request_object: { keys: [key('b')] } });
  });
});

describe('clearClientKeys', () => {
  it('should remove every key of the client and keep the rest of its registration', () => {
    const db = databaseWithClient([key('a')]);

    expect(clearClientKeys(db, 'rp-1')).toBe(true);
    expect(db.clients.get('rp-1')).toEqual({ clientId: 'rp-1', redirectUris: ['https://rp.example.com/callback'] });
  });
});

describe('createOperatorApp', () => {
  const auth = { Authorization: `Bearer ${OPERATOR_TOKEN}` };

  it('should answer 401 to a request without the operator token', async () => {
    const app = createOperatorApp(databaseWithClient(), OPERATOR_TOKEN);

    const response = await app.request('/clients/rp-1/keys', { method: 'DELETE' });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('should add a posted key to the client and answer 204', async () => {
    const db = databaseWithClient();
    const app = createOperatorApp(db, OPERATOR_TOKEN);

    const response = await app.request('/clients/rp-1/keys/request_object', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(key('a')),
    });

    expect(response.status).toBe(204);
    expect(db.clients.get('rp-1')?.keys).toEqual({ request_object: { keys: [key('a')] } });
  });

  it('should answer 404 for a client that is not registered', async () => {
    const app = createOperatorApp(createEmptyDatabase(), OPERATOR_TOKEN);

    const response = await app.request('/clients/unknown/keys/request_object/a', { method: 'DELETE', headers: auth });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('should remove one key by kid, and every key, with 204', async () => {
    const db = databaseWithClient([key('a'), key('b')]);
    const app = createOperatorApp(db, OPERATOR_TOKEN);

    const removeOne = await app.request('/clients/rp-1/keys/request_object/a', { method: 'DELETE', headers: auth });
    const keysAfterOne = db.clients.get('rp-1')?.keys;
    const removeAll = await app.request('/clients/rp-1/keys', { method: 'DELETE', headers: auth });

    expect([removeOne.status, removeAll.status]).toEqual([204, 204]);
    expect(keysAfterOne).toEqual({ request_object: { keys: [key('b')] } });
    expect(db.clients.get('rp-1')?.keys).toBeUndefined();
  });
});
