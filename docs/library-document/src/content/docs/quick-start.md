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
既定では `./oidc-provider` に、エンドポイント実装・設定・ログイン / 同意画面と、データの保存先の `db/` が生成されます。`--db` を付けなければ、`db/` はデータをプロセスのメモリに置くローカル検証用の実装です。
`--db sql` か `--db kv` を付けると、`db/` はデータを SQL のテーブルかキー・バリューストアに保存する実装になります（DB インスタンスを返す `db/instance.ts` だけは利用者が書きます。[CLI Guide](../guides/cli/#database---db)を参照）。

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

（Express の場合は `express` と `@types/express`、Fastify の場合は `fastify` を追加します。Express と Fastify でも画面は hono/jsx で描くので、`hono` は必要です。）

生成される画面は hono/jsx の `.tsx` なので、`tsconfig.json` の `compilerOptions` に `"jsx": "react-jsx"` と `"jsxImportSource": "hono/jsx"` を設定します（[CLI Guide](../guides/cli/#screens-honojsx) を参照）。

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

`signingKeyProvider` は `{ getSigningKeys(): Promise<SigningKey[]> }` を実装するオブジェクトで、秘密鍵・公開 JWK・kid の組を配列で返します。配列の先頭の鍵が新しいトークンの署名に使われ、すべての鍵が JWKS で公開されます。鍵セットには RS256 の鍵を最低 1 本含めてください。実装例はリポジトリの `samples/hono-cloudflare/src/app.ts` を参照してください。

生成直後の OP には、クライアントもユーザーも登録されていません。`db/` の `registerClient()` でクライアントを、`development.ts` の `registerDevelopmentUsers()` で開発用ユーザー（testuser / otheruser、パスワードはどちらも `password`）を登録します。`--db` 無しの `db/` はメモリに置くので、起動のたびに登録します。

```typescript
import { createDatabase, registerClient } from './oidc-provider/db/index.js';
import { registerDevelopmentUsers } from './oidc-provider/development.js';

await registerClient(createDatabase(), {
  clientId: 'my-client',
  clientSecret: 'my-client-secret',
  redirectUris: ['http://localhost:4000/callback'],
});
await registerDevelopmentUsers(createDatabase());
```

`config.ts` のデフォルト値（issuer 等）はローカル検証専用です。実運用相当の検証では環境変数 / DB / KV から供給してください。

### Next.js の場合

Next.js は `app` ディレクトリへ直接生成します。生成物は App Router の Route Handler・ページ・Server Action そのものなので、組み込みの作業はありません。

```bash
pnpm dlx @maronn-openid-connect/cli generate nextjs --output ./src/app
pnpm add @maronn-openid-connect/core
OIDC_ISSUER=http://localhost:3000 pnpm next dev
```

issuer・クライアント・署名鍵・ストアは `src/app/_oidc-provider/provider.ts` が組み立て、issuer は環境変数 `OIDC_ISSUER` から読みます。クライアントとユーザーは環境変数からは読まないので、起動時に 1 回だけ動く `src/instrumentation.ts` の `register()` で登録します（詳細は [CLI Guide](../guides/cli/#nextjs) を参照）。

```typescript
// src/instrumentation.ts
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { createDatabase, registerClient } = await import('./app/_oidc-provider/db');
  const { registerDevelopmentUsers } = await import('./app/_oidc-provider/development');
  await registerClient(createDatabase(), {
    clientId: 'my-client',
    clientSecret: 'my-client-secret',
    redirectUris: ['http://localhost:4000/callback'],
  });
  await registerDevelopmentUsers(createDatabase());
}
```

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

## Next Steps

- [CLI Guide](../guides/cli/) — コマンド・機能トグルの詳細
- [Using core](../guides/core/) — core パッケージを直接使う
- [Features](../reference/features/) — 実装済み機能の一覧
- [Authorization Code Flow](../concepts/authorization-code-flow/) — フローの全体像を理解する
