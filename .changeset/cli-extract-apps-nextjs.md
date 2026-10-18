---
'@maronn-openid-connect/cli': minor
---

Next.js の生成コードを、文字列のテンプレートから組み立てるのをやめ、動くアプリ `apps/nextjs` から抽出するようにする

Next.js の生成コードのファイル構成と、`--db` 無しのときのデータの置き場所が変わるので、0.x の semver に従って minor で上げる。CLI のコマンドとオプションの名前と意味は変えていない。テンプレートの生成器（`src/frameworks/`）と旧来の図の定義（`src/flow/catalog.ts`）はこれで無くなり、すべてのフレームワークが `apps/` から抽出される。

- 生成コードは `apps/nextjs/src/app` を抽出したもので、App Router の作法のまま書いてある。機能のルートはその機能の route group `(<feature-id>)/` の下に、ルートを持たない機能のロジックは `_oidc-provider/features/<feature-id>/` に置かれ、`_oidc-provider/features.ts` が有効な機能を並べる
- `authorize`、`token`、`introspect` などの `route.ts` はステップに `// [step-id] ラベル — 仕様` の印を持ち、機能は `(feature: <feature-id>)` のブロックで入る。隣の `endpoint.ts` がステップと各ステップの読み書きする値を並べ、無効にした機能のブロックを消したときに後続が読む値を `const <name> = undefined;` で残すのに使う。`--flow` でステップを並べ替えた文書は、今まで通り Next.js では受け付けない
- DB は hono と同じ `_oidc-provider/db/` の構成になり、`db/index.ts` がどの種類でも同じ名前を export する。`--db kv` の `instance.ts` は、`UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN` があれば Upstash Redis に、無ければ node:sqlite（`OIDC_SQLITE_PATH`、既定は `.data/oidc.sqlite`）に置く実装として生成され、そのまま動く
- 機能の設定は `shared()` で Next.js のモジュールの層（Route Handler、Server Action、instrumentation.ts）をまたいで 1 つになり、`instrumentation.ts` で設定した値がリクエストに届く
- test:matrix が Next.js の組合せも型検査する

## 破壊的変更

- **Next.js の生成コードのファイル構成**：機能のルートが route group の下に移った（例：`login/google/route.ts` は `(google-login)/login/google/route.ts`）。`token/` の横にあった機能のモジュール（`token-exchange.ts`、`id-jag.ts`、`device-code.ts`、`ciba.ts`）と `_oidc-provider/jarm.ts` は `_oidc-provider/features/<feature-id>/` に移った。`_oidc-provider/store.ts` のストアの実装は `_oidc-provider/db/` と各機能のディレクトリに移った
- **`--db` 無しの Next.js**：データの置き場所が、node:sqlite か Upstash Redis の JSON ストア（`_oidc-provider/storage-backend.ts`）から、プロセスのメモリ（`_oidc-provider/db/memory`）に変わった。Vercel では `--db kv` で生成する。Google でログインしたユーザーの subject も、`google:<Google の sub>` から、初めてのログインで作るランダムな ID に変わった
- **`--db sql` のテーブル**：`_oidc-provider/db/schema.sql` は、hono と同じく `--enable google-login` を付けなくても Sign in with Google のテーブル（`federated_identities`、`upstream_auth_requests`）を作り、パスワードでのログインも `federated_identities` を読む。google-login 無しで以前に作った DB には、再生成した `schema.sql` を適用してから新しい生成コードを動かす
- **クライアントの登録**：`--db` 無しの Next.js の生成コードは、`OIDC_CLIENTS_JSON`、`OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_CLIENT_REDIRECT_URI`（別名の `CLIENT_ID` / `CLIENT_SECRET` / `CLIENT_REDIRECT_URI`）、`OIDC_RESOURCE_SERVER_CLIENT_ID` / `OIDC_RESOURCE_SERVER_CLIENT_SECRET` / `OIDC_RESOURCE_SERVER_REDIRECT_URI`（別名の `RESOURCE_SERVER_*`）を読まなくなった。環境変数が無いときに登録していた `example-client` は無くなり、ログインで受け付けていた testuser / otheruser も自動では登録されなくなった（`development.ts` の `registerDevelopmentUsers()` で登録できる）。クライアントとユーザーは `_oidc-provider/db` の `registerClient()` と `registerUser()` で登録する。起動時に 1 回だけ動く `instrumentation.ts` の `register()` から呼ぶとよい
