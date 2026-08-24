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
- `dependencies` にはモノレポ内のライブラリだけを使用し、外部ライブラリを追加しない
- `devDependencies` には外部ライブラリを使用してよい
- t_wada が提唱する方法でテスト駆動開発を行う
- 機能追加または修正を実ブラウザや実 HTTP フローで検証できる場合は、原則として `tests/e2e` に Playwright E2E テストも追加する
- E2E で使う OpenID Provider は `samples/*` 配下の CLI 生成アプリを対象とし、E2E 専用のクライアントとリソースサーバーは `tests/e2e` 配下に置く。`samples/*` には OP 以外の役割を混在させない
- `samples/*` の `conformance.test.ts` は、CLI 生成 OP が本リポジトリの想定する挙動を満たすことを示す契約テストとして扱う。生成 OP の挙動や resolver/store 契約を変更する場合は、`packages/cli` のテンプレートと各 sample の `conformance.test.ts` を更新する
- `packages/experimental/src` の変更に対して changeset を手で書かない。main への push で CI が patch の changeset を自動生成する。experimental の bump はどの変更でも patch 固定であり、minor または major を指定すると `pnpm run test:release-contract` が失敗する。詳細は `RELEASE.md` の「experimental の自動 publish」を参照する
- 利用者は生成コードを変更してよい。ただし、`conformance.test.ts` が通らない状態は、本リポジトリが担保する Basic OP の挙動から外れている可能性がある。この前提が必要な変更では、README、コメント、タスク文書のいずれかに明記する
- `packages/experimental` の機能を実装し終えたら、作業用 notes リポジトリの `implementation-guides/experimental/` に実装解説の日本語版と英語版を作成する。`packages/experimental/src` または CLI 統合を変更した場合は、該当解説の掲載コードと説明も同じ変更内で更新する

## ドキュメント作成の規約

README、実装解説、タスク文書などの Markdown 資料を作成または改稿するときは、次の規約を守ります。

- 日本語の文書を書く、または推敲するときは、作業用 notes リポジトリの `claude/skills/japanese-tech-writing/` にあるスキルを使用する
- 論点を足さない定型句を避け、人間が読みやすい文章にする
- 実装解説では対象コードを抜粋せず、notes リポジトリの `implementation-guides/experimental/` にある既存解説と同じく全文を掲載する

## テストコードの書き方

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
it('should keep hadOfflineAccess true', async () => {
  const result = await validateTokenRequest(context);
  if (result.grantType === 'refresh_token') {
    expect(result.hadOfflineAccess).toBe(true);
  }
});

// 良い例：判別フィールドを含めて expect で検証する
it('should keep hadOfflineAccess true', async () => {
  const result = await validateTokenRequest(context);
  expect(result).toMatchObject({
    grantType: 'refresh_token',
    hadOfflineAccess: true,
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
リクエスト情報が必要な検証などは、統合テストに記述します。

### samples配下のconformance.test.ts

各 sample の `conformance.test.ts` は OP の結合テストです。
実際に OP へリクエストしたときの想定挙動を網羅します。
OP のリクエスト処理が変わる機能を `packages` 側へ追加した場合は、`conformance.test.ts` も更新します。
ただし、生成後のファイルを直接変更せず、`packages/cli` にある生成処理を変更します。

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

- **モノレポ構成**：`packages/*` にパッケージを配置する
- **Web 標準技術のみ**：Node.js 固有の API ではなく、Fetch API や Web Crypto API などの Web 標準 API を使用する
- **外部依存なし**：production の `dependencies` には外部ライブラリを使用しない

## 準拠仕様

- OpenID Connect Core 1.0
- OAuth 2.1（PKCE 必須）
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

### samples/*

`packages/core` などの機能を実際に試すための OpenID Provider 専用サンプルです。
OpenID Connect 機能は、原則として `packages/cli` のコード生成処理で実装します。
ストア処理や環境変数などの設定は、各 sample で設定します。
`samples/*/src/oidc-provider` は CLI の生成物なので、変更が必要な場合は `packages/cli` を修正します。
クライアントやリソースサーバーは sample に同居させず、E2E 専用のものは `tests/e2e` 配下に置きます。

sample のディレクトリ名は、デプロイ先が分かる「フレームワーク-デプロイ想定環境」形式にします（例：`hono-cloudflare`、`express-flyio`、`fastify-flyio`、`nextjs-vercel`）。
各 sample は、リポジトリルートの `pnpm sample:<サンプル名>` でローカル起動し、`pnpm deploy:<サンプル名>` でガイド付きデプロイできる状態を維持します。
ログインや外部サービスの資格情報など、人間の操作が必要な箇所はデプロイスクリプト内で案内します。

### tests/e2e

Playwright による E2E テストを配置します。
CLI 生成済みの `samples/*` の OpenID Provider を起動し、E2E 専用のクライアントとリソースサーバーを `tests/e2e/apps` に分離して検証します。
