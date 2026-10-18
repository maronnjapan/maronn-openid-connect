# Next.js + Vercel sample

CLIの `--db kv` で生成したキー・バリューストア用のコード（`src/app/_oidc-provider/db/`）で、OPの状態を保存する。VercelではMarketplaceから接続できるUpstash Redisを、そのREST APIで使う。ローカルではNode.js組み込みの `node:sqlite` の1つの表を、キー・バリューストアとして使う。どちらも外部ランタイムライブラリは不要。

`src/app/_oidc-provider/db/` のうち、このサンプルが書いているのはDBインスタンスを返す `instance.ts` だけで、キーの一覧（`keys.ts`）、ストア（`stores.ts`）、クライアントとユーザーの読み書き（`clients.ts`、`users.ts`）はCLIの生成物である。`instance.ts` はCLIが上書きしないので、`pnpm run generate` で再生成しても残る。`instance.ts` は `UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN` があればUpstash Redisを、無ければ `node:sqlite` を使う。`node:sqlite` の `setIfAbsent()` は条件付きの `INSERT` 1文で行うので、同時に呼ばれても成功するのは1回だけである。

クライアントとユーザーもキー・バリューストアから読む。サーバーの起動時に `src/instrumentation.ts`（Next.jsが起動時に1回呼ぶ `register()`）が、`src/sample-data.ts` のクライアント（`OIDC_CLIENTS_JSON`、無ければ `OIDC_CLIENT_ID` などの環境変数）を `registerClient()` で、開発用のユーザー（testuser / otheruser、パスワードは `password`）を `registerUser()` で登録する。client_secret とパスワードはハッシュだけを保存する。クライアントは1つのレコードを1回の書き込みで登録するので、同時に起動したインスタンスが登録し合っても壊れない。ユーザーはパスワードのハッシュ化に時間がかかるので、登録済みならそのままにする。

`OIDC_CLIENTS_JSON` のクライアントの `keys`（用途ごとの公開鍵）は、`registerClient()` が `client_jwks:<client_id>:<purpose>` のレコードに入れる。OpenID Conformance Suiteの署名付きRequest Objectは、`request_object` の用途の鍵で検証する。

## 構成

`src/app` は CLI（`pnpm run generate`）が生成した App Router のコードで、手では編集しない（例外は、サンプルが書いた `_oidc-provider/db/instance.ts`。CLI はこのファイルを上書きしない）。エンドポイントごとの Route Handler（`authorize/route.ts`・`token/route.ts` など）、ログイン・同意のページと Server Action（`login/`・`consent/`。トランザクションが無いときの `not-found.tsx` と想定外の例外のときの `error.tsx` を含む）、OP のエラーページ（`oidc-error/page.tsx`）、全エンドポイントが共有する部品（`_oidc-provider/`）から成る。設定・クライアント・署名鍵・ストアの組み立ては `src/app/_oidc-provider/provider.ts` にある。`src/app` の外にある `src/instrumentation.ts` と `src/sample-data.ts` は、起動時にクライアントとユーザーを登録するサンプルのコードである。

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

`VERCEL` が設定された環境でRedisの資格情報がない場合は、ほかの関数から読めない一時ファイルへ誤ってフォールバックしないよう起動を失敗させる。署名鍵は起動時生成のため、複数インスタンスに広がる本番相当の検証では固定鍵の読み込みへ置き換えること（`src/app/_oidc-provider/provider.ts` の署名鍵の節）。

## Google ログイン（任意）

このサンプルは `--enable google-login`（`@maronn-openid-connect/google-login`）付きで生成されており、`GOOGLE_CLIENT_ID` を設定するとログイン画面（`src/app/login/page.tsx`）に「Google でログイン」が表示され、`src/app/login/google/route.ts` が Google からの POST を受ける。未設定なら従来どおりユーザー名 + パスワードのみ。

1. Google Cloud コンソールで OAuth 2.0 クライアント ID（ウェブ アプリケーション）を作成する
2. 「承認済みの JavaScript 生成元」にログイン画面のオリジン、「承認済みのリダイレクト URI」に `<issuer>/login/google` を登録する（Google は `http://127.0.0.1` を生成元として受け付けないので、ローカルでは `localhost` で起動する）
3. 環境変数を付けて起動する

```bash
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com HOST=localhost OIDC_ISSUER=http://localhost:3010 pnpm sample:nextjs-vercel
```

`GOOGLE_HOSTED_DOMAIN=example.com` を足すと、その Google Workspace ドメインのアカウントだけを受け付ける。Google アカウントは、初めてのログインでランダムな ID のユーザーとしてその場で登録され（`user:` のキー）、Google の sub は `federated_identity:` のキーに記録される。`name` / `email` などのクレームは ID トークンから写される。Vercel では `vercel env add GOOGLE_CLIENT_ID production` で設定して再デプロイする（リダイレクト URI は `<OIDC_ISSUER>/login/google`。デプロイスクリプトが完了時に案内する）。
