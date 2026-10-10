---
'@maronn-openid-connect/cli': minor
---

`generate` / `setup` に `--db` を追加し、生成 OP のデータを SQL のテーブルに保存できるようにする

`--db` を付けると、出力先に `db/` を生成する（Next.js は `_oidc-provider/db/`）。
生成アプリは `storage` オプションを渡さなければ、認可コード、トークン、セッション、同意を `db/` のテーブルに保存する。

- `db/instance.ts`：DB インスタンスを返す `createDatabase()`。利用者が書くファイルなので、CLI は無いときだけ作り、`--force` を付けても上書きしない。末尾に node:sqlite、Cloudflare D1（Hono のみ）、PostgreSQL（pg）、Prisma、Drizzle、Kysely の例を載せる
- `db/database.ts`：`createDatabase()` が返す `SqlDatabase` の型。SQL を 1 文実行する `all` と `run` の 2 メソッドだけなので、どのドライバーや ORM でも実装できる
- `db/schema.sql` と `db/schema.ts`：テーブル定義。SQLite、Cloudflare D1、PostgreSQL のどれでもそのまま通る
- `db/stores.ts`：`ProviderStores` の SQL 実装。認可コードとリフレッシュトークンの `consume` は条件付きの `UPDATE` 1 回で使用済みにし、同時に来た 2 つ目のリクエストを `invalid_grant` で止める

既存の `db/instance.ts` は、生成ログに `Kept:`、`--dry-run` に `Would keep:` と表示し、上書き保護の対象にも数えない。
`.maronn-openid-connect.json` には `db` を記録する。
`--db` を付けない生成物は、マニフェスト以外は変わらない。
