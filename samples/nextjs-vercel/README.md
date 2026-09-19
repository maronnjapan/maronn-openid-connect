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

`VERCEL` が設定された環境でRedis資格情報がない場合は、永続化されない一時ファイルへ誤ってフォールバックしないよう起動を失敗させる。署名鍵は起動時生成のため、複数インスタンスに広がる本番相当の検証では固定鍵の読み込みへ置き換えること。

## Google ログイン（任意）

このサンプルは `--enable google-login`（`@maronn-openid-connect/google-login`）付きで生成されており、`GOOGLE_CLIENT_ID` を設定するとログイン画面（`src/app/login/page.tsx`）に「Google でログイン」が表示され、`src/app/login/google/route.ts` が Google からの POST を受ける。未設定なら従来どおりユーザー名 + パスワードのみ。

1. Google Cloud コンソールで OAuth 2.0 クライアント ID（ウェブ アプリケーション）を作成する
2. 「承認済みの JavaScript 生成元」にログイン画面のオリジン、「承認済みのリダイレクト URI」に `<issuer>/login/google` を登録する（Google は `http://127.0.0.1` を生成元として受け付けないので、ローカルでは `localhost` で起動する）
3. 環境変数を付けて起動する

```bash
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com HOST=localhost OIDC_ISSUER=http://localhost:3010 pnpm sample:nextjs-vercel
```

`GOOGLE_HOSTED_DOMAIN=example.com` を足すと、その Google Workspace ドメインのアカウントだけを受け付ける。Google アカウントは `google:<sub>` を subject とするユーザーとしてその場で登録され（ローカルは SQLite、Vercel では Upstash Redis に永続化）、`name` / `email` などのクレームは ID トークンから写される。Vercel では `vercel env add GOOGLE_CLIENT_ID production` で設定して再デプロイする（リダイレクト URI は `<OIDC_ISSUER>/login/google`。デプロイスクリプトが完了時に案内する）。
