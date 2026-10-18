/**
 * The names the generated app imports from db/ and calls, for each kind of
 * --db. Kept apart from the templates so the framework templates can import it
 * without importing the db/ templates.
 */
import type { DbKind } from '../../db.js';

/** The names of db/ that the generated app imports and calls. */
export interface DatabaseNames {
  /** The type that createDatabase() (db/instance.ts) returns. */
  databaseType: 'SqlDatabase' | 'KvDatabase';
  /** db/stores.ts: ProviderStores on the database. */
  createProviderStores: string;
  /** db/clients.ts: the ClientResolver on the database. */
  createClientResolver: string;
  /** db/clients.ts: the ClientKeyResolver on the database (the keys of each purpose). */
  createClientKeyResolver: string;
  /** Where the client keys are kept, as the comments of the generated app name it. */
  clientKeysDescription: string;
  /** The stores, as the comments of the generated app name them. */
  storesDescription: string;
  /** Where the registered clients are kept, as the comments of the generated app name it. */
  clientsDescription: string;
}

export function databaseNames(db: DbKind): DatabaseNames {
  return db === 'kv'
    ? {
      databaseType: 'KvDatabase',
      createProviderStores: 'createKvProviderStores',
      createClientResolver: 'createKvClientResolver',
      createClientKeyResolver: 'createKvClientKeyResolver',
      clientKeysDescription: 'the client_jwks records of db/',
      storesDescription: 'the key-value stores',
      clientsDescription: 'the client records of db/',
    }
    : {
      databaseType: 'SqlDatabase',
      createProviderStores: 'createSqlProviderStores',
      createClientResolver: 'createSqlClientResolver',
      createClientKeyResolver: 'createSqlClientKeyResolver',
      clientKeysDescription: 'the client_jwks table of db/',
      storesDescription: 'the SQL stores',
      clientsDescription: 'the client tables of db/',
    };
}
