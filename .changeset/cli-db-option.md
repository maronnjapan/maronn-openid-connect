---
'@maronn-openid-connect/cli': minor
---

`generate` / `setup` に `--db` を追加し、生成 OP のデータを SQL のテーブルに保存できるようにする

`--db` を付けると、出力先に `db/` を生成する（Next.js は `_oidc-provider/db/`）。
生成アプリは `storage` と `clientResolver` を渡さなければ、クライアント、ユーザー、認可トランザクション、認可コード、トークン、セッション、同意を `db/` のテーブルで扱う。

- `db/instance.ts`：DB インスタンスを返す `createDatabase()`。利用者が書くファイルなので、CLI は無いときだけ作り、`--force` を付けても上書きしない。末尾に node:sqlite、Cloudflare D1（Hono のみ）、PostgreSQL（pg）、Prisma、Drizzle、Kysely の例を載せる
- `db/database.ts`：`createDatabase()` が返す `SqlDatabase` の型。SQL を 1 文実行する `all` と `run` の 2 メソッドだけなので、どのドライバーや ORM でも実装できる
- `db/schema.sql` と `db/schema.ts`：テーブル定義。SQLite、Cloudflare D1、PostgreSQL のどれでもそのまま通る。クライアント（`clients` と、認証方式、シークレット、公開鍵、リダイレクト URI、grant type、スコープ、authorization_details の子テーブル）、ユーザー（`users`）、認可トランザクション（`transactions`、`authentication_requests`、`auth_users`）、認可コードとトークン（`codes`、`access_tokens`、`refresh_tokens`、`id_tokens`）をエンティティごとのテーブルに分ける。Sign in with Google の `federated_identities` と `upstream_auth_requests` は `--enable google-login` のときだけ作る
- `db/stores.ts`：`ProviderStores` の SQL 実装。認可コードとリフレッシュトークンの `consume` は条件付きの `UPDATE` 1 回で使用済みにし、同時に来た 2 つ目のリクエストを `invalid_grant` で止める。認可トランザクションは行を消さずに `status`（`requested` から `token_issued` まで、またはコードを出さずに終わった `failed`）で進み具合を記録し、認可コードとアクセストークンから `transaction_id` で参照する
- `db/clients.ts`：クライアントのテーブルを読む `ClientResolver` と、クライアントを登録する `registerClient()`。client_secret は `hashClientSecret()`（core）のハッシュだけを保存し、`clientSecretHash` で照合する

ユーザーはログインに成功した時点で `users` に保存する。
パスワードでログインするユーザーは `store.ts` の開発用の固定ユーザーのままで、Sign in with Google のユーザーは Google の sub で同じ人かを判断し、初めてのログインでランダムな ID のユーザーを作る。
`id_tokens`、`client_scopes`、`client_authorization_details` はテーブルだけを作り、OP はまだ読み書きしない。
Next.js の `--db` 付き生成では、クライアント用の環境変数（`OIDC_CLIENTS_JSON` など）を読まない。

既存の `db/instance.ts` は、生成ログに `Kept:`、`--dry-run` に `Would keep:` と表示し、上書き保護の対象にも数えない。
`.maronn-openid-connect.json` には `db` を記録する。
`--db` を付けない生成物は、マニフェスト以外は変わらない。
