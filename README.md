# maronn-openid-connect

最新の OpenID Connect（OIDC）および OAuth 仕様を、早く、仕様に忠実に、JavaScript が動く環境で検証するための OSS ライブラリです。

## プロジェクトについて

### コンセプト

**「最新の OIDC/OAuth 仕様を誰よりも早く、忠実に、どこでも動く形で検証できる OSS ライブラリ」**

OAuth/OIDC 周辺の認証および認可技術をすぐに試せるツールとして開発しています。
Keycloak は構築コストが重く、Auth0 などの IDaaS はエンタープライズ向けで気軽に試しにくいという問題があります。
このライブラリは「自分の要件がこの仕様で実現できるか」を素早く検証するための橋渡しをします。
検証後は、本格的な IDaaS や OSS へ移行する利用形態を想定しています。

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

### 利用者の入口

CLI コマンドでフローの実装コードを生成し、利用者はそのコードを変更しながら仕様を検証します。
`core` は高度な組み込み用途のロジック層です。
`samples/*` は CLI 生成コードを実行する内部動作確認用であり、利用者が直接触るものではありません。

## 実装におけるルール

実装時は次のルールを守ります。

- コマンドには pnpm を使用する
- 関数は検証、取得、保存、変換などの責務ごとに分け、個別に組み合わせて呼び出せるようにする。引数は文字列、数値、真偽値、配列、必要な項目だけのオブジェクトを優先し、関係のないリクエスト情報やストア操作を要求しない
- `dependencies` にはモノレポ内のライブラリだけを使用し、外部ライブラリを追加しない。例外は `packages/google-login` の `google-auth-library` だけで、Google の ID トークン検証（公開鍵の取得・署名検証）の仕様変更へ自前で追随しないために Google 公式ライブラリへ委ねている
- `devDependencies` には外部ライブラリを使用してよい
- t_wada が提唱する方法でテスト駆動開発を行う
- 機能追加または修正を実ブラウザや実 HTTP フローで検証できる場合は、原則として `tests/e2e` に Playwright E2E テストも追加する
- E2E で使う OpenID Provider は、PR ごとに `apps/*` の全機能オンのアプリを、nightly と手動起動で `samples/*` の CLI 生成アプリを対象とする。E2E 専用のクライアントとリソースサーバーは `tests/e2e` 配下に置き、`apps/*` と `samples/*` には OP 以外の役割を混在させない
- `apps/hono/src/oidc-provider` と `apps/nextjs/src/app` の base（機能と db の種類が持つファイル以外）は、機能のディレクトリと experimental パッケージを import しない。機能は `features/feature.ts`（Next.js は `_oidc-provider/feature.ts`）のフックか、パイプライン（`pipeline.ts`、Next.js は `route.ts`）の所有者付きブロック（`// [step-id] (feature: <id>) ...`）で base に差し込む。この境界は `pnpm run lint`（`.github/scripts/lint-import-boundaries.mjs`）が検査する
- `packages/experimental/src` の変更に対して changeset を手で書かない。main への push で CI が patch の changeset を自動生成する。experimental の bump はどの変更でも patch 固定であり、minor または major を指定すると `pnpm run test:release-contract` が失敗する。詳細は `RELEASE.md` の「experimental の自動 publish」を参照する
- `packages/experimental` の機能を実装し終えたら、作業用 notes リポジトリの `implementation-guides/experimental/` に実装解説の日本語版と英語版を作成する。`packages/experimental/src` または CLI 統合を変更した場合は、該当解説の掲載コードと説明も同じ変更内で更新する

## ドキュメント作成の規約

README、実装解説、タスク文書などの Markdown 資料を作成または改稿するときは、次の規約を守ります。

- 日本語の文書を書く、または推敲するときは、作業用 notes リポジトリの `claude/skills/japanese-tech-writing/` にあるスキルを使用する
- 論点を足さない定型句を避け、人間が読みやすい文章にする
- 実装解説では対象コードを抜粋せず、notes リポジトリの `implementation-guides/experimental/` にある既存解説と同じく全文を掲載する

## テストコードの書き方

`apps/*` の実コードには単体テストを書きます。
ステップは `steps/<id>.ts` の隣に `<id>.test.ts` を置き、機能は `features/<id>/` の中で同じように置きます。
テストは CLI の抽出範囲から除外されるので、生成物には含まれません。

生成物の文字列やファイル構成を検査するテストは書きません。
CLI が生成した機能の組合せは型検査だけで確かめ、生成 OP の挙動は `tests/e2e` の E2E テストと `tests/conformance` の OpenID Conformance Suite で確認します。
CLI 自体の入力検証、エラー処理、既存ファイルの保護は `packages/cli` の単体テストで検証します。

### テストケースの命名規則

テストケースは次のルールに従って記述します。

1. テストケース名を「should + 動詞」形式で記述する
2. 主語と動詞を明確にし、名前だけで検証内容が分かるようにする
3. トップレベルを関数名の `describe`、中間レベルをテストカテゴリの `describe`、最下層を具体的な `it` とする。中間レベルは省略してよい

```typescript
describe('generateIdToken', () => {
  describe('JOSE Header', () => {
    it('should set alg claim to RS256', () => {});
    it('should include kid claim when keyId is provided', () => {});
    it('should set typ claim to JWT', () => {});
  });

  describe('Required Claims', () => {
    it('should include iss matching configured issuer', () => {});
    it('should reject missing iss', () => {});
  });
});
```

### コメントの記述

標準化されたクレームや特別な理由がある場合は、コメントに理由を記載します。
仕様書のセクション番号を参照する場合も、コメントに記載します。

```typescript
// Standard profile claims (profile scope) - OIDC Core Section 5.4
// These are standardized claims that require specific handling
it('should include name claim when profile scope is requested', () => {});
```

### テストケース内では条件分岐を書かない

テストケースの `it` ブロックに `if` 文を書かず、判定は `expect` で行います。
判別共用体の型ナローイングに `if` を使うと、条件が偽のときにアサーションが一つも実行されず、テストが通るおそれがあります。

```typescript
// 悪い例：if が偽のとき expect が実行されない
it('should resolve the refresh token first when token_type_hint is refresh_token', async () => {
  const resolved = await resolveIntrospectionToken(options);
  if (resolved?.tokenType === 'refresh_token') {
    expect(resolved.refreshToken.grantId).toBe('grant-1');
  }
});

// 良い例：判別フィールドを含めて expect で検証する
it('should resolve the refresh token first when token_type_hint is refresh_token', async () => {
  const resolved = await resolveIntrospectionToken(options);
  expect(resolved).toMatchObject({
    tokenType: 'refresh_token',
    refreshToken: { grantId: 'grant-1' },
  });
});
```

### アサーションは合格値を一意に固定する

合格しうる値が複数あるマッチャーは可能な限り使いません。
期待値を確定できる場合は、`toBe` または `toEqual` で具体値を固定します。
配列は `toContain` ではなく、要素と順序を `toEqual` で固定します。
大きなオブジェクトの一部だけを検証する場合は `toMatchObject` を使えますが、各キーの値は具体値で固定します。

```typescript
// 悪い例：誤った文字列や余分な配列要素を許す
expect(metadata.issuer).toEqual(expect.any(String));
expect(metadata.response_types_supported).toContain('code');

// 良い例：期待値を一意に固定する
expect(metadata.issuer).toBe('http://localhost:3000');
expect(metadata.response_types_supported).toEqual(['code']);
```

### 実装不可能なテストケースの扱い

外部依存が必要で関数単体では検証できないテストケースは、単体テストに記述しません。
リクエスト情報が必要な検証などは、`tests/e2e` の E2E テストに記述します。

## コマンド

```bash
# 依存関係のインストール
pnpm install

# テストの実行
pnpm test

# 特定のパッケージでコマンドを実行
pnpm --filter <package-name> <command>
```

## アーキテクチャ

- **モノレポ構成**：`packages/*` にパッケージを、`apps/*` に CLI が生成コードを抽出する元のアプリを配置する
- **Web 標準技術のみ**：Node.js 固有の API ではなく、Fetch API や Web Crypto API などの Web 標準 API を使用する
- **外部依存なし**：production の `dependencies` には外部ライブラリを使用しない（例外は `packages/google-login` の `google-auth-library`。同パッケージのみ Node.js 22 以上限定になる）

## 準拠仕様

- OpenID Connect Core 1.0
- OAuth 2.1（PKCE 必須）
- OAuth 2.0 Form Post Response Mode（`response_mode=form_post`）
- OpenID Connect Conformance Profiles v3.0（Basic OP）

### Basic OPの必須機能

- Authorization Code Flow（`response_type=code`）
- PKCE（S256 必須）
- ID Token 署名（RS256 必須）
- Token Endpoint
- UserInfo Endpoint
- `prompt` パラメータ（`none`、`login`、`consent`、`select_account`）

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
