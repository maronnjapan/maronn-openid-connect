---
title: Quick Start
description: Get up and running with Maronn OpenID Connect in minutes.
---

## Prerequisites

- Node.js 20+（Next.jsサンプルのローカルSQLite利用は22.13+）
- pnpm（推奨）

## 1. CLI でコードを生成する

CLI で、選択したフレームワーク向けの OpenID Provider 実装コード一式を生成します。

```bash
pnpm dlx @maronn-openid-connect/cli generate hono
```

対応フレームワークは `hono` / `express` / `fastify` / `nextjs` です。
既定では `./oidc-provider` に、エンドポイント実装・設定・差し替え可能な`JsonStoreBackend`契約（未指定時はローカル検証用インメモリ実装）・ログイン / 同意画面・契約テスト（`conformance.test.ts`）が生成されます。Next.jsではVercel向けUpstash Redis RESTとローカルSQLiteのアダプターも生成されます。

既存アプリに組み込む場合は `setup` コマンドが使えます（Next.js 以外）。エントリファイル内のプレースホルダーコメントを `applyOidc` の import と呼び出しに置換します。

```bash
maronn-oidc setup hono --entry ./src/index.ts
```

`setup` を使う前に、エントリファイルへ次の 2 種のコメントを**両方**書いておきます。

```typescript
import { Hono } from 'hono';
// <!-- OIDC_IMPORT_PLACEHOLDER -->
const app = new Hono();
// <!-- OIDC_SETUP_PLACEHOLDER -->
```

片方でも欠けていると、`setup` はエントリファイルを書き換えずにエラーを表示して失敗します（終了コード 1）。エラーには欠けているプレースホルダー名が出るので、追記して再実行してください。既に `setup` 済みのファイルに再実行した場合は、書き換えずに `Already patched (no changes):` と表示して成功終了します。

## 2. 依存をインストールする

```bash
pnpm add hono @maronn-openid-connect/core
```

（Express の場合は `express` と `@types/express`、Fastify の場合は `fastify` を追加します。）

## 3. アプリに組み込んで起動する

生成された `apply.ts` の `applyOidc` を呼び出し、署名鍵プロバイダーを注入します。

```typescript
import { Hono } from 'hono';
import { applyOidc } from './oidc-provider/apply.js';

const app = new Hono();

applyOidc(app, {
  config: { issuer: 'http://localhost:3000' },
  signingKeyProvider: yourSigningKeyProvider, // RS256 鍵を返す SigningKeyProvider
});

export default app;
```

`signingKeyProvider` は `{ getSigningKey(): Promise<SigningKey> }` を実装するオブジェクトで、RS256 の秘密鍵・公開 JWK・kid を返します。実装例はリポジトリの `samples/hono-cloudflare/src/app.ts` を参照してください。

`config.ts` のデフォルト値（クライアント登録・issuer 等）はローカル検証専用です。実運用相当の検証では環境変数 / DB / KV から供給してください。

## 4. 動作を確認する

起動後、Discovery メタデータで OP の設定を確認できます。

```bash
curl http://localhost:3000/.well-known/openid-configuration
```

生成された OP は次のエンドポイントを公開します。

- `/authorize` — 認可エンドポイント
- `/token` — トークンエンドポイント
- `/userinfo` — UserInfo エンドポイント
- `/login`, `/consent` — ログイン・同意画面
- `/.well-known/openid-configuration`, `/.well-known/jwks.json` — Discovery / JWKS
- `/introspect`, `/revoke` — Introspection / Revocation（既定で有効）

契約テストで生成 OP が想定挙動を満たすことを確認できます。

```bash
pnpm vitest run oidc-provider/conformance.test.ts
```

## Next Steps

- [CLI Guide](../guides/cli/) — コマンド・機能トグルの詳細
- [Using core](../guides/core/) — core パッケージを直接使う
- [Features](../reference/features/) — 実装済み機能の一覧
- [Authorization Code Flow](../concepts/authorization-code-flow/) — フローの全体像を理解する
