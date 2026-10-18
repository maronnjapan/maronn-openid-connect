---
'@maronn-openid-connect/cli': minor
---

Next.js の生成コードを、文字列のテンプレートから組み立てるのをやめ、動くアプリ `apps/nextjs` から抽出するようにする

Next.js の生成コードのファイル構成と、`--db` 無しのときのデータの置き場所が変わるので、0.x の semver に従って minor で上げる。CLI のコマンドとオプションの名前と意味は変えていない。テンプレートの生成器（`src/frameworks/`）と旧来の図の定義（`src/flow/catalog.ts`）はこれで無くなり、すべてのフレームワークが `apps/` から抽出される。

- 生成コードは `apps/nextjs/src/app` を抽出したもので、App Router の作法のまま書いてある。機能のルートはその機能の route group `(<feature-id>)/` の下に、ルート以外の機能のコード（設定、ストア、base のルートから呼ぶ処理）は `_oidc-provider/features/<feature-id>/` に置かれ、`_oidc-provider/features.ts` が有効な機能を並べる
- `authorize`、`token`、`introspect`、`.well-known/openid-configuration` の `route.ts` はステップに `// [step-id] ラベル — 仕様` の印を持ち、機能は `(feature: <feature-id>)` のブロックで入る。隣の `endpoint.ts` はステップと各ステップの読み書きする値の一覧で、CLI は無効にした機能のブロックを消すとき、残ったコードが読む値をこの一覧に従って `const <name> = undefined;` で残す。`--flow` でステップを消したり並べ替えたりした文書は、今まで通り Next.js では受け付けない
- DB は hono と同じ `_oidc-provider/db/` の構成になり、`db/index.ts` がどの種類でも同じ名前を export する。`--db kv` の `instance.ts` は、`UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN` があれば Upstash Redis に、無ければ node:sqlite（`OIDC_SQLITE_PATH`、既定は `.data/oidc.sqlite`）に置く実装として生成され、そのまま動く
- 機能の設定は `shared()` で Next.js のモジュールの層（Route Handler、Server Action、instrumentation.ts）をまたいで 1 つになり、`instrumentation.ts` で設定した値がリクエストに届く

## 破壊的変更

- **Next.js の生成コードのファイル構成**：機能のルートが route group の下に移った（例：`login/google/route.ts` は `(google-login)/login/google/route.ts`）。`token/` の横にあった機能のモジュール（`token-exchange.ts`、`id-jag.ts`、`device-code.ts`、`ciba.ts`）、`_oidc-provider/jarm.ts`、ルートの横にあった機能の設定（`par/config.ts`、`register/config.ts`、`device_authorization/config.ts`、`backchannel_authentication/config.ts`、`logout/config.ts`）は `_oidc-provider/features/<feature-id>/` に移り、設定は `shared()` の値になった。`_oidc-provider/store.ts` のストアの実装は `_oidc-provider/db/` と各機能のディレクトリに移った
- **`--db` 無しの Next.js**：データの置き場所が、node:sqlite か Upstash Redis の JSON ストア（`_oidc-provider/storage-backend.ts`）から、プロセスのメモリ（`_oidc-provider/db/database.ts` が globalThis に置く Map）に変わった。Vercel では `--db kv` で生成する。Google でログインしたユーザーの subject も、`google:<Google の sub>` から、初めてのログインで作るランダムな ID に変わった
- **`--db sql` のテーブル**：`_oidc-provider/db/schema.sql` は、hono と同じく `--enable google-login` を付けなくても Sign in with Google のテーブル（`federated_identities`、`upstream_auth_requests`）を作り、`client_jwks` も作る。パスワードでのログインも `federated_identities` を、Request Object を含む認可リクエストは `client_jwks` を読むので、以前の CLI で作った DB には、google-login の有無にかかわらず、再生成した `schema.sql` を適用してから新しい生成コードを動かす
- **クライアントの登録**：`--db` 無しの Next.js の生成コードは、`OIDC_CLIENTS_JSON`、`OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_CLIENT_REDIRECT_URI`（別名の `CLIENT_ID` / `CLIENT_SECRET` / `CLIENT_REDIRECT_URI`）、`OIDC_RESOURCE_SERVER_CLIENT_ID` / `OIDC_RESOURCE_SERVER_CLIENT_SECRET` / `OIDC_RESOURCE_SERVER_REDIRECT_URI`（別名の `RESOURCE_SERVER_*`）を読まなくなった。環境変数が無いときに登録していた `example-client` は無くなり、ログインで受け付けていた testuser / otheruser も自動では登録されなくなった（`development.ts` の `registerDevelopmentUsers()` で登録できる）。クライアントとユーザーは `_oidc-provider/db` の `registerClient()` と `registerUser()` で登録する。起動時に 1 回だけ動く `instrumentation.ts` の `register()` から呼ぶとよい
- **以前の出力への上書き**：以前の CLI の出力先に `--force` で生成し直しても、route group の外にあった機能のルートとその横のファイル（`introspect/route.ts`、`revoke/route.ts`、`login/google/route.ts`、`par/route.ts`、`par/config.ts` など）、`token/` の横の機能のモジュール（`token/token-exchange.ts` など）、`_oidc-provider/jarm.ts`、`_oidc-provider/storage-backend.ts` は消えずに残る。既定の機能だけの出力でも `introspect/route.ts` と `revoke/route.ts` が残る。残った `route.ts` は route group の下の新しい `route.ts` と同じパスになり、Turbopack の `next build` は `Conflicting routes` のエラーで止まる（`--webpack` ではエラーにならず、残った古い `route.ts` が応答する）。以前の CLI が書いたファイルを、`_oidc-provider/db/instance.ts` を残して消してから生成し直す
