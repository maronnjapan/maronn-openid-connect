---
'@maronn-openid-connect/cli': minor
---

hono、express、fastify の生成コードを、文字列のテンプレートから組み立てるのをやめ、動くアプリ `apps/hono` から抽出するようにする

生成コードのファイル構成と、生成コードが export する名前が変わるので、0.x の semver に従って minor で上げる。CLI のコマンドとオプション（`generate`、`setup`、`graph`、`--enable`、`--disable`、`--scope`、`--db`、`--flow`、`--output`、`--force`、`--dry-run`）の名前と意味は変えていない。

- 生成コードは `apps/hono/src/oidc-provider`（express と fastify は `apps/hono/src/web` の `apply.ts`、`web-router.ts`、`node-adapter.ts` も）を `packages/cli/extract.json` に従って抽出したもので、npm のパッケージは build 時に集めた写し（`templates/`）を同梱する。生成コードを直すときは `apps/hono` の実コードと隣のテストを直す
- エンドポイントは `endpoints/<endpoint>/pipeline.ts` がステップを `// [step-id] ラベル — 仕様` の印付きで呼ぶ構成になり、ステップは `endpoints/<endpoint>/steps/<step>.ts` に 1 つずつ置かれる。`routes/*.ts` と、画面ごとの `pages/*.ts`（`pages/errors.tsx` と `pages/respond.ts` を除く）は無くなった
- 機能は `features/<feature-id>/` のディレクトリになり、`features/enabled.ts` が有効な機能を並べる。機能は `features/feature.ts` のフック（routes、discovery、context、config、token の grants、authorize の responseModes、loginMethods）か、パイプラインの `(feature: <feature-id>)` のブロックで base に入る。無効にした機能はディレクトリごと出力されず、そのブロックと import も消える
- DB は `--db` の有無にかかわらず `db/` に置かれ、`db/index.ts` がどの種類でも `createDatabase`、`createProviderStores`、`createClientResolver`、`createClientKeyResolver`、`registerClient`、`registerUser` を export する。`--db` 無しはプロセスのメモリ（`db/memory`）に置く。`db/instance.ts` は今まで通り利用者のファイルで上書きされず、`createDatabase()` はリクエストの文脈を受け取っても受け取らなくてもよい
- `maronn-oidc graph` と `--flow` は、アプリのステップとエンドポイントが自分を記述する `meta`（build 時に `catalog.json` へ焼く）から図と検証を作る。箱と矢印は前と同じで、token の図は refresh_token の検証を authorization_code の検証より前に描く。`--flow` の並べ替えはパイプラインのブロックの並べ替えになる
- express と fastify の画面も hono/jsx で描くので、`hono` のインストールと `tsconfig.json` の JSX 設定（`"jsx": "react-jsx"`, `"jsxImportSource": "hono/jsx"`）が要る。インストールの案内にも `hono` が加わった
- `config.ts` の `RegisteredClient` は、機能が自分のディレクトリから項目を足す interface になった（`ProviderConfig` と同じ）。ciba は `features/ciba/config.ts` で `backchannelTokenDeliveryMode` を足す
- `features/id-jag` だけを有効にした出力で、ID-JAG 以外の `requested_token_type` の Token Exchange に、ID-JAG だけを受け付けると述べる `invalid_request` を返す（以前の生成コードと同じ）

## 破壊的変更

- **生成コードのファイル構成**：`routes/`、画面ごとの `pages/`（`pages/errors.tsx` と `pages/respond.ts` を除く）、`store.ts` のインメモリストアと機能のストア、`config.ts` のクライアント一覧（`defaultRegisteredClients`、`createInMemoryClientResolver()`、`createInMemoryClientKeyResolver()`）は無くなった。機能の設定は `features/<feature-id>/config.ts`（例：`idJagConfig` は `features/id-jag/config.ts`、`rpInitiatedLogoutConfig` は `features/rp-initiated-logout/config.ts`）に移った
- **db の名前**：`createSqlProviderStores()` / `createKvProviderStores()` などの種類ごとの名前は、`db/index.ts` の共通の名前に置き換わった
- **開発用ユーザー**：`UserStore` が持っていた開発用ユーザー（testuser / otheruser）は `development.ts` の `developmentUsers` と `registerDevelopmentUsers()` に移り、メモリの DB にも自動では入らない
- **express / fastify**：`hono` が必要になった。fastify の `applyOidc()` は、OP のルートを専用のプラグインに登録して生のボディを OP へ渡すようになり、インスタンスへ form のパーサーを足さなくなった
