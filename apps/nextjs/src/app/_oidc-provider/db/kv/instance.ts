/**
 * The key-value store instance: the one file in db/ that you write.
 *
 * The CLI creates this file only when it does not exist yet and never
 * overwrites it, not even with --force, so your code here survives
 * re-generation. Everything else in db/ is generated.
 *
 * createDatabase() returns a KvDatabase (database.ts): get, set, setIfAbsent
 * and delete on string keys and values. setIfAbsent must be atomic, and a get
 * must see the writes that finished before it (database.ts says why). The OP
 * reads its clients and users from the store, so register them there with
 * registerClient() (clients.ts) and registerUser() (users.ts).
 *
 * As generated, it runs on two stores and needs no package:
 *
 * - Upstash Redis (the Redis of the Vercel Marketplace) over its REST API,
 *   when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set. On
 *   Vercel without them the first use fails, instead of writing to a file
 *   that no other function reads.
 * - Otherwise one table of Node.js's built-in node:sqlite, in the file
 *   OIDC_SQLITE_PATH names (.data/oidc.sqlite by default; Node.js 22.13+).
 *
 * Replace either with the client of your store.
 *
 * The store is kept on globalThis: Next.js loads this module once per module
 * layer (Route Handlers, Server Actions, instrumentation.ts), and all of them
 * have to use the same store, OIDC_SQLITE_PATH=:memory: included.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { KvDatabase } from './database';

const registry = globalThis as typeof globalThis & { __oidcKvDatabase?: KvDatabase };

/**
 * このプロセスの KV ストアを返す。
 *
 * 最初の呼び出しで `openDatabase()` を呼んでストアを開いて `globalThis` に置き、以後はどの呼び出しにも同じストアを返す。
 * Next.js はこのモジュールを層ごと（ルートハンドラ、サーバーアクション、`instrumentation.ts`）に読み込むが、どの層も同じストアを使う。
 * 開くのは、Upstash Redis の URL とトークンが設定されていれば Upstash Redis、なければ `node:sqlite` のストアである。
 *
 * @throws {Error} 最初の呼び出しで、Vercel の上なのに Upstash Redis の URL とトークンがないとき（`openDatabase()`）
 */
export function createDatabase(): KvDatabase {
  return (registry.__oidcKvDatabase ??= openDatabase());
}

/**
 * 環境変数で選んだ KV ストアを開いて返す。
 *
 * `UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN` がどちらも設定されていれば、Upstash Redis のストアを返す（`openUpstash()`）。
 * そうでなければ、`OIDC_SQLITE_PATH` のファイル（既定は `.data/oidc.sqlite`）を `node:sqlite` で開いたストアを返す（`openSqlite()`）。
 *
 * @throws {Error} Vercel の上（`VERCEL` が設定されている）で Upstash Redis の URL とトークンがないとき（ほかのサーバーレス関数からは読めないファイルに書かないため）
 */
function openDatabase(): KvDatabase {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (redisUrl && redisToken) {
    return openUpstash(redisUrl, redisToken);
  }
  if (process.env.VERCEL) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required on Vercel');
  }
  return openSqlite(process.env.OIDC_SQLITE_PATH ?? '.data/oidc.sqlite');
}

/**
 * Upstash Redis の REST API を使う KV ストアを返す。
 *
 * 返すストアの各メソッドは、Redis のコマンドを一つ送る（`GET`、`SET`、`SET ... NX`、`DEL`）。
 * 有効期間を渡されたときは、`EX` で秒数を付ける。
 *
 * @throws {Error} 返したストアのメソッドで、HTTP のエラーか Upstash のエラーが返ったとき
 */
function openUpstash(url: string, token: string): KvDatabase {
  const run = async (command: Array<string | number>): Promise<unknown> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });
    const body = (await response.json()) as { result?: unknown; error?: string };
    if (!response.ok || body.error !== undefined) {
      throw new Error('Upstash: ' + (body.error ?? 'HTTP ' + response.status));
    }
    return body.result;
  };
  const expiry = (ttlSeconds?: number) => (ttlSeconds === undefined ? [] : ['EX', ttlSeconds]);
  return {
    get: async (key) => (await run(['GET', key])) as string | null,
    set: async (key, value, ttlSeconds) => {
      await run(['SET', key, value, ...expiry(ttlSeconds)]);
    },
    setIfAbsent: async (key, value, ttlSeconds) =>
      (await run(['SET', key, value, 'NX', ...expiry(ttlSeconds)])) === 'OK',
    delete: async (key) => {
      await run(['DEL', key]);
    },
  };
}

/**
 * `node:sqlite` のテーブルを使う KV ストアを返す。
 *
 * `path` のファイルを開き（`:memory:` ならメモリ上に作り）、`kv` テーブルがなければ作る。
 * ファイルのディレクトリがなければ、それも作る。
 * 各メソッドは SQL 文を一つ実行し、SQLite は一つの文をまとめて実行するので、複数のプロセスがファイルを共有していても `setIfAbsent` はアトミックである。
 */
function openSqlite(path: string): KvDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const sqlite = new DatabaseSync(path === ':memory:' ? path : resolve(path));
  // 同じファイルを同時に開いたプロセス（`next build` のワーカーと、動いている `next start` など）が、`database is locked` で失敗せずにロックを待つようにする。
  sqlite.exec('PRAGMA busy_timeout = 5000');
  sqlite.exec('PRAGMA journal_mode = WAL');
  // `expires_at` はエポックミリ秒で、`NULL` なら期限切れにならない。
  sqlite.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)');
  const expiresAt = (ttlSeconds?: number) => (ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000);
  const select = sqlite.prepare('SELECT value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)');
  const upsert = sqlite.prepare(
    'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
  );
  // 期限切れのキーはないものとみなすので、挿入で置き換えてよい。
  const insertIfAbsent = sqlite.prepare(
    'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at ' +
      'WHERE kv.expires_at IS NOT NULL AND kv.expires_at <= ?',
  );
  const remove = sqlite.prepare('DELETE FROM kv WHERE key = ?');
  return {
    get: async (key) => (select.get(key, Date.now()) as { value: string } | undefined)?.value ?? null,
    set: async (key, value, ttlSeconds) => {
      upsert.run(key, value, expiresAt(ttlSeconds));
    },
    setIfAbsent: async (key, value, ttlSeconds) =>
      Number(insertIfAbsent.run(key, value, expiresAt(ttlSeconds), Date.now()).changes) === 1,
    delete: async (key) => {
      remove.run(key);
    },
  };
}
