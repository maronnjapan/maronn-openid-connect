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

- **生成コードのファイル構成**：`routes/`、画面ごとの `pages/`（`pages/errors.tsx` と `pages/respond.ts` を除く）、`store.ts` のインメモリストアと機能のストア、`config.ts` のクライアント一覧（`defaultRegisteredClients`、`createInMemoryClientResolver()`）は無くなった。機能の設定は `features/<feature-id>/config.ts`（例：`idJagConfig` は `features/id-jag/config.ts`、`rpInitiatedLogoutConfig` は `features/rp-initiated-logout/config.ts`）に移った
- **db の名前**：`createSqlProviderStores()` / `createKvProviderStores()` などの種類ごとの名前は、`db/index.ts` の共通の名前に置き換わった
- **開発用ユーザー**：`UserStore` が持っていた開発用ユーザー（testuser / otheruser）は `development.ts` の `developmentUsers` と `registerDevelopmentUsers()` に移り、メモリの DB にも自動では入らない
- **既定のクライアント**：`--db` 無しの生成コードが最初から受け付けていたクライアント `example-client`（`config.ts` の `defaultRegisteredClients`）は無くなり、生成した直後の OP にはクライアントが 1 つも登録されていない。OP がリクエストを受ける前に、`db/index.ts` の `registerClient()` でクライアントを登録する（`clientResolver` を渡す場合は要らない）
- **Google でログインしたユーザーの subject**：`--db` 無しの生成コードが JIT 登録するユーザーの subject は、`google:<Google の sub>` から、初めてのログインで作るランダムな ID に変わった（`--db sql` / `--db kv` と同じ）。Google の sub はメモリの DB に Federated_identity として記録し、同じ人かの判断に使う。メモリの DB はプロセスの再起動で消えるので、再起動の後は同じ Google アカウントにも新しい subject が付く
- **`--db sql` のテーブル**：`schema.sql` は、`--enable google-login` を付けなくても Sign in with Google のテーブル（`federated_identities`、`upstream_auth_requests`）を作る。パスワードでのログインも `auth_users.auth_type` を決めるために `federated_identities` を読むので、google-login 無しで以前に作った DB には、再生成した `schema.sql` を適用してから新しい生成コードを動かす（`CREATE TABLE IF NOT EXISTS` なので、既存のテーブルとデータはそのまま残る）。`--db kv` の `keys.ts` にも同じ記録のキーが載るが、OP がそれを書くのは google-login を有効にしたときだけである
- **express / fastify**：`hono` が必要になった。fastify の `applyOidc()` は、OP のルートを専用のプラグインに登録して生のボディを OP へ渡すようになり、インスタンスへ form のパーサーを足さなくなった
- **express / fastify の `createDatabase()`**：`--db` 付きの生成コードは、`db/instance.ts` の `createDatabase()` を `applyOidc()` で 1 回だけ呼ぶのをやめ、Hono と同じく OP のパスへのリクエストごとに呼ぶ（`storage`、`clientResolver`、`clientKeyResolver` を渡さなければ 1 リクエストで 3 回）。未実装の `createDatabase()` は起動を止めず、OP のパスへのリクエストがすべて 500 になる。`instance.ts` は再生成しても上書きされないので、`createDatabase()` の中で接続を開いている実装（以前の `instance.ts` にあった node:sqlite の例もそう書いていた）は、接続をモジュールの変数に移してから再生成する
