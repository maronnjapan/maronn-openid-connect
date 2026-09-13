# Next.js + Vercel sample

VercelではMarketplaceから接続できるUpstash Redis REST、ローカルではNode.js組み込みSQLiteを使用する。どちらも生成OPの同じ `JsonStoreBackend` 契約へ接続され、外部ランタイムライブラリは不要。

## ローカル起動（一発）

リポジトリルートから:

```bash
pnpm sample:nextjs-vercel
```

クローン直後でも依存インストール・ビルド込みで `http://127.0.0.1:3010` に起動する（DBソフト・Docker不要）。デフォルトの保存先は `.data/oidc.sqlite` で、`OIDC_SQLITE_PATH` で変更できる。

## Vercel へのデプロイ（一発・ガイド付き）

```bash
pnpm deploy:nextjs-vercel
```

Vercel CLIは `pnpm dlx` 経由で使うためグローバルインストール不要。`vercel login`（未ログイン時のみ）とUpstash Redisの資格情報以外はすべて自動化されている:

- プロジェクト（`maronn-openid-connect-sample-nextjs-vercel`）の作成またはリンク
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` が未設定なら、Vercel Marketplace連携またはUpstashコンソールでの作成手順をガイドし、貼り付け入力で `vercel env add` まで実施
- ローカルでの `vercel build`（workspace依存の `@maronn-openid-connect/core` をローカルで解決）と `--prebuilt` での本番デプロイ
- 公開URLの `OIDC_ISSUER` への固定（初回のみ2回デプロイ）とDiscoveryでのissuer検証

issuerは `.deploy/issuer` に保存され、2回目以降は1回のデプロイで完了する。カスタムドメインは `--issuer` で指定できる（詳細は `--help`）。

`VERCEL` が設定された環境でRedis資格情報がない場合は、永続化されない一時ファイルへ誤ってフォールバックしないよう起動を失敗させる。

## 署名鍵の固定

`OIDC_SIGNING_KEY_JWK` を設定しない場合、OPはプロセス／インスタンスごとにRS256鍵をその場で生成し、起動時に警告を出す。`kid` は固定なのに鍵素材はインスタンスごとに異なるため、JWKSを取得したインスタンスと署名したインスタンスが違うとID Token・JWTアクセストークンの検証が間欠的に失敗する（OIDC Core 1.0 §10.1 / RFC 7515 §4.1.4 は `kid` から鍵素材への対応が安定していることを前提とする）。単一プロセスのローカル起動では顕在化しないが、複数インスタンス構成や再デプロイをまたぐ検証では固定鍵が必要になる。

鍵はリポジトリルートで生成する（出力には秘密鍵が含まれるのでコミットしないこと）:

```bash
pnpm generate:signing-key --kid nextjs-rs256-key
```

出力をVercelの環境変数として設定する:

```bash
vercel env add OIDC_SIGNING_KEY_JWK
```

`OIDC_SIGNING_KEY_ID` を併用する場合は、JWKの `kid` と一致させること（食い違いは起動時エラーになる）。
