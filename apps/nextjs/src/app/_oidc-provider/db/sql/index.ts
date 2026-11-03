/**
 * The database of the provider (--db sql): SQL tables (schema.sql) on any
 * driver or ORM, through the two methods of SqlDatabase (database.ts).
 *
 * provider.ts reads the provider's data through these functions, and so does
 * the code that sets the provider up (registering clients and users). You write
 * one file, db/instance.ts: createDatabase() returns your database.
 */
import type { SqlDatabase } from './database';
import { createDatabase as createInstanceDatabase } from './instance';

export type { SqlDatabase as Database } from './database';

/**
 * 最初に使うときに開く SQL のデータベースを返す。
 *
 * 返すデータベースの各メソッドは、`db/instance.ts` のデータベースの同じメソッドを呼ぶ。
 * `db/instance.ts` の `createDatabase()` は、最初の SQL 文を実行するときに一度だけ呼んでデータベースを開く。
 *
 * `provider.ts` はルートハンドラのモジュールが読み込まれたときにデータベースを作り、`next build` もそれらのモジュールを読み込む。
 * データベースを開くのを最初の SQL 文まで遅らせるので、`next build` がモジュールを読み込むだけではデータベースを開かない。
 */
export function createDatabase(): SqlDatabase {
  let database: SqlDatabase | undefined;
  const open = (): SqlDatabase => (database ??= createInstanceDatabase());
  return {
    all: (statement) => open().all(statement),
    run: (statement) => open().run(statement),
  };
}
export { createProviderStores } from './stores';
export { createClientKeyResolver, createClientResolver, registerClient } from './clients';
export { registerUser } from './users';
