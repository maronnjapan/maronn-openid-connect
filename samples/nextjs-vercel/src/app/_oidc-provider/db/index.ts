/**
 * The database of the provider (--db kv): a key-value store (keys.ts) such as
 * Redis or Upstash, through the four methods of KvDatabase (database.ts).
 *
 * provider.ts reads the provider's data through these functions, and so does
 * the code that sets the provider up (registering clients and users). You write
 * one file, db/instance.ts: createDatabase() returns your store.
 */
import type { KvDatabase } from './database';
import { createDatabase as createInstanceDatabase } from './instance';

export type { KvDatabase as Database } from './database';

/**
 * 最初に使うときに開く KV ストアを返す。
 *
 * 返すストアの各メソッドは、`db/instance.ts` のストアの同じメソッドを呼ぶ。
 * `db/instance.ts` の `createDatabase()` は、最初のメソッドの呼び出しで一度だけ呼んでストアを開く。
 *
 * `provider.ts` はルートハンドラのモジュールが読み込まれたときにデータベースを作り、`next build` もそれらのモジュールを読み込む。
 * ストアを開くのを最初の呼び出しまで遅らせるので、`next build` がモジュールを読み込むだけではストアを開かない。
 */
export function createDatabase(): KvDatabase {
  let store: KvDatabase | undefined;
  const open = (): KvDatabase => (store ??= createInstanceDatabase());
  return {
    get: (key) => open().get(key),
    set: (key, value, ttlSeconds) => open().set(key, value, ttlSeconds),
    setIfAbsent: (key, value, ttlSeconds) => open().setIfAbsent(key, value, ttlSeconds),
    delete: (key) => open().delete(key),
  };
}
export { createProviderStores } from './stores';
export { createClientKeyResolver, createClientResolver, registerClient } from './clients';
export { registerUser } from './users';
