import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createJsonProviderStores,
  type JsonStoreBackend,
  type JsonStoreEntry,
  type ProviderStores,
} from './store';

declare const process: { env: Record<string, string | undefined> };

interface StoredRow {
  key: string;
  value: string;
  expires_at: number | null;
}

class SqliteJsonStoreBackend implements JsonStoreBackend {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    const databasePath = path === ':memory:' ? path : resolve(path);
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.database = new DatabaseSync(databasePath);
    // Concurrent processes opening the same file (e.g. Next.js build workers
    // collecting page data) race on the initial schema write; without a busy
    // timeout SQLite fails fast with "database is locked" instead of waiting.
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec(
      'CREATE TABLE IF NOT EXISTS oidc_store (' +
      'key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)',
    );
  }

  async get<T>(key: string): Promise<T | null> {
    const row = this.database
      .prepare('SELECT key, value, expires_at FROM oidc_store WHERE key = ?')
      .get(key) as unknown as StoredRow | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      await this.delete(key);
      return null;
    }
    return JSON.parse(row.value) as T;
  }

  async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000;
    this.database.prepare(
      'INSERT INTO oidc_store (key, value, expires_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
    ).run(key, JSON.stringify(value), expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.database.prepare('DELETE FROM oidc_store WHERE key = ?').run(key);
  }

  async list<T>(prefix: string): Promise<Array<JsonStoreEntry<T>>> {
    const rows = this.database
      .prepare(
        'SELECT key, value, expires_at FROM oidc_store ' +
        'WHERE key >= ? AND key < ? ORDER BY key',
      )
      .all(prefix, prefix + '\uffff') as unknown as StoredRow[];
    const entries: Array<JsonStoreEntry<T>> = [];
    for (const row of rows) {
      if (row.expires_at !== null && row.expires_at <= Date.now()) {
        await this.delete(row.key);
      } else {
        entries.push({ key: row.key, value: JSON.parse(row.value) as T });
      }
    }
    return entries;
  }
}

interface UpstashResponse<T> {
  result?: T;
  error?: string;
}

class UpstashRedisJsonStoreBackend implements JsonStoreBackend {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly namespace = 'maronn-openid-connect:',
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const value = await this.command<string | null>(['GET', this.fullKey(key)]);
    return value === null ? null : JSON.parse(value) as T;
  }

  async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const command: Array<string | number> = ['SET', this.fullKey(key), JSON.stringify(value)];
    if (ttlSeconds !== undefined) command.push('EX', ttlSeconds);
    await this.command<string>(command);
  }

  async delete(key: string): Promise<void> {
    await this.command<number>(['DEL', this.fullKey(key)]);
  }

  async list<T>(prefix: string): Promise<Array<JsonStoreEntry<T>>> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const result = await this.command<[string, string[]]>([
        'SCAN',
        cursor,
        'MATCH',
        this.fullKey(prefix) + '*',
        'COUNT',
        100,
      ]);
      cursor = String(result[0]);
      keys.push(...result[1]);
    } while (cursor !== '0');

    const entries: Array<JsonStoreEntry<T>> = [];
    for (const fullKey of keys) {
      const value = await this.command<string | null>(['GET', fullKey]);
      if (value !== null) {
        entries.push({
          key: fullKey.slice(this.namespace.length),
          value: JSON.parse(value) as T,
        });
      }
    }
    return entries;
  }

  private fullKey(key: string): string {
    return this.namespace + key;
  }

  private async command<T>(command: Array<string | number>): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      cache: 'no-store',
    });
    const body = await response.json() as UpstashResponse<T>;
    if (!response.ok || body.error || !('result' in body)) {
      throw new Error(body.error ?? 'Upstash Redis request failed with HTTP ' + response.status);
    }
    return body.result as T;
  }
}

const storageRegistry = globalThis as typeof globalThis & {
  __oidcNextJsProviderStores?: ProviderStores;
};

export function createNextJsProviderStores(): ProviderStores {
  return (storageRegistry.__oidcNextJsProviderStores ??= createStores());
}

function createStores(): ProviderStores {
  const redisUrl = readEnv('UPSTASH_REDIS_REST_URL');
  const redisToken = readEnv('UPSTASH_REDIS_REST_TOKEN');
  if (redisUrl && redisToken) {
    return createJsonProviderStores(new UpstashRedisJsonStoreBackend(redisUrl, redisToken));
  }
  if (readEnv('VERCEL')) {
    throw new Error(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required on Vercel',
    );
  }
  const sqlitePath = readEnv('OIDC_SQLITE_PATH') ?? '.data/oidc.sqlite';
  return createJsonProviderStores(new SqliteJsonStoreBackend(sqlitePath));
}

function readEnv(name: string): string | undefined {
  return process.env[name];
}
