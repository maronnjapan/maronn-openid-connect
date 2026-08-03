# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクトについて

### コンセプト

**「最新のOIDC/OAuth仕様を誰よりも早く・忠実に・どこでも動く形で検証できるOSSライブラリ」**

OAuth/OIDC周辺の認証・認可技術を爆速で試せるツールとして開発している。
Keycloakは構築コストが重く、Auth0等のIdaaSはエンタープライズ向けで気軽に試せない。
このライブラリは「自分の要件がこの仕様で実現できるか？」を素早く検証するためのブリッジを提供する。
検証が完了したら利用者は本格的なIdaaSやOSSへ移行していく、というユースケースを想定している。

### ターゲットユーザー

PoC開発者・本番導入を見据える開発者。学習者の手厚いサポートは主目的としない。

### 差別化の3軸

| 軸 | 内容 |
|---|---|
| **Speed** | 新しいOIDC/OAuth仕様が出たとき最速で実装・追随する |
| **Fidelity** | Conformance準拠を信頼性のシグナルとして維持する |
| **Portability** | Web標準APIのみ使用し、JavaScriptが動く環境ならどこでも動く |

### リリース方針

主要フロー（7〜8割）が動く状態になったら先にリリースし、オプショナルな実装とConformance通過はその後に継ぎ足す。
「完璧になってから出す」より「動くものを早く出して改善する」を優先する。
ただしテストコードで主要ケースを網羅し、仕様参照を明記することは必須とする。

### 利用者の入口

CLIコマンドでフロー実装コードを生成し、利用者はそのコードを改造しながら仕様を検証する。
`core`はロジック層（高度な組み込みユースケース向け）、`samples/*`はCLI生成コードを実行する内部動作確認用であり利用者が直接触るものではない。


## 実装におけるルール

実装する際は以下のルールを必ず守ってください。
- コマンドはpnpmを使用すること
- dependenciesは内部ライブラリをのみ使用し、外部ライブラリは使用しないこと
- devDependenciesは任意の外部ライブラリを使用してもよい
- t_wada が言っている方法でテスト駆動開発を行うこと
- 機能追加・修正時に、既存の単体テストや統合テスト以外でも実ブラウザ・実HTTPフローで検証できる場合は、原則として`tests/e2e`にPlaywright E2Eテストも追加すること
- E2Eで使うOpenID Providerは`samples/*`配下のCLI生成アプリを対象にし、E2E専用のクライアントやリソースサーバーは`tests/e2e`配下に置くこと。`samples/*`にはOP以外の役割を混在させないこと
- `samples/*` の `conformance.test.ts` は、CLI生成OPが本リポジトリの想定する挙動を満たすことを利用者に示す契約テストとして扱うこと。生成OPの挙動やresolver/store契約を変更する場合は、`packages/cli`のテンプレートと各sampleの`conformance.test.ts`を更新し、利用者が生成コードを改変して想定挙動から外れた場合にテスト失敗で認識できるようにすること
- `packages/experimental/src` の変更に対して changeset を手で書かないこと。main への push で CI が patch の changeset を自動生成する（`.github/scripts/ensure-experimental-changeset.mjs`）。experimental の bump はどんな変更でも patch 固定で、minor / major を指定すると `pnpm run test:release-contract` が落ちる。詳細は `RELEASE.md` の「experimental の自動 publish」を参照
- 利用者は生成コードをカスタマイズしてよいが、`conformance.test.ts` が通らない状態は本リポジトリが担保するBasic OP挙動から外れている可能性がある。その前提が必要な変更では、README・コメント・タスク文書のいずれかに明示すること

## テストコードの書き方

### テストケースの命名規則

テストケースは以下のルールに従って記述すること：

1. **テストケース名は「should + 動詞」形式で記述する**
   - ❌ 悪い例: `it('alg claim', () => {})`
   - ✅ 良い例: `it('should set alg claim to RS256', () => {})`

2. **何をテストするのか、主語と動詞で明確にする**
   - テストケースを読んだだけで、何を検証するのかが分かるようにする
   - 実装の意図が明確になるように記述する

3. **テスト構造は以下の階層で構成する**
   - **トップレベル**: 関数名の `describe`
   - **中間レベル**: テストカテゴリの `describe`（省略可）
   - **最下層**: 具体的なテストケースの `it`

### テストケース記述例

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

- 標準化されたクレームや特別な理由がある場合は、コメントで理由を明記する
- 仕様書のセクション番号を参照する場合は、コメントに記載する

```typescript
// Standard profile claims (profile scope) - OIDC Core Section 5.4
// These are standardized claims that require specific handling
it('should include name claim when profile scope is requested', () => {});
```

### テストケース内では条件分岐を書かない

- **テストケース内（`it` ブロック）に `if` 文を書かない**。判定は必ず `expect` で行う
- 判別共用体（discriminated union）の型ナローイングのために `if` を使うと、条件が偽のときアサーションが一切実行されず、テストが黙ってパスしてしまう
- 代わりに `expect(result).toMatchObject({ ... })` を使い、判別用のフィールド（例: `grantType`）も含めて一度に検証する

```typescript
// ❌ 悪い例: if が偽のとき expect が実行されずパスしてしまう
it('should keep hadOfflineAccess true', async () => {
  const result = await validateTokenRequest(context);
  if (result.grantType === 'refresh_token') {
    expect(result.hadOfflineAccess).toBe(true);
  }
});

// ✅ 良い例: 判別フィールドごと expect で検証する
it('should keep hadOfflineAccess true', async () => {
  const result = await validateTokenRequest(context);
  expect(result).toMatchObject({
    grantType: 'refresh_token',
    hadOfflineAccess: true,
  });
});
```

### アサーションは合格値を一意に固定する

- **合格しうる値が複数あるマッチャは可能な限り使わない**。`expect.any()` / `expect.anything()` / `toContain()` / `stringContaining()` / `objectContaining()` などは、誤った値でもテストが通ってしまいリグレッションを見逃しやすい
- 期待値が確定できる場合は `toBe` / `toEqual` で具体値を固定する
- 配列はメンバー存在チェック（`toContain`）ではなく、要素と順序を含めて `toEqual` で固定する
- 大きなオブジェクトの一部だけ検証したい場合は `toMatchObject` を使ってよいが、各キーの値は具体値で固定する（値に `expect.any` を使わない）

```typescript
// ❌ 悪い例: どんな文字列でも、配列に code が含まれてさえいれば通る
expect(metadata.issuer).toEqual(expect.any(String));
expect(metadata.response_types_supported).toContain('code');

// ✅ 良い例: 期待値を一意に固定する
expect(metadata.issuer).toBe('http://localhost:3000');
expect(metadata.response_types_supported).toEqual(['code']);
```

### 実装不可能なテストケースの扱い

- 関数単体では実装できないテストケース（外部依存が必要なもの）は記述しない
- 例: リクエスト情報が必要なテストは、統合テストで記述する

### samplesディレクトリの各フレームワークディレクトリ内にあるconformance.test.tsについて
conformance.test.tsはOPの結合テストを行うためのテストコードである。
そのため、実際にOPに対してリクエストがあった際に想定される挙動を全て網羅しておく必要がある。
よって、packages側で機能が追加され、OPに対してリクエストがあった際の挙動が変化した場合、conformance.test.tsを更新する必要がある。
ただし、conformance.test.tsを直接変更するのではなく、conformance.test.tsを生成するpackages/cli内のconformance.test.tsを生成するコードを必ず変更すること。

## コマンド

```bash
# 依存関係のインストール
pnpm install

# テストの実行（設定後）
pnpm test

# 特定のパッケージでコマンドを実行
pnpm --filter <package-name> <command>
```

## アーキテクチャ

- **モノレポ構成**: `packages/*`にパッケージを配置
- **Web標準技術のみ**: Node.js固有のAPIではなくWeb標準API（Fetch API、Web Crypto API等）を使用
- **外部依存なし**: productionの依存関係（dependencies）には外部ライブラリを使用しない

## 準拠仕様

- OpenID Connect Core 1.0
- OAuth 2.1（PKCE必須）
- OpenID Connect Conformance Profiles v3.0 (Basic OP)

### Basic OPの必須機能

- Authorization Code Flow (`response_type=code`)
- PKCE（S256必須）
- ID Token署名（RS256必須）
- Token Endpoint
- UserInfo Endpoint
- `prompt`パラメータ対応（none, login, consent, select_account）

## ディレクトリの構成
### packages/core
OpenID Connect Providerのコア機能を実装するパッケージ。
IDトークンの生成や、認可エンドポイント、トークンエンドポイントの内部処理を実装。
OpenID Connectの仕様に準拠した主要ロジックを提供する。

### packages/cli
packages/coreなどのOpenID Connect関連機能をプロジェクトに導入するために使用されるcliツール。
コマンドを実行することで、対象プロジェクト内にAuthorization Code FlowやOpenID Connectの拡張機能などを実行するためのコードを生成できる。

### samples/*
packages/coreなどの機能を実際に試すためのOpenID Provider専用サンプル。
OpenID Connect機能については、packages/cliのコード生成する処理にて基本的に実装される想定。
その他の設定(使用するストアの処理や環境変数など)については、cli経由ではなく自分で設定している。
samples/*/src/oidc-providerについては、packages/cliによるコード生成されたものなので、この部分の修正が必要な場合は必ずpackages/cliを修正することで対応すること。
クライアントやリソースサーバーはここに同居させず、E2E専用のものはtests/e2e配下に置くこと。

ディレクトリ名は、どこへデプロイして検証する想定かが一目で分かるよう「フレームワーク-デプロイ想定環境」の形式で命名すること（例: `hono-cloudflare`, `express-flyio`, `fastify-flyio`, `nextjs-vercel`）。新しいサンプルを追加する場合もこの規則に従うこと。
各サンプルは、リポジトリルートの `pnpm sample:<サンプル名>` で一発ローカル起動、`pnpm deploy:<サンプル名>` でガイド付き一発デプロイができる状態を維持すること。デプロイに人間の操作が必須な箇所（ログイン、外部サービスの資格情報など）は、デプロイスクリプト内のガイドで対話的に設定できるようにすること。

### tests/e2e
PlaywrightによるE2Eテストを配置するディレクトリ。
CLI生成された`samples/*`のOpenID Providerを実際に起動し、E2E専用のクライアントやリソースサーバーを`tests/e2e/apps`に分離して検証する。


## レビュー内容について
リポジトリ内のMarkdownファイルに関連するレビューコメントは`.review/` ディレクトリに保存されている。
レビューコメントは、対象ファイルと同じ相対パスを `.review/` 配下に再現し、末尾に `.review.json` を付けたファイルとして保存される。

例:
- 対象ファイル: `tasks/p1-basic-op-authorization-error-page.md`
- レビューコメント: `.review/tasks/p1-basic-op-authorization-error-page.md.review.json`

レビューJSONのトップレベル構造は次のとおり。

```json
{
  "targetFile": "レビュー対象ファイルのリポジトリ相対パス",
  "updatedAt": "レビューJSONの最終更新日時（ISO 8601）",
  "comments": [
    {
      "id": "コメントID",
      "type": "document | section | paragraph | text-selection",
      "comment": "レビューコメント本文",
      "createdAt": "コメント作成日時（ISO 8601）"
    }
  ]
}
```

各コメントの `type` は、コメントがどの粒度に紐づくかを表す。

- `document`: 文書全体へのコメント。特定の見出しや本文位置に限定しない。
- `section`: 見出し単位へのコメント。`headingPath` と `heading` を使って対象セクションを特定する。
- `paragraph`: 段落単位へのコメント。`targetText` または `selectedText` を対象段落の手がかりにする。
- `text-selection`: 選択範囲へのコメント。`selectedText`、`contextBefore`、`contextAfter` を使って対象箇所を特定する。

コメントには、必要に応じて次の位置情報が含まれる。

- `headingPath`: 対象箇所が属する見出し階層。章・節・小見出しの順に配列で入る。
- `heading`: `section` コメントの対象見出し。
- `selectedText`: コメント作成時に選択された本文。
- `targetText`: 段落や見出しなど、CLIが対象として記録したテキスト。
- `contextBefore`: `text-selection` の直前にある本文。
- `contextAfter`: `text-selection` の直後にある本文。

レビューコメントを反映するときは、次の順序で確認する。

1. `.review/**/*.review.json` を読み、`targetFile` ごとに対象原稿を開く。
2. `comments` を上から順に確認する。
3. `headingPath` がある場合は、まず対象原稿内の該当見出しへ移動する。
4. `text-selection` は `selectedText` だけで機械的に置換せず、`contextBefore` と `contextAfter` も見て同じ箇所か確認する。
5. `paragraph` は `targetText` または `selectedText` を段落特定の手がかりにする。ただし末尾の「段落にコメント」など、CLI表示由来の補助文言は本文そのものではない場合がある。
6. `section` は見出し配下全体への指摘として扱い、見出し文言だけではなく、そのセクション本文を確認する。
7. `document` は文書全体の方針・構成・表現への指摘として扱う。
8. コメント本文の依頼内容を鵜呑みにせず、仕様・既存方針・周辺文脈と照らして、反映する内容と反映しない内容を判断する。

レビューコメント対応後は、対応したコメントIDと判断を作業報告に含める。
未対応にしたコメントがある場合は、理由を明記する。
