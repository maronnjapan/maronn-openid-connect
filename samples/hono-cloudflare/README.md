# Hono + Cloudflare Workers sample

Cloudflare Workers上で動くHono OPで、CLIの `--db sql` で生成したSQLのテーブル（`src/oidc-provider/db/`）に、クライアント・ユーザー・認可トランザクション・コード・トークン・セッション・同意をD1で保存する。ローカルでもWranglerがD1をエミュレートするため、DBソフトやDockerは不要。

`src/oidc-provider/db/` のうち、このサンプルが書いているのはDBインスタンスを返す `instance.ts` だけで、テーブル定義（`schema.sql`）、ストア（`stores.ts`）、クライアントとユーザーの読み書き（`clients.ts`、`users.ts`）はCLIの生成物である。`instance.ts` はCLIが上書きしないので、`pnpm run generate` で再生成しても残る。

`instance.ts` はD1のバインディング（`DB`）を `SqlDatabase` として包み、isolateごとに最初のクエリの前で `schema.sql` のテーブルを作る。文はすべて `CREATE ... IF NOT EXISTS` なので、作成済みのDBでは何も変わらない。そのためマイグレーションは使わない。

クライアントとユーザーもD1のテーブルから読む。Workersはリクエストの処理中にしかD1を使えないので、isolateごとの最初のリクエストで、`src/app.ts` がE2E用のクライアント（`OIDC_CLIENTS_JSON` があればその内容）を `registerClient()` で、開発用のユーザー（testuser / otheruser、パスワードは `password`）を `registerUser()` でテーブルに登録する。client_secret とパスワードはハッシュだけを保存する。`registerClient()` は値が同じなら同じ行を書くので、同時に起動したisolateが登録し合っても行は重複しない。ユーザーはパスワードのハッシュ化にCPU時間がかかるので、登録済みならそのままにする。

クライアントのテーブルにはまだ `jwks`（クライアントの公開鍵）の列が無いので、`OIDC_CLIENTS_JSON` に `jwks` があるクライアント（OpenID Conformance Suite の署名付き Request Object）は、`src/app.ts` がその値を足して返す。

## ローカル起動（一発）

リポジトリルートから:

```bash
pnpm sample:hono-cloudflare
```

クローン直後でも依存インストール込みで `http://127.0.0.1:3010` に起動する。ローカルDBは `.wrangler/state` に永続化される。別の保存先を使う場合は `OIDC_D1_PERSIST_PATH` を指定する。

## Cloudflare へのデプロイ（一発・ガイド付き）

```bash
pnpm deploy:hono-cloudflare
```

`wrangler login`（未ログイン時のみ）と、アカウント初回デプロイ時のworkers.devサブドメイン登録以外はすべて自動化されている:

- D1データベース（`maronn-openid-connect-sample`）の作成または再利用と `database_id` の自動解決
- デプロイ専用設定 `wrangler.deploy.jsonc`（gitignore済み）の生成。チェックイン済みの `wrangler.jsonc` はローカル開発用にプレースホルダのまま保たれる
- 公開URL（workers.dev）の `ISSUER` への固定（初回のみ2回デプロイ）とDiscoveryでのissuer検証

issuerは `.deploy/issuer` に保存され、2回目以降は1回のデプロイで完了する。カスタムドメインは `--issuer` で指定できる（詳細は `--help`）。

サンプルの署名鍵は起動時生成である。本番相当の検証ではCloudflare Secrets等から固定・ローテーション可能な鍵を読み込むこと。
