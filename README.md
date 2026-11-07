# maronn-openid-connect

最新の OpenID Connect（OIDC）および OAuth 仕様をJavaScript が動く環境で検証するための OSS ライブラリです。

## プロジェクトについて

### コンセプト

**「最新の OIDC/OAuth 仕様を簡単に動く形で検証できる OSS ライブラリ」**

OAuth/OIDC 周辺の認証および認可技術をすぐに試せるツールとして開発しています。
IDaaSや有名

### ターゲットユーザー

対象は PoC 開発者と、本番導入を見据える開発者です。
学習者への手厚いサポートは主目的としません。

### 差別化の3軸

| 軸 | 内容 |
|---|---|
| **Speed** | 新しい OIDC/OAuth 仕様が出たとき、早期に実装して追随する |
| **Fidelity** | Conformance 準拠を信頼性のシグナルとして維持する |
| **Portability** | Web 標準 API だけを使用し、JavaScript が動く環境で動作させる |

### リリース方針

主要フローの7割から8割が動く状態になったら先にリリースし、オプショナルな実装と Conformance 通過はその後に追加します。
「完璧になってから出す」より「動くものを早く出して改善する」ことを優先します。
ただし、テストコードで主要ケースを網羅し、仕様参照を明記することは必須です。

## ディレクトリの構成

### packages/core

OpenID Connect Provider のコア機能を実装するパッケージです。
ID Token の生成、認可エンドポイント、トークンエンドポイントの内部処理など、仕様に準拠した主要ロジックを提供します。

### packages/cli

OpenID Connect 関連機能をプロジェクトへ導入する CLI ツールです。
Authorization Code Flow や OpenID Connect の拡張機能を実行するためのコードを生成します。
`maronn-oidc graph` は、生成される OP をエンドポイントとステップの図（Mermaid）か JSON のフロー文書として書き出します。
フロー文書を編集して `--flow` で渡すと、ステップを消したり並べ替えたりした OP を生成できます。

### packages/google-login

Sign in with Google（Google Identity Services の redirect mode）を、`packages/core` で組んだ OP のログイン手段として使うための拡張パッケージです。
Google が `login_uri` へ POST する ID トークンの検証は Google 公式の `google-auth-library` に委ね、このパッケージは `g_csrf_token` の Double Submit Cookie 検証、任意の `hd` / `email_verified` の確認、core の認証トランザクションへの束縛（nonce）を提供します。ログイン画面の UI は生成せず、置くべき GIS の設定（`g_id_onload` の属性）だけを Node 非依存のサブパス `@maronn-openid-connect/google-login/sign-in` で組み立てます（プレーン HTML / React / Vue のどれでも使えます）。
単体で使うものではなく、core と組み合わせて `packages/cli` の生成コードから呼び出す想定です。`maronn-oidc generate <framework> --enable google-login` で生成コードに組み込まれ（拡張機能。既定では無効）、ログイン画面の「Google でログイン」ボタンと `POST /login/google` の受け口が追加されます。`samples/express-flyio` / `samples/fastify-flyio` / `samples/nextjs-vercel` は `GOOGLE_CLIENT_ID` を設定すると Google ログインが有効になります。
`google-auth-library` の要件により Node.js 22 以上限定で、エッジランタイムでは動きません。

### apps/*

CLI が生成コードを抽出する元の、全機能オンの OpenID Provider です。
private な workspace パッケージで、それぞれ単体で起動できます。
`apps/hono`（`@maronn-openid-connect/app-hono`）は Hono の OP で、`pnpm --filter @maronn-openid-connect/app-hono dev` で `src/server.ts` がメモリ DB と開発用のクライアントとユーザーを登録して待ち受けます。

`src/oidc-provider/` が CLI の抽出範囲です。
エンドポイントは `endpoints/<endpoint>/pipeline.ts` に `// [step-id]` 付きの呼び出し列を持ち、ステップは `steps/<id>.ts` に一つずつ置いて `meta` で自分を記述します。
機能は `features/<id>/` のディレクトリで、`feature.ts` がフック（routes、discovery、context など）で base への差し込み先を宣言します。
有効な機能は `features/enabled.ts` が列挙し、DB は `db/memory/`、`db/sql/`、`db/kv/` が同じ export 名で `db/index.ts` から選ばれます。

`apps/nextjs`（`@maronn-openid-connect/app-nextjs`）は Next.js（App Router）の OP で、`pnpm --filter @maronn-openid-connect/app-nextjs dev` で `next dev` が起動し、`src/instrumentation.ts` が開発用のクライアントとユーザーを登録します。
`src/app/` が CLI の抽出範囲で、App Router の作法のまま書いています。
機能のルートはその機能の route group `(<feature-id>)/` に、ルートを持たない機能のロジックは `_oidc-provider/features/<id>/` に置き、`_oidc-provider/features.ts` が有効な機能を列挙します。
所有者付きブロックを持つ `route.ts` の隣には、ステップの一覧を書いた `endpoint.ts` を置きます。
DB は apps/hono と同じ `_oidc-provider/db/{memory,sql,kv}/` で、このアプリは `--db kv`（ローカルは node:sqlite）で動きます。

生成コードを直すときは、この二つのアプリの実コードと隣のテストを直します。
OP 以外の役割（クライアントやリソースサーバー）は置きません。

例外が `apps/map`（`@maronn-openid-connect/map`）で、これは OP ではなく、生成される OP の地図を見るページです。
フレームワークと機能を切り替えると、その構成のエンドポイントの処理を字下げした行で表示し、呼び出しをその場で開いて下の関数までたどれます。
分岐ごとに進む側を選ぶと、その道筋で通らない行が灰色になります（行は消えません）。
`/token` なら「refresh_token グラントを検証する」のような、よく使う選択も並びます。
処理の流れは、ビルド時に `packages/map-analysis` が TypeScript のコンパイラで読みます（React + Vite、Cloudflare Workers に静的アセットとして置く）。
`pnpm run build:map` でビルドし、PR ごとに `map-preview.yml` がプレビューを発行します。
PR の地図は、その PR が変えた関数に札を付け、何を変えたか（処理の流れの差分）、どのエンドポイントに届くか、`apps/map/changes/` の変更メモに書いた意図を表示します。
詳しくは [apps/map/README.md](apps/map/README.md) を参照してください。

### samples/*

`packages/core` などの機能を実際に試すための OpenID Provider 専用サンプルです。
OpenID Connect 機能は、原則として `apps/*` の実コードに実装し、`packages/cli` がそこから生成コードを抽出します。
ストア処理や環境変数などの設定は、各 sample で設定します。
`samples/*/src/oidc-provider`（Next.js は `src/app`）は CLI の生成物なので、変更が必要な場合は生成元の `apps/*` を修正して再生成します。
ただし、`--db` で生成した `db/instance.ts` は各 sample が書く DB インスタンスで、CLI は上書きしません（sample はどれも `--db` で生成しています）。
クライアントやリソースサーバーは sample に同居させず、E2E 専用のものは `tests/e2e` 配下に置きます。

sample のディレクトリ名は、デプロイ先が分かる「フレームワーク-デプロイ想定環境」形式にします（例：`hono-cloudflare`、`express-flyio`、`fastify-flyio`、`nextjs-vercel`）。
各 sample は、リポジトリルートの `pnpm sample:<サンプル名>` でローカル起動し、`pnpm deploy:<サンプル名>` でガイド付きデプロイできる状態を維持します。
ログインや外部サービスの資格情報など、人間の操作が必要な箇所はデプロイスクリプト内で案内します。

### tests/e2e

Playwright による E2E テストを配置します。
`apps/*` または CLI 生成済みの `samples/*` の OpenID Provider を起動し、E2E 専用のクライアントとリソースサーバーを `tests/e2e/apps` に分離して検証します。
`pnpm run test:e2e` は `apps/hono` と `apps/nextjs` を対象に PR ごとに走り、`pnpm run test:e2e:samples` は四つの samples を対象に `e2e-samples.yml`（nightly と手動起動）で走ります。
