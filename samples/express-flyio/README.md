# Express + Fly.io sample

Node.js組み込みの `node:sqlite` を使い、OPの全状態を `.data/oidc.sqlite` に永続化する。外部DBライブラリ、DBソフト、Dockerは不要（Node.js 22.13以上）。デプロイ想定環境はFly.io（永続ボリューム + 単一マシン）。

## ローカル起動（一発）

リポジトリルートから:

```bash
pnpm sample:express-flyio
```

クローン直後でも依存インストール・ビルド込みで `http://127.0.0.1:3010` に起動する。保存先は `OIDC_SQLITE_PATH` で変更できる。

## Fly.io へのデプロイ（一発・ガイド付き）

```bash
pnpm deploy:express-flyio
```

flyctl のインストール・`fly auth login`・アプリ名の決定（自動生成候補あり）は、必要な場合のみ対話で案内される。アプリ名は `.deploy/fly-app-name` に保存され、2回目以降は確認なしで再デプロイされる。ビルドはFlyのリモートビルダーで行うためローカルDockerも不要。完了時に `https://<app-name>.fly.dev` のDiscoveryでissuerの一致を自動検証する。

オプション: `--app-name` / `--region` / `--org` / `--dry-run`（詳細は `--help`）。

単一Nodeプロセスを永続ボリューム付きでデプロイするPoC向けであり、複数インスタンス構成では共有DB用の `JsonStoreBackend` 実装へ置き換える。署名鍵は起動時生成のため、fly.tomlは単一マシン構成に固定している。

## Google ログイン（任意）

このサンプルは `--enable google-login`（`@maronn-openid-connect/google-login`）付きで生成されており、`GOOGLE_CLIENT_ID` を設定するとログイン画面に「Google でログイン」が表示される。未設定なら従来どおりユーザー名 + パスワードのみ。

1. Google Cloud コンソールで OAuth 2.0 クライアント ID（ウェブ アプリケーション）を作成する
2. 「承認済みの JavaScript 生成元」にログイン画面のオリジン、「承認済みのリダイレクト URI」に `<issuer>/login/google` を登録する（Google は `http://127.0.0.1` を生成元として受け付けないので、ローカルでは `localhost` で起動する）
3. 環境変数を付けて起動する

```bash
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com HOST=localhost ISSUER=http://localhost:3010 pnpm sample:express-flyio
```

`GOOGLE_HOSTED_DOMAIN=example.com` を足すと、その Google Workspace ドメインのアカウントだけを受け付ける。Google アカウントは `google:<sub>` を subject とするユーザーとしてその場で登録され（SQLite に永続化）、`name` / `email` などのクレームは ID トークンから写される。Fly.io へのデプロイ時は `GOOGLE_CLIENT_ID=... pnpm deploy:express-flyio` のように渡すと、そのままアプリの環境変数として設定される（リダイレクト URI は `https://<app-name>.fly.dev/login/google`）。
