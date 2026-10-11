---
'@maronn-openid-connect/cli': minor
---

`generate` / `setup` に `--db sql` と `--db kv` を追加し、生成 OP のデータを SQL のテーブルかキー・バリューストアに保存できるようにする。あわせて、クライアントに登録した scope の検証を生成コードに加える

`--db sql` か `--db kv` を付けると、出力先に `db/` を生成する（Next.js は `_oidc-provider/db/`）。
`--db` の後に種類が無いときや、`sql` と `kv` 以外のときは、何も書き込まずにエラーで終わる。
生成アプリは `storage` と `clientResolver` を渡さなければ、クライアント、ユーザー、認可トランザクション、認可コード、トークン、セッション、同意を `db/` で扱う。

どちらの種類でも、`db/` には次のファイルがある。

- `db/instance.ts`：DB インスタンスを返す `createDatabase()`。利用者が書くファイルなので、CLI は無いときだけ作り、`--force` を付けても上書きしない。末尾に DB ごとの例を載せる
- `db/database.ts`：`createDatabase()` が返す型
- `db/stores.ts`：`ProviderStores` の実装。認可コードとリフレッシュトークンの `consume` は、使用済みにする操作を不可分な 1 回の操作で行い、同時に来た 2 つ目のリクエストを `invalid_grant` で止める。認可トランザクションは消さずに、`requested` から `token_issued` まで、またはコードを出さずに終わった `failed` で進み具合を記録し、認可コードとアクセストークンから参照する。ログインフォームはユーザーのパスワードのハッシュと照合する
- `db/clients.ts`：登録クライアントを読む `ClientResolver` と、クライアントを登録する `registerClient()`。client_secret は `hashClientSecret()`（core）のハッシュだけを保存し、`clientSecretHash` で照合する。同じ値で呼び直しても中身は変わらないので、複数のインスタンスが起動時に同時に登録してよい
- `db/users.ts`：ユーザーを登録する `registerUser()` と、パスワードを PBKDF2（HMAC-SHA256、100,000 回）でハッシュにする `hashPassword()` / `verifyPassword()`。パスワードは NULL にでき、パスワードの無いユーザー（Sign in with Google で作ったユーザーなど）はログインフォームでは認証できない

`--db sql` は SQL のテーブルにデータを置く。

- `db/database.ts` の `SqlDatabase` は、SQL を 1 文実行する `all` と `run` の 2 メソッドだけなので、どのドライバーや ORM でも実装できる。`instance.ts` には node:sqlite、Cloudflare D1（Hono のみ）、PostgreSQL（pg）、Prisma、Drizzle、Kysely の例を載せる
- `db/schema.sql` と `db/schema.ts`：テーブル定義。SQLite、Cloudflare D1、PostgreSQL のどれでもそのまま通る。クライアント（`clients` と、認証方式、シークレット、リダイレクト URI、grant type、スコープの子テーブル）、ユーザー（`users`）、認可トランザクション（`transactions`、`authentication_requests`、`auth_users`）、認可コードとトークン（`codes`、`access_tokens`、`refresh_tokens`）をエンティティごとのテーブルに分ける。Sign in with Google の `federated_identities` と `upstream_auth_requests` は `--enable google-login` のときだけ作る

`--db kv` はキー・バリューストアにデータを置く。

- `db/database.ts` の `KvDatabase` は `get`、`set`（TTL を付けられる）、`setIfAbsent`、`delete` の 4 メソッドだけなので、Redis、Upstash、Valkey、DynamoDB などで実装できる。`setIfAbsent` は不可分である必要がある。`instance.ts` には Upstash Redis の REST API、node-redis、ioredis、メモリ上の Map の例を載せる（Hono は Upstash Redis と Map だけ）
- `db/keys.ts`：キーの一覧と、各キーに入れる JSON レコードの型。`--db sql` のテーブルと同じ ER モデルのエンティティごとにキーを分け、クライアントのレコードは認証方式、シークレット、リダイレクト URI、grant type、スコープを中に持つ。認可コードとリフレッシュトークンは使用済みの印のキーを `setIfAbsent` で書いて 1 回限りにし、grant 単位の失効は失効の印のキーで行う
- Cloudflare Workers KV は、書き込みがほかの拠点に届くまで時間がかかり、不可分な書き込みも持たないので、この条件を満たさない。Cloudflare では D1（`--db sql`）か、Durable Objects の上に作ったストアを使う

Sign in with Google のユーザーは、Google の sub で同じ人かを判断し、初めてのログインでランダムな ID のユーザーを作る。
ID トークン、private_key_jwt、authorization_details は保存しない。
ID トークンは署名で検証するので保存する必要が無く、残りの 2 つはその機能を実装するときに足す。
Next.js の `--db` 付き生成では、クライアント用の環境変数（`OIDC_CLIENTS_JSON` など）を読まない。

クライアントに登録した scope（`RegisteredClient.scope`。`--db sql` では `client_scopes`、`--db kv` ではクライアントのレコードの `scopes`）の検証は、`--db` の有無によらず生成コードに加えた。
`/authorize` と、生成した場合は Device Authorization Grant と CIBA の要求で、登録外の scope を `invalid_scope` で拒否する。
scope を登録していないクライアントの動きは変わらない。

既存の `db/instance.ts` は、生成ログに `Kept:`、`--dry-run` に `Would keep:` と表示し、上書き保護の対象にも数えない。
`.maronn-openid-connect.json` には `db`（`sql`、`kv`、`--db` を付けなければ `null`）を記録する。
