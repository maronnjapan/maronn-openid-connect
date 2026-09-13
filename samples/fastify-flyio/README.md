# Fastify + Fly.io sample

Node.js組み込みの `node:sqlite` を使い、OPの全状態を `.data/oidc.sqlite` に永続化する。外部DBライブラリ、DBソフト、Dockerは不要（Node.js 22.13以上）。デプロイ想定環境はFly.io（永続ボリューム + 単一マシン）。

## ローカル起動（一発）

リポジトリルートから:

```bash
pnpm sample:fastify-flyio
```

クローン直後でも依存インストール・ビルド込みで `http://127.0.0.1:3010` に起動する。保存先は `OIDC_SQLITE_PATH` で変更できる。

## Fly.io へのデプロイ（一発・ガイド付き）

```bash
pnpm deploy:fastify-flyio
```

flyctl のインストール・`fly auth login`・アプリ名の決定（自動生成候補あり）は、必要な場合のみ対話で案内される。アプリ名は `.deploy/fly-app-name` に保存され、2回目以降は確認なしで再デプロイされる。ビルドはFlyのリモートビルダーで行うためローカルDockerも不要。完了時に `https://<app-name>.fly.dev` のDiscoveryでissuerの一致を自動検証する。

オプション: `--app-name` / `--region` / `--org` / `--dry-run`（詳細は `--help`）。

単一Nodeプロセスを永続ボリューム付きでデプロイするPoC向けであり、複数インスタンス構成では共有DB用の `JsonStoreBackend` 実装へ置き換える。署名鍵は起動時生成のため、fly.tomlは単一マシン構成に固定している。

## 署名鍵の固定

`OIDC_SIGNING_KEY_JWK` を設定しない場合、OPはプロセス／インスタンスごとにRS256鍵をその場で生成し、起動時に警告を出す。`kid` は固定なのに鍵素材はインスタンスごとに異なるため、JWKSを取得したインスタンスと署名したインスタンスが違うとID Token・JWTアクセストークンの検証が間欠的に失敗する（OIDC Core 1.0 §10.1 / RFC 7515 §4.1.4 は `kid` から鍵素材への対応が安定していることを前提とする）。単一プロセスのローカル起動では顕在化しないが、複数インスタンス構成や再デプロイをまたぐ検証では固定鍵が必要になる。

鍵はリポジトリルートで生成する（出力には秘密鍵が含まれるのでコミットしないこと）:

```bash
pnpm generate:signing-key --kid e2e-rs256-key
```

出力をFlyのsecretとして設定する:

```bash
fly secrets set OIDC_SIGNING_KEY_JWK="$(pnpm -s generate:signing-key --kid e2e-rs256-key)"
```

`OIDC_SIGNING_KEY_ID` を併用する場合は、JWKの `kid` と一致させること（食い違いは起動時エラーになる）。
