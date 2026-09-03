# scripts/*

`samples/*` を検証用インフラへ立ち上げる/デプロイするための、リポジトリ横断の実行スクリプト集です。個々のサンプルに閉じたデプロイスクリプト（`samples/*/scripts/deploy-*.sh`）は各サンプルの README を参照してください。ここでは複数サンプルにまたがる、または `scripts/` 直下に置く方が自然なツールを扱います。

## sample-up.sh — ローカル起動

```bash
pnpm sample:express-flyio   # 他は sample:fastify-flyio / sample:hono-cloudflare / sample:nextjs-vercel
```

クローン直後でも依存インストール・ビルド込みで、指定したサンプルを `http://127.0.0.1:3010` で起動します。詳細は各サンプルの README を参照してください。

## deploy-gcp-guide.sh — GCP Cloud Run への検証デプロイ

`express-flyio` / `fastify-flyio`（node:sqliteで状態を永続化する単一プロセスNode.jsサンプル）を、Fly.ioとは別の実インフラであるGoogle Cloud Runへデプロイし、同じCLI生成コードがCloud Runのコンテナ実行モデルでも動くことを検証するためのスクリプトです。

`samples/*/scripts/deploy-*.sh` と同様、**メンテナ向けの検証用ツールであり、ライブラリ利用者向けの本番デプロイ手順ではありません**。

### 使い方

```bash
# 単体
bash scripts/deploy-gcp-guide.sh express-flyio
bash scripts/deploy-gcp-guide.sh fastify-flyio

# 両方まとめて
bash scripts/deploy-gcp-guide.sh all

# pnpm 経由（引数を渡す場合は -- が必要）
pnpm deploy:gcp -- all
```

オプション: `--project <id>` / `--region <region>`（既定 `asia-northeast1`） / `--repo <Artifact Registryリポジトリ名>`（既定 `maronn-openid-connect`） / `--dry-run`（実行予定のコマンドを表示するだけで何も実行しない） / `--help`。

### `all` を実行したときの流れ

`all` は `express-flyio` と `fastify-flyio` の両方を対象にします。GCPプロジェクトの確認・課金確認・API有効化・Artifact Registryリポジトリの用意は**1回だけ**行い、そのあとサンプルごとにビルド・push・デプロイ・検証を繰り返します。

1. **前提ツールの確認** — `gcloud` と `docker` の有無、Dockerデーモンに接続できるかを確認します。Cloud RunはFlyのようなリモートビルダーを持たないため、このスクリプトは**ローカルの `docker build` / `docker push`** でイメージを作ります。実行シェルからDockerが直接使える環境（Linux、またはWSL上でDocker DesktopのWSL統合かDocker Engineを有効にした環境）を前提にしています。Dockerデーモンに繋がらない場合、WSLを検出したときとLinuxネイティブのときとでエラーメッセージを出し分けます。
2. **ログイン確認** — `gcloud auth list` でログイン済みアカウントが無ければ `gcloud auth login` をその場で起動します（非対話環境では失敗し、事前ログインを促します）。
3. **GCPプロジェクトの決定** — このスクリプトの主眼です。「GCPプロジェクトをまだ作ったことがないのに、いきなりプロジェクトIDを聞かれて戸惑う」状況を避けるため、以下の順に分岐します。
   1. `--project` が指定されていればそれを使う。存在しなければ、その場で新規作成するか確認する。
   2. 前回このスクリプトで決定したプロジェクトIDが `.deploy-gcp/project-id`（gitignore済み）に残っていればそれを再利用する。
   3. どちらも無ければ `gcloud projects list` で**既存プロジェクトの一覧を提示**し、番号で選ばせる。
   4. 一覧が空（＝このアカウントでGCPプロジェクトを作ったことが無い、初回ユーザーによくあるケース）なら、その旨を明示した上で候補ID（`maronn-oidc-poc-<ランダム6文字>`）を提案し、`gcloud projects create` の実行を確認してから作る。
   
   つまり「プロジェクトが存在する前提でIDを尋ねる」動作はせず、存在しないケースを最初から別分岐として扱います。決定したプロジェクトIDは次回のために保存されるため、2回目以降は確認なしで同じプロジェクトを使います。
4. **課金アカウントの確認** — Cloud Runのデプロイには課金の有効化が必須です。対象プロジェクトに課金アカウントが未リンクの場合:
   - 利用可能な課金アカウントが1つだけ見つかれば、リンクするか確認してから自動でリンクします。
   - 複数見つかれば番号で選ばせます。
   - 1つも無ければ（課金アカウント自体をまだ作っていない場合。これはCLIだけでは完結できないため）Cloud Consoleでの作成URLを案内して終了します。
5. **API有効化** — `run.googleapis.com` と `artifactregistry.googleapis.com` を有効化します（有効化済みでも無害・冪等）。
6. **Artifact Registryリポジトリの用意** — 指定リポジトリ（既定 `maronn-openid-connect`）が無ければDocker形式で作成し、あれば再利用します。`gcloud auth configure-docker` でこのリポジトリへの `docker push` を認可します。
7. **サンプルごとのビルド・push・デプロイ**（`express-flyio` → `fastify-flyio` の順）
   - `docker build -f samples/<sample>/Dockerfile <リポジトリルート>` でビルド（ビルドコンテキストはpnpm workspace全体が必要なため、常にリポジトリルート）。
   - Artifact Registryへ `docker push`。
   - `gcloud run deploy` でサービス名 `maronn-oidc-<sample>` としてデプロイ。Fly版の「単一マシン固定」と同じ理由（署名鍵が起動時にメモリ上で生成され、複数インスタンスがあるとkidが食い違って検証が壊れる）で、`--min-instances 1 --max-instances 1` により常時1インスタンスに固定します。
   - Cloud RunのURLはデプロイして初めて判明するため、この時点では `issuer` 環境変数を設定していません。デプロイ後に `gcloud run services describe` でURLを取得し、`gcloud run services update --update-env-vars ISSUER=<URL>` で反映し直します（再ビルドは不要、新しいリビジョンが1つ増えるだけ）。
   - 最後に `<URL>/.well-known/openid-configuration` を取得し、`issuer` がそのURLと一致することを確認します（不一致ならエラー終了）。
8. **完了メッセージ** — 各サンプルのデプロイ先URLと、そのサービスを削除するコマンド（`gcloud run services delete ...`）を表示します。

### 既知の制約（検証用途であるがゆえの割り切り）

- **永続化はインスタンス単位**: Cloud Runのコンテナには永続ディスクが無いため、node:sqliteのファイルは `/tmp` 上（インスタンスのメモリ上）に置きます。`--min-instances 1 --max-instances 1` により起動中のインスタンスが入れ替わらない限りはデータも署名鍵も保持されますが、GCP都合でインスタンスが再作成された場合は失われます。Flyの永続ボリュームと違い、真の永続化ではありません。
- **課金**: `--min-instances 1` は常時1インスタンスを起動し続けるため、トラフィックが無くても課金が発生し続けます。検証が終わったら `gcloud run services delete` で削除してください。
- **`--dry-run` はネットワーク呼び出しを一切行いません**: プロジェクト一覧取得や既存リソースの確認も含め、実際のAPI呼び出しはせず、実行予定のコマンド列を表示するだけです。プロジェクトIDが未指定の場合はプレースホルダー（`<your-gcp-project-id>`）を表示します。

### 後片付け

```bash
gcloud run services delete maronn-oidc-express-flyio --region asia-northeast1 --project <project-id> --quiet
gcloud run services delete maronn-oidc-fastify-flyio --region asia-northeast1 --project <project-id> --quiet
gcloud artifacts repositories delete maronn-openid-connect --location asia-northeast1 --project <project-id> --quiet
```

プロジェクトごと不要になった場合は `gcloud projects delete <project-id>` も検討してください。
