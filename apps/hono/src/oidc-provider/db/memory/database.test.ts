import { describe, expect, it } from 'vitest';
import { createDatabase, createEmptyDatabase, federatedIdentityKey } from './database.js';

describe('createDatabase', () => {
  it('should return the same database on every call', () => {
    expect(createDatabase()).toBe(createDatabase({ request: 'ignored' }));
  });
});

describe('createEmptyDatabase', () => {
  it('should return a new database with every table empty', () => {
    const db = createEmptyDatabase();

    expect(db).not.toBe(createEmptyDatabase());
    expect(Object.fromEntries(Object.entries(db).map(([table, rows]) => [table, rows.size]))).toEqual({
      transactions: 0,
      codes: 0,
      accessTokens: 0,
      refreshTokens: 0,
      authSessions: 0,
      browserSessions: 0,
      consentScopes: 0,
      consentGrants: 0,
      users: 0,
      federatedIdentities: 0,
      upstreamLogins: 0,
      clients: 0,
    });
  });
});

describe('federatedIdentityKey', () => {
  it('should tell apart accounts whose provider and subject only differ in where they are split', () => {
    expect(federatedIdentityKey('google', 'a:b')).not.toBe(federatedIdentityKey('google:a', 'b'));
    expect(federatedIdentityKey('google', 'sub-1')).toBe('["google","sub-1"]');
  });
});
