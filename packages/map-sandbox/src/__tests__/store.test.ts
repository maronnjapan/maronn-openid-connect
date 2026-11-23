import { describe, expect, it } from 'vitest';
import { createEmptyDatabase, type MemoryDatabase } from '../../../../apps/hono/src/oidc-provider/db/memory/database.js';
import { changesBetween, plainDatabase, plainOf, storeAccess, watchDatabase } from '../store.js';

/** A database holding a code and the granted scopes of a user, as records of the memory database. */
function databaseWithCode(): MemoryDatabase {
  const db = createEmptyDatabase();
  db.codes.set('code-1', { code: 'code-1', clientId: 'client-1', used: false } as never);
  db.consentScopes.set('testuser', new Map([['client-1', new Set(['openid'])]]));
  return db;
}

describe('watchDatabase', () => {
  it('should note the first read of each record, found or not, in the order read', () => {
    const db = databaseWithCode();
    const reads = watchDatabase(db);
    db.codes.get('code-1');
    db.codes.get('code-1');
    db.codes.has('code-9');
    db.clients.get('client-1');

    expect(reads).toEqual([
      { collection: 'codes', key: 'code-1', found: true },
      { collection: 'codes', key: 'code-9', found: false },
      { collection: 'clients', key: 'client-1', found: false },
    ]);
  });

  it('should note a walk over a collection once, without a key, whichever way it walks', () => {
    const db = databaseWithCode();
    const reads = watchDatabase(db);
    for (const entry of db.codes) void entry;
    db.codes.forEach(() => undefined);
    [...db.accessTokens.values()];

    expect(reads).toEqual([
      { collection: 'codes', found: true },
      { collection: 'accessTokens', found: false },
    ]);
  });

  it('should note a lookup inside a record that is a Map itself (the consent of a user to a client) by the record and the member, found or not', () => {
    const db = databaseWithCode();
    const reads = watchDatabase(db);
    db.consentScopes.get('testuser')?.get('client-1');
    db.consentScopes.get('testuser')?.get('client-2');

    expect(reads).toEqual([
      { collection: 'consentScopes', key: 'testuser', found: true },
      { collection: 'consentScopes', key: 'testuser', member: 'client-1', found: true },
      { collection: 'consentScopes', key: 'testuser', member: 'client-2', found: false },
    ]);
  });

  it('should tell a walk over a collection from a lookup of the key `*`', () => {
    const db = databaseWithCode();
    const reads = watchDatabase(db);
    [...db.accessTokens.keys()];
    db.accessTokens.get('*');

    expect(reads).toEqual([
      { collection: 'accessTokens', found: false },
      { collection: 'accessTokens', key: '*', found: false },
    ]);
  });

  it('should not note the read of a record the request wrote before it read it', () => {
    const db = databaseWithCode();
    const reads = watchDatabase(db);
    db.accessTokens.set('token-1', {} as never);
    db.accessTokens.get('token-1');
    db.codes.delete('code-1');
    db.codes.get('code-1');

    expect(reads).toEqual([]);
  });

  it('should keep the records the database held, and the Maps it holds as Maps', () => {
    const db = databaseWithCode();
    watchDatabase(db);

    expect(db.codes).toBeInstanceOf(Map);
    expect(plainDatabase(db).codes).toEqual({ 'code-1': { code: 'code-1', clientId: 'client-1', used: false } });
  });
});

describe('plainOf', () => {
  it('should give a Map as an object of its entries and a Set as an array, member by member', () => {
    expect(plainOf(new Map([['testuser', new Map([['client-1', new Set(['openid', 'profile'])]])]]))).toEqual({ testuser: { 'client-1': ['openid', 'profile'] } });
    expect(plainOf({ scope: ['openid'], expiresAt: 1, nonce: undefined })).toEqual({ scope: ['openid'], expiresAt: 1, nonce: undefined });
  });
});

describe('changesBetween', () => {
  it('should name the records added, changed (with the fields that changed) and removed', () => {
    const before = { codes: { 'code-1': { used: false, scope: ['openid'] }, 'code-2': { used: false } }, refreshTokens: {} };
    const after = { codes: { 'code-1': { used: true, scope: ['openid'] } }, refreshTokens: { 'refresh-1': { used: false } } };

    expect(changesBetween(before, after)).toEqual([
      { collection: 'codes', key: 'code-1', change: 'changed', value: { used: true, scope: ['openid'] }, before: { used: false, scope: ['openid'] }, fields: ['used'] },
      { collection: 'codes', key: 'code-2', change: 'removed', before: { used: false } },
      { collection: 'refreshTokens', key: 'refresh-1', change: 'added', value: { used: false } },
    ]);
  });

  it('should find no change between the same records', () => {
    const db = databaseWithCode();

    expect(changesBetween(plainDatabase(db), plainDatabase(databaseWithCode()))).toEqual([]);
  });
});

describe('changesBetween, on records before that many requests start from', () => {
  it('should give each request its own copy of a record as it was, so changing one leaves the records before as they are', () => {
    const before = { codes: { 'code-1': { used: false } } };
    const [change] = changesBetween(before, { codes: { 'code-1': { used: true } } });
    (change?.before as { used: boolean }).used = true;

    expect(before.codes['code-1'].used).toBe(false);
    expect(changesBetween(before, { codes: {} })).toEqual([{ collection: 'codes', key: 'code-1', change: 'removed', before: { used: false } }]);
  });
});

describe('storeAccess', () => {
  it('should give the reads noted and the records changed in place since the records before', () => {
    const db = databaseWithCode();
    const before = plainDatabase(db);
    const reads = watchDatabase(db);
    const code = db.codes.get('code-1') as unknown as { used: boolean };
    code.used = true;

    expect(storeAccess(reads, before, db)).toEqual({
      read: [{ collection: 'codes', key: 'code-1', found: true }],
      wrote: [{ collection: 'codes', key: 'code-1', change: 'changed', value: { code: 'code-1', clientId: 'client-1', used: true }, before: { code: 'code-1', clientId: 'client-1', used: false }, fields: ['used'] }],
    });
  });
});
