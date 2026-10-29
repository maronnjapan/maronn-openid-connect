import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from './schema';

let sqlite: DatabaseSync;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA_SQL);
});

function tableNames(): string[] {
  const rows = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

function insertClient(id: string): void {
  sqlite.prepare("INSERT INTO clients (id, client_type) VALUES (?, 'confidential')").run(id);
}

function insertTransaction(id: string): void {
  sqlite
    .prepare("INSERT INTO transactions (transaction_id, status, created_at, expired_at, payload) VALUES (?, 'requested', 0, 60, '{}')")
    .run(id);
}

describe('SCHEMA_SQL', () => {
  describe('Tables', () => {
    it('should create every table the stores, clients and users of db/sql use', () => {
      expect(tableNames()).toEqual([
        'access_tokens',
        'auth_users',
        'authentication_requests',
        'browser_sessions',
        'client_auths',
        'client_grant_types',
        'client_jwks',
        'client_redirect_uris',
        'client_request_uris',
        'client_response_types',
        'client_scopes',
        'client_secrets',
        'clients',
        'codes',
        'consent_grants',
        'consent_scopes',
        'federated_identities',
        'refresh_tokens',
        'transactions',
        'upstream_auth_requests',
        'users',
      ]);
    });

    it('should run again on a database that has the tables and keep their rows', () => {
      insertClient('rp-1');

      sqlite.exec(SCHEMA_SQL);

      expect(sqlite.prepare('SELECT id FROM clients').all()).toEqual([{ id: 'rp-1' }]);
    });

    it('should default is_deleted of a client to FALSE', () => {
      insertClient('rp-1');

      expect(sqlite.prepare('SELECT is_deleted FROM clients').all()).toEqual([{ is_deleted: 0 }]);
    });
  });

  describe('Constraints', () => {
    it('should reject a client_type other than public and confidential', () => {
      expect(() => sqlite.prepare("INSERT INTO clients (id, client_type) VALUES ('rp-1', 'other')").run()).toThrow(
        'CHECK constraint failed',
      );
    });

    it('should reject a transaction status outside the flow of a transaction', () => {
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO transactions (transaction_id, status, created_at, expired_at, payload) VALUES ('txn-1', 'done', 0, 60, '{}')",
          )
          .run(),
      ).toThrow('CHECK constraint failed');
    });

    it('should reject a client_auths row of a client that does not exist', () => {
      expect(() =>
        sqlite
          .prepare("INSERT INTO client_auths (id, client_id, client_auth_type) VALUES ('auth-1', 'unknown', 'client_secret_basic')")
          .run(),
      ).toThrow('FOREIGN KEY constraint failed');
    });

    it('should reject a client secret whose client_auth_type differs from its client_auths row', () => {
      insertClient('rp-1');
      sqlite
        .prepare("INSERT INTO client_auths (id, client_id, client_auth_type) VALUES ('auth-1', 'rp-1', 'client_secret_basic')")
        .run();

      expect(() =>
        sqlite
          .prepare("INSERT INTO client_secrets (id, client_auth_type, secret) VALUES ('auth-1', 'client_secret_post', 'hash')")
          .run(),
      ).toThrow('FOREIGN KEY constraint failed');
    });

    it('should keep one federated identity per account at a provider', () => {
      sqlite.prepare("INSERT INTO users (id, created_at, updated_at) VALUES ('user-1', 0, 0), ('user-2', 0, 0)").run();
      sqlite
        .prepare(
          "INSERT INTO federated_identities (id, user_id, provider, provider_sub, created_at, updated_at) VALUES ('fi-1', 'user-1', 'google', 'sub-1', 0, 0)",
        )
        .run();

      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO federated_identities (id, user_id, provider, provider_sub, created_at, updated_at) VALUES ('fi-2', 'user-2', 'google', 'sub-1', 0, 0)",
          )
          .run(),
      ).toThrow('UNIQUE constraint failed: federated_identities.provider, federated_identities.provider_sub');
    });
  });

  describe('Foreign Keys', () => {
    it('should remove the rows of a client when the client is deleted', () => {
      insertClient('rp-1');
      sqlite
        .prepare("INSERT INTO client_auths (id, client_id, client_auth_type) VALUES ('auth-1', 'rp-1', 'client_secret_basic')")
        .run();
      sqlite
        .prepare("INSERT INTO client_secrets (id, client_auth_type, secret) VALUES ('auth-1', 'client_secret_basic', 'hash')")
        .run();
      sqlite.prepare("INSERT INTO client_redirect_uris (id, client_id, value) VALUES ('uri-1', 'rp-1', 'https://rp.example.com/cb')").run();
      sqlite.prepare("INSERT INTO client_jwks (id, client_id, purpose, jwk) VALUES ('jwk-1', 'rp-1', 'request_object', '{}')").run();
      sqlite.prepare("INSERT INTO client_response_types (id, client_id, response_type) VALUES ('rt-1', 'rp-1', 'id_token')").run();

      sqlite.prepare("DELETE FROM clients WHERE id = 'rp-1'").run();

      const counts = sqlite
        .prepare(
          'SELECT (SELECT COUNT(*) FROM client_auths) AS auths, (SELECT COUNT(*) FROM client_secrets) AS secrets, ' +
            '(SELECT COUNT(*) FROM client_redirect_uris) AS redirect_uris, (SELECT COUNT(*) FROM client_jwks) AS jwks, ' +
            '(SELECT COUNT(*) FROM client_response_types) AS response_types',
        )
        .all();
      expect(counts).toEqual([{ auths: 0, secrets: 0, redirect_uris: 0, jwks: 0, response_types: 0 }]);
    });

    it('should keep a code without its transaction when the transaction is deleted', () => {
      insertTransaction('txn-1');
      sqlite
        .prepare("INSERT INTO codes (id, transaction_id, expired_at, grant_id, payload) VALUES ('code-hash', 'txn-1', 60, 'grant-1', '{}')")
        .run();

      sqlite.prepare("DELETE FROM transactions WHERE transaction_id = 'txn-1'").run();

      expect(sqlite.prepare('SELECT id, transaction_id FROM codes').all()).toEqual([{ id: 'code-hash', transaction_id: null }]);
    });

    it('should remove the authentication request of a transaction when the transaction is deleted', () => {
      insertTransaction('txn-1');
      sqlite
        .prepare(
          "INSERT INTO authentication_requests (transaction_id, client_id, redirect_uri, response_type, payload) VALUES ('txn-1', 'rp-1', 'https://rp.example.com/cb', 'code', '{}')",
        )
        .run();

      sqlite.prepare("DELETE FROM transactions WHERE transaction_id = 'txn-1'").run();

      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM authentication_requests').all()).toEqual([{ count: 0 }]);
    });
  });
});
