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

サンプルの署名鍵は起動時生成である。本番相当の検証ではCloudflare Secrets等から固定・ローテーション可能な鍵を読み込むこと。
