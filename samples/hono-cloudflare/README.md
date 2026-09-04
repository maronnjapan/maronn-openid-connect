# Hono + Cloudflare Workers sample

Cloudflare Workers上で動くHono OPで、認可トランザクション・コード・トークン・セッション・同意・ユーザーをD1へ保存する。ローカルでもWranglerがD1をエミュレートするため、DBソフトやDockerは不要。

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
- リモートD1へのマイグレーション適用
- 公開URL（workers.dev）の `ISSUER` への固定（初回のみ2回デプロイ）とDiscoveryでのissuer検証

issuerは `.deploy/issuer` に保存され、2回目以降は1回のデプロイで完了する。カスタムドメインは `--issuer` で指定できる（詳細は `--help`）。

## 署名鍵の固定

`OIDC_SIGNING_KEY_JWK` を設定しない場合、OPはプロセス／インスタンスごとにRS256鍵をその場で生成し、起動時に警告を出す。`kid` は固定なのに鍵素材はインスタンスごとに異なるため、JWKSを取得したインスタンスと署名したインスタンスが違うとID Token・JWTアクセストークンの検証が間欠的に失敗する（OIDC Core 1.0 §10.1 / RFC 7515 §4.1.4 は `kid` から鍵素材への対応が安定していることを前提とする）。単一プロセスのローカル起動では顕在化しないが、複数インスタンス構成や再デプロイをまたぐ検証では固定鍵が必要になる。

鍵はリポジトリルートで生成する（出力には秘密鍵が含まれるのでコミットしないこと）:

```bash
pnpm generate:signing-key --kid hono-cloudflare-rs256-key
```

出力をWorkerのsecretとして設定する:

```bash
pnpm --filter @maronn-openid-connect/sample-hono-cloudflare exec wrangler secret put OIDC_SIGNING_KEY_JWK
```

ローカル起動（`pnpm sample:hono-cloudflare`）では環境変数 `OIDC_SIGNING_KEY_JWK` をそのまま渡せる。

`OIDC_SIGNING_KEY_ID` を併用する場合は、JWKの `kid` と一致させること（食い違いは起動時エラーになる）。
