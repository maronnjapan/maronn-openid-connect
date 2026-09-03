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

## GCP Cloud Run へのデプロイ（追加の検証先・ガイド付き）

Fly.ioとは別の実インフラでも同じコードを検証するための、任意のデプロイ先です。

```bash
bash ../../scripts/deploy-gcp-guide.sh fastify-flyio
```

GCPプロジェクトが未作成の場合の分岐、課金アカウントの確認、ローカルDockerでのビルド・push、Cloud RunのURL判明後のissuer反映まで含めた詳細は [`scripts/README.md`](../../scripts/README.md#deploy-gcp-guidesh--gcp-cloud-run-への検証デプロイ) を参照。こちらもFlyと同様、単一インスタンス固定のPoC向けであり、永続ディスクが無い分Cloud Run側の永続性はFlyより弱い。
