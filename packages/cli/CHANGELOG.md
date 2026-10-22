# @maronn-openid-connect/cli

## 0.15.0

### Minor Changes

- 9b8d022: Hybrid Flow（OIDC Core 1.0 §3.3）の `response_type=code id_token`、`code token`、`code id_token token` に答える安定機能 `hybrid-flow` を追加する
  
  既定で生成され、`--disable hybrid-flow` で外せる。`implicit-flow` のフラグメント応答とトークン発行を使うので、`implicit-flow` を必要とする。
  
  - 使えるのは、登録の `responseTypes` にこれらの値を持つクライアントだけである。ほかのクライアントには `unauthorized_client` を返す
  - 認可エンドポイントは、認可コードと一緒に ID Token（`code id_token`）、Access Token（`code token`）、または両方（`code id_token token`）を、リダイレクト URI のフラグメントで返す（OAuth 2.0 Multiple Response Type Encoding Practices §5）。`prompt=none` と同意済みの SSO の要求には認可エンドポイントが、同意画面を経た要求には同意の判断が返す。`response_mode=form_post` を指定した要求には、フォームの POST で返す
  - 認可コードは Authorization Code Flow と同じくトークンエンドポイントで交換する。PKCE は検証し、`offline_access` の扱いも Authorization Code Flow と同じである。認可コードと認可エンドポイントが返した Access Token は一つの grant に属するので、認可コードの再利用や同意の取り消しは両方を失効させる
  - 認可エンドポイントが返す ID Token は `nonce`、`auth_time`、認可コードのハッシュ `c_hash` を含み、Access Token も返すときは `at_hash` も含む（OIDC Core 1.0 §3.3.2.11）。`nonce` は `code id_token` と `code id_token token` で必須で、`code token` では任意である。scope の標準クレームは UserInfo エンドポイントが返し（§5.4）、`claims` パラメータの `id_token` で要求されたクレームは認可エンドポイントの ID Token にも入る（§5.5）
  - `response_mode=query` と JARM の `.jwt` 系は `invalid_request` になる。エラーもフラグメントで返す
  - discovery の `response_types_supported` に `code id_token`、`code token`、`code id_token token` が、`claims_supported` に `c_hash` が加わる
  
  E2E テスト（`tests/e2e/specs/hybrid-flow.spec.ts`）と、OpenID Foundation Conformance Suite の Hybrid OP プラン（`pnpm run conformance:hybrid-op`）の実行環境を追加する。
  
  ## 破壊的変更
  
  - **既定の挙動と discovery**：`hybrid-flow` は既定で生成されるので、discovery の `response_types_supported` と `claims_supported` が変わる。これまでどおり `code` と Implicit Flow だけに答える OP にするには、`--disable hybrid-flow` で生成する
  - **`--disable implicit-flow`**：`hybrid-flow` は `implicit-flow` を必要とするので、`--disable implicit-flow` だけを指定するとエラーになる。`--disable implicit-flow,hybrid-flow` のように両方を外す

### Patch Changes

- 83da456: `--enable dynamic-client-registration` が生成する登録エンドポイントを堅牢化する
  
  - 発行した `client_secret` をストアにはハッシュ（core の `hashClientSecret`）で保存する。201 応答は従来どおり平文を一度だけ返し、トークンエンドポイントの認証は静的クライアントと同じハッシュ照合（timing-safe）になる
  - 総数上限（`maxRegisteredClients`）を保存後に再検査し、並行リクエストが同時に検査を通過しても上限を超えない。ストア契約に `delete(clientId)` が加わるため、永続実装へ差し替えている場合は実装を足す
  - 上限超過を宣言する `Content-Length` はボディを読む前に 400 で拒否する（本検査は従来どおりボディの UTF-8 バイト数）
  - Next.js の生成ルートで、転送中断時にも固定の `server_error` JSON と `Cache-Control: no-store` が返るよう、ボディ読み取りを try の中へ移す
  - `redirect_uris` の固定エラー文言を実際の検査規則（カスタムスキームは通る）に合わせ、`client_name` では C1 制御文字、bidi 制御文字、ゼロ幅文字も拒否する

## 0.14.0

### Minor Changes

- da0de14: 生成する OP で、クライアントの公開鍵を用途ごとに置き、1 つのクライアントに複数のクライアント認証方式を登録できるようにする
  
  - クライアントの公開鍵は、鍵を使う処理が用途ごとに `ClientKeyResolver`（core）から引く。生成 OP は、署名付き Request Object の検証に `request_object` の用途の鍵を読む。用途は文字列なので、private_key_jwt（`private_key_jwt`）や DPoP（`dpop`）などの用途の鍵も、スキーマを変えずに登録できる。生成 OP は private_key_jwt によるクライアント認証も DPoP も実装しておらず、`request_object` 以外の用途の鍵を読む処理を持たない
  - `--db sql` に、クライアントの公開鍵を 1 行に用途（`purpose`）1 つと JWK 1 つで持つ `client_jwks` を加えた。`purpose` には CHECK を付けていない。`--db kv` には、用途ごとの鍵を JWK Set で持つ `client_jwks:<client_id>:<purpose>` のキーを加えた
  - `config.ts` に、`RegisteredClient` と用途ごとの公開鍵（`keys`）を持つ `ClientRegistration` を加えた。`db/` の `registerClient()` は `ClientRegistration` を受け取る。クライアントの resolver は鍵を含まないクライアントを返し、鍵は `ClientKeyResolver` だけが返す
  - `createApp` / `applyOidc` に `clientKeyResolver` オプションを加えた。既定は、`--db` の有無にかかわらず `db/index.ts` の `createClientKeyResolver()` である。Next.js は `_oidc-provider/provider.ts` の `clientKeyResolver` を書き換える
  - 鍵はリクエストのたびに DB から読むので、DB に足した公開鍵も消した公開鍵も、OP を再起動せずに次のリクエストから効く。OP は鍵を発行せず、公開鍵を登録するエンドポイントも持たないので、運用者が `registerClient()` か DB への書き込みで登録する
  - `--db sql` と `--db kv` の `registerClient()` は、渡したクライアントの `keys` の鍵をそれぞれの用途で DB に足すが、DB にある鍵を消さない。起動のたびに登録し直しても、運用中に DB へ足した鍵は残る。`--db` 無しの `registerClient()` は、同じ `client_id` の登録を鍵ごと置き換える
  - 1 つのクライアントに、client_secret_basic と client_secret_post の両方を登録できる（core の `tokenEndpointAuthMethods`）。`--db sql` は `client_auths` に方式ごとの行を、`--db kv` はクライアントのレコードの `client_auths` に方式ごとの要素を持ち、どれも同じシークレットのハッシュを持つ。シークレットの異なる行（要素）を持つクライアントは、設定の誤りとして例外にする
  - これまで `--db` 付きの生成物は署名付き Request Object を検証できずに拒否していたが、`request_object` の用途の鍵を登録したクライアントの Request Object は検証して受け付ける
  
  ## 破壊的変更
  
  - **CLI 生成コード: クライアントの `tokenEndpointAuthMethod` を、一覧の `tokenEndpointAuthMethods` に置き換えた**（core の `TokenClientInfo` の変更による）。`registerClient()` に渡すクライアントは、`tokenEndpointAuthMethods: ['client_secret_post']` のように書く
  - **CLI 生成コード: クライアントの `jwks` を、用途ごとの `keys`（`ClientRegistration.keys`）に置き換えた**。署名付き Request Object を検証する鍵は、`registerClient()` に渡すクライアントの `keys.request_object` に書く。`clientResolver` を渡し、鍵をクライアントの `jwks` で返していた場合は、その鍵を返す `clientKeyResolver` も渡す（クライアントの `jwks` は読まれない）
  - **`--db kv`: クライアントのレコードの `client_auth` を、認証方式の一覧 `client_auths` に置き換えた**。以前の CLI で書いたクライアントのレコードは、`registerClient()` で書き直す
- c466e1e: hono、express、fastify の生成コードを、文字列のテンプレートから組み立てるのをやめ、動くアプリ `apps/hono` から抽出するようにする
  
  生成コードのファイル構成と、生成コードが export する名前が変わるので、0.x の semver に従って minor で上げる。CLI のコマンドとオプション（`generate`、`setup`、`graph`、`--enable`、`--disable`、`--scope`、`--db`、`--flow`、`--output`、`--force`、`--dry-run`）の名前と意味は変えていない。
  
  - 生成コードは `apps/hono/src/oidc-provider`（express と fastify は `apps/hono/src/web` の `apply.ts`、`web-router.ts`、`node-adapter.ts` も）を `packages/cli/extract.json` に従って抽出したもので、npm のパッケージは build 時に集めた写し（`templates/`）を同梱する。生成コードを直すときは `apps/hono` の実コードと隣のテストを直す
  - エンドポイントは `endpoints/<endpoint>/pipeline.ts`（機能のエンドポイントは `features/<feature-id>/endpoints/<endpoint>/pipeline.ts`）がステップを `// [step-id] ラベル — 仕様` の印付きで呼ぶ構成になり、ステップはエンドポイントの `steps/<step>.ts` に 1 つずつ置かれる（機能が base のエンドポイントに足すステップは `features/<feature-id>/steps/`）。device、ciba、logout の画面は `pipeline.ts` を持たず、`page.tsx` が `steps/` のステップを呼ぶ。`routes/*.ts` は無くなり、`pages/` に残るのは `pages/errors.tsx` と `pages/respond.ts` だけになった
  - 機能は `features/<feature-id>/` のディレクトリになり、`features/enabled.ts` が有効な機能を並べる。機能は `features/feature.ts` のフック（routes、discovery、context、config、token の grants、authorize の responseModes、loginMethods）か、パイプラインの `(feature: <feature-id>)` のブロックで base に入る。無効にした機能はディレクトリごと出力されず、そのブロックと import も消える
  - DB は `--db` の有無にかかわらず `db/` に置かれ、`db/index.ts` がどの種類でも `createDatabase`、`createProviderStores`、`createClientResolver`、`createClientKeyResolver`、`registerClient`、`registerUser` を export する。`--db` 無しはプロセスのメモリ（`db/database.ts` の Map）に置く。`db/instance.ts` は今まで通り利用者のファイルで上書きされず、`createDatabase()` はリクエストの文脈を受け取っても受け取らなくてもよい
  - `maronn-oidc graph` と `--flow` は、アプリのステップとエンドポイントが自分を記述する `meta`（build 時に `catalog.json` へ焼く）から図と検証を作る。箱と矢印は前と同じで、token の図は refresh_token の検証を authorization_code の検証より前に描く。`--flow` の並べ替えはパイプラインのブロックの並べ替えになる
  - express と fastify の画面も hono/jsx で描くので、`hono` のインストールと `tsconfig.json` の JSX 設定（`"jsx": "react-jsx"`, `"jsxImportSource": "hono/jsx"`）が要る。インストールの案内にも `hono` が加わった
  - `config.ts` の `RegisteredClient` は、機能が自分のディレクトリから項目を足す interface になった（`ProviderConfig` と同じ）。ciba は `features/ciba/config.ts` で `backchannelTokenDeliveryMode` を足す
  - `--enable id-jag` を付け、token-exchange を有効にしていない出力は、以前の生成コードと同じく、ID-JAG 以外の `requested_token_type` の Token Exchange に、ID-JAG だけを受け付けると述べる `invalid_request` を返す
  
  ## 破壊的変更
  
  - **生成コードのファイル構成**：`routes/` と、`pages/` の `errors` と `respond` 以外のファイル（hono の `pages/authorize.ts`、`pages/login.tsx`、`pages/consent.tsx` など）は無くなった。express と fastify の `views.ts` と `pages/errors.ts` は、hono/jsx の `views.tsx` と `pages/errors.tsx` になった。機能の設定は `features/<feature-id>/config.ts`（例：`idJagConfig` は `features/id-jag/config.ts`、`rpInitiatedLogoutConfig` は `features/rp-initiated-logout/config.ts`）に移った
  - **無くなった export**：`store.ts` のインメモリストアと機能のストア、自前の保存先から `ProviderStores` を作る `JsonStoreBackend` と `createJsonProviderStores()`、`resolvers.ts` の既定の resolver（`clientResolver`、`accessTokenResolver` など）と `revokeConsentAndTokens()`、`config.ts` の `defaultProviderConfig` とクライアント一覧（`defaultRegisteredClients`、`createInMemoryClientResolver()`）は無くなった。`resolvers.ts` には `createStoreResolvers()` が残る。`store.ts` にあった Cookie の関数（`buildSessionCookie()`、`isSameOriginFormPost()` など）は `cookies.ts` に移った
  - **hono の export 名**：`app.ts` の `CreateAppOptions` は、express と fastify と同じ `OidcProviderOptions` に改名された。`apply.ts` は `CorsOrigins` と `validateSigningKeySet()` を export しなくなったので、`app.ts` から import する
  - **`storage` に渡す `ProviderStores`**：`store.ts` の `ProviderStores` に `upstreamLoginStore`（`UpstreamLoginStorage`）が、`UserStorage` に `linkFederatedIdentity()` が加わり、google-login を有効にしなくても必須になった。google-login のときに要った `googleLoginNonceStore` と `linkGoogleAccount()` は、この 2 つに置き換わった。`createApp()` / `applyOidc()` の `storage` に自前のストアを渡している場合（Next.js では `_oidc-provider/provider.ts` の `stores` を書き換えている場合）は、この 2 つを実装する
  - **db の名前**：`createSqlProviderStores()` / `createKvProviderStores()` などの種類ごとの名前は、`db/index.ts` の共通の名前に置き換わった
  - **開発用ユーザー**：`UserStore` が持っていた開発用ユーザー（testuser / otheruser）は `development.ts` の `developmentUsers` と `registerDevelopmentUsers()` に移り、メモリの DB にも自動では入らない
  - **既定のクライアント**：`--db` 無しの生成コードが最初から受け付けていたクライアント `example-client`（`config.ts` の `defaultRegisteredClients`）は無くなり、生成した直後の OP にはクライアントが 1 つも登録されていない。OP がリクエストを受ける前に、`db/index.ts` の `registerClient()` でクライアントを登録する（`clientResolver` を渡す場合は要らない）
  - **Google でログインしたユーザーの subject**：`--db` 無しの生成コードが JIT 登録するユーザーの subject は、`google:<Google の sub>` から、初めてのログインで作るランダムな ID に変わった（`--db sql` / `--db kv` と同じ）。Google の sub はメモリの DB に Federated_identity として記録し、同じ人かの判断に使う。メモリの DB はプロセスの再起動で消えるので、再起動の後は同じ Google アカウントにも新しい subject が付く
  - **`--db sql` のテーブル**：`schema.sql` は、`--enable google-login` を付けなくても Sign in with Google のテーブル（`federated_identities`、`upstream_auth_requests`）を作り、クライアントの公開鍵の `client_jwks` も作る。パスワードでのログインも `auth_users.auth_type` を決めるために `federated_identities` を読み、Request Object を含む認可リクエストは `client_jwks` を読むので、以前の CLI で作った DB には、google-login の有無にかかわらず、再生成した `schema.sql` を適用してから新しい生成コードを動かす（`CREATE TABLE IF NOT EXISTS` なので、既存のテーブルとデータはそのまま残る）。`--db kv` の `keys.ts` にも Sign in with Google の記録のキーが載るが、OP がそれを書くのは google-login を有効にしたときだけである
  - **express / fastify**：`hono` が必要になった。fastify の `applyOidc()` は、OP のルートを専用のプラグインに登録して生のボディを OP へ渡すようになり、インスタンスへ form のパーサーを足さなくなった
  - **express / fastify の `createDatabase()`**：`--db` 付きの生成コードは、`db/instance.ts` の `createDatabase()` を `applyOidc()` で 1 回だけ呼ぶのをやめ、Hono と同じく OP のパスへのリクエストごとに呼ぶ（`storage`、`clientResolver`、`clientKeyResolver` を渡さなければ 1 リクエストで 3 回）。未実装の `createDatabase()` は起動を止めず、OP のパスへのリクエストがすべて 500 になる。`instance.ts` は再生成しても上書きされないので、`createDatabase()` の中で接続を開いている実装（以前の `instance.ts` にあった node:sqlite の例もそう書いていた）は、接続をモジュールの変数に移してから再生成する
  - **以前の CLI のフロー文書**：token のステップの順番が変わったので、以前の CLI の `graph --format json` が書いたフロー文書は、refresh-token を有効にしたままだと、`--flow` で `step "validate-authorization-code-grant" reads "refreshTokenRequest", which no earlier step produces` のエラーになる。新しい CLI の `graph --format json` で書き出し直すか、token の `validate-refresh-token-grant` を `validate-authorization-code-grant` の前に移す
  - **以前の出力への上書き**：以前の CLI の出力先に `--force` で生成し直しても、無くなったファイル（`routes/`、`pages/` の `errors` と `respond` 以外のファイル、express と fastify の `views.ts` と `pages/errors.ts`）は消えずに残る。残ったファイルは無くなった名前（`resolvers.ts` の `tokenClientResolver` など）を import するので、型検査が通らない。express と fastify では、新しいコードの `views.js` と `pages/errors.js` の import も、新しい `.tsx` ではなく残った `.ts` に解決される。以前の CLI が書いたファイルを、`db/instance.ts` を残して消してから生成し直す
- c466e1e: Next.js の生成コードを、文字列のテンプレートから組み立てるのをやめ、動くアプリ `apps/nextjs` から抽出するようにする
  
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
- f078f6c: `response_mode=form_post`（OAuth 2.0 Form Post Response Mode）に対応する安定機能 `form-post-response-mode` を追加する
  
  既定で生成され、`--disable form-post-response-mode` で外せる。
  
  - `response_mode=form_post` の認可リクエストには、認可エンドポイントと同意画面が、リダイレクト URI を `action` とする HTML フォームで認可レスポンスを返し、ブラウザがそれを POST する（Form Post Response Mode §2）。認可コードの応答も、リダイレクト可能なエラー（`access_denied`、`login_required` など）も同じ形で返し、`iss`（RFC 9207 §2）もフィールドに含める。応答には `Cache-Control: no-cache, no-store` と `Pragma: no-cache` を付ける
  - `response_mode` は Request Object の中にあっても読む。`form_post` 以外の値は今まで通り無視し、クエリで返す（JARM の `query.jwt` / `jwt` は JARM が受け持つ）
  - discovery の `response_modes_supported` は `["query", "form_post"]` になる（JARM を有効にすると `["query", "form_post", "query.jwt", "jwt"]`）
  - フォームの画面は hono / express / fastify では `views.tsx` の `formPostPage`（`views` オプションで差し替えられる）、Next.js では `_oidc-provider/html.ts` の `formPostPage()` が描く
  
  ## 破壊的変更
  
  - **既定の挙動**：`response_mode=form_post` を送るクライアントへの応答が、クエリ付きのリダイレクトから、フォームの POST に変わる。以前の挙動のままにするには `--disable form-post-response-mode` で生成する
  - **認可レスポンスの型**：`endpoints/authorize/response-mode.ts`（Next.js は `authorize/response-mode.ts`）の `AuthorizationResponseMode` は、リダイレクト URL を返す `redirect()` の代わりに、リダイレクトかフォームの POST かを表す `AuthorizationResponse` を返す `respond()` を持つ。認可エンドポイントの結果（`AuthorizationOutcome`）と同意の結果（`ConsentOutcome`）の `authorization_response` は、`location` の代わりに `response` を持つ。`outcome.ts` の `buildErrorRedirect()` / `buildSuccessRedirect()` は `buildErrorResponse()` / `buildSuccessResponse()` になり、Next.js の `authorizationResponseUrl()` は `authorizationResponseOf()` になった。自前の応答モードを書いている場合は、`respond()` から `{ method: 'redirect', location }` を返すように直す
  - **`Views`**：`views.tsx` の `Views` に `formPostPage` が加わった。`views` オプションは既定の画面と合わせて使うので、渡しているオブジェクトはそのままでよい
  - **Next.js の同意の判断**：`consent/actions.ts`（Server Action）は無くなり、同意画面のフォームは Route Handler の `consent/decision/route.ts`（`POST /consent/decision`）へ送る。`form_post` の認可レスポンスは HTML のページで、Server Action はリダイレクトしか返せないためである。トランザクションが見つからない同意の POST は、`not-found.tsx` の 404 ではなく、`oidc-error` のページへの 303 で終わる。以前の出力に `--force` で生成し直しても `consent/actions.ts` は残るので、消してから生成し直す
  - **`--db sql` の `authentication_requests`**：OpenID Connect Core 1.0 の認可リクエストのパラメータが、それぞれ専用の列になった（`response_mode`、`prompt`、`max_age`、`ui_locales`、`claims_locales`、`id_token_hint`、`login_hint`、`acr_values`、`claims`）。これまでは `payload` 列の JSON に入っていた。`payload` に残るのは、`redirect_uri` を明示したかどうか、`audience`、機能が足す値だけである。`response_mode` 列には OP が答える応答モードの名前（`form_post`、JARM の `query.jwt`）が入り、クエリ応答のときは NULL になる。以前の CLI で作った DB は `CREATE TABLE IF NOT EXISTS` では列が増えないので、テーブルを作り直すか列を足してから新しい生成コードを動かす。`--db kv` のトランザクションの記録も、同じパラメータを `authentication_request` の同名のフィールドに持つ
- eb08dd6: Implicit Flow（OIDC Core 1.0 §3.2）の `response_type=id_token token` と `id_token` に答える安定機能 `implicit-flow` を追加する
  
  既定で生成され、`--disable implicit-flow` で外せる。
  
  - 使えるのは、登録の `responseTypes` に `id_token token` や `id_token` を持つクライアントだけである。登録の無いクライアントはこれまでどおり `code` だけを使え、ほかの値には `unauthorized_client` を返す
  - 認可エンドポイントは、認可コードの代わりに ID Token（`id_token token` では Access Token と `at_hash` も）を、リダイレクト URI のフラグメントで返す（OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5）。`prompt=none` と同意済みの SSO の要求には認可エンドポイントが、同意画面を経た要求には同意の判断が返す。`response_mode=form_post` を指定した要求には、フォームの POST で返す。トークンエンドポイントもリフレッシュトークンも使わない
  - `nonce` は必須で（OIDC Core 1.0 §3.2.2.1）、`response_mode=query` と JARM の `.jwt` 系は `invalid_request` になる。エラーもフラグメントで返す。redirect_uri は https か、public client のループバックの http に限る。PKCE は検証せず、`offline_access` は無視する（OIDC Core 1.0 §11）
  - `response_type=id_token` の ID Token には、許可された scope の標準クレームを入れる（OIDC Core 1.0 §5.4）
  - 発行した Access Token は、認可コードの交換で出たものと同じく保存し、UserInfo、Introspection、Revocation で使える。同意を取り消すと失効する
  - discovery の `response_types_supported` は `["code", "id_token", "id_token token"]` になり、`response_modes_supported` には `fragment` が、`grant_types_supported` には `implicit` が加わる
  
  ## 破壊的変更
  
  - **既定の挙動と discovery**：`implicit-flow` は既定で生成されるので、discovery の `response_types_supported`、`response_modes_supported`、`grant_types_supported` が変わる。`code` だけを広告する OP のままにするには、`--disable implicit-flow` で生成する
  - **`response_mode=fragment`**：`response_type=code` の要求の `response_mode=fragment` は、これまで無視してクエリで返していた。今後は認可コードをフラグメントで返す
  - **JARM**：`--enable jarm` の OP は、トークンを返す response type の要求の `.jwt` 系の `response_mode` を JARM で解釈しない（JARM §2.3.1 / §2.3.4）。Implicit Flow の要求では、フラグメントで `invalid_request` を返す
  - **`--db sql` と `--db kv` のクライアント**：`--db sql` にクライアントの response type を持つ `client_response_types` テーブルが加わり、`--db kv` のクライアントのレコードは `response_types` を持つ。これまで両者は登録の `responseTypes` を保存せず、どのクライアントも `code` だけを使えた。以前の CLI で作った SQL のデータベースには、`schema.sql` を実行し直せばテーブルが作られる
  - **トランザクションの状態**：Implicit Flow でトークンを返したトランザクションは、`authenticated` から `token_issued` に進む。`--db sql` の `access_tokens.transaction_id`（`--db kv` は `access_token:<hash>` の `transaction_id`）には、認可コードを経ずに発行したトークンでもトランザクションの ID が入る
  - **生成コードの構造（hono / express / fastify）**：`features/feature.ts` のフックに `authorize.responseTypes` が加わり、`endpoints/authorize/response-type.ts` が増えた。`issue-authorization-code` のステップは、機能が答える response type の要求を、認可コードを発行せずに機能へ渡す。`validate-request` は、PKCE を `code` を含む response type の要求だけで検証する。`endpoints/consent/steps/record-consent.ts` の `recordConsentDecision()` は、認可コードの代わりに `grantId` を持つ値を受け取る
  - **生成コードの構造（Next.js）**：`authorize/route.ts` で `prompt=none` と SSO が別々に発行していた認可コードは、`issueAuthorizationResponse()` が発行する。`consent/decision/route.ts` にはステップのマーカーが付き、それを並べる `endpoint.ts` が隣に増えた。`_oidc-provider/feature.ts` のフックに `authorize.responseTypes`（`code` のほかに答える `response_type` の名前）が加わった
  - **`store.ts`**：`ProviderStores.transactionStore` の型は、任意の `recordTokenIssued()` を足した `TransactionStorage` になった。自前のストアは、このメソッドを持たなくてもよい

### Patch Changes

- 61248a4: `implicit-flow` が発行する ID Token に、`claims` パラメータの `id_token` メンバーで個別に要求されたクレームを含める（OIDC Core 1.0 §5.5）
  
  - `response_type=id_token` と `id_token token` のどちらでも、`claims={"id_token":{"name":{"essential":true}}}` のように要求されたクレームを、End-User のクレームから ID Token に加える。`response_type=id_token` では、許可された scope の標準クレーム（§5.4）に加えて含める
  - OpenID Foundation の Implicit OP 認定プラン（`oidcc-implicit-certification-test-plan`）の `oidcc-claims-essential` は、`response_type=id_token` でこの要求を送り、ID Token に `name` が無いと WARNING にする

## 0.13.0

### Minor Changes

- fed3d48: 生成する OP で `acr_values` を検証し、決めた acr を ID Token とアクセストークンに載せて、アクセストークンの保存レコードにも残す
  
  - `/authorize` は core の `validateAcrValuesParameter()` で `acr_values` を検証する。省略してよい。空白区切りの各値に `"`、`\`、制御文字、非 ASCII 文字が含まれると、`invalid_request` をクライアントへ返す
  - `/token` に、トークンの acr / amr を決めるステップ `resolve-acr-amr`（Hono / Express / Fastify では `routes/token.ts` の `resolveTokenAcrAmr()`）を `issue-access-token` の前に加えた。`acrResolver` を渡していればその戻り値を使い、渡していなければ要求された値のうち最も優先する値を acr にする。要求が無ければ acr を載せない。リフレッシュでは最初に決めた acr / amr を引き継ぐ。これまで `issueIdToken()` の中で決めていた acr / amr は、このステップの結果を受け取る形にした
  - 決めた acr は、ID Token の `acr`、JWT アクセストークンの `acr`（RFC 9068 §2.2.1）、アクセストークンの保存レコードに入り、イントロスペクションのレスポンスにも `acr`（RFC 9470 §6.2）として現れる
  - Next.js の生成物は、`_oidc-provider/provider.ts` の `acrResolver` で acr / amr を決め、アクセストークンにも同じ acr を載せる。`acrResolver` は core の `selectPreferredAcr()` を使う形にした
  - `--db sql` の `access_tokens` に `acr` 列（`VARCHAR(5000)`）を、`--db kv` の `AccessTokenRecord` に `acr` を加えた
  - `resolve-acr-amr` は `removable: true` で、`--flow` で外すとトークンに acr を載せない OP になる。`issue-access-token` より後ろには置けない。`resolve-subject` のラベルは、解決する値に合わせて「Resolve the subject, auth_time and nonce」に変えた
  
  `schema.sql` は `CREATE TABLE IF NOT EXISTS` なので、以前の CLI で作った `--db sql` のデータベースに実行し直しても `acr` 列は増えない。新しい生成コードでトークンを発行する前に、次の文で列を足す。
  
  ```sql
  ALTER TABLE access_tokens ADD COLUMN acr VARCHAR(5000);
  ```
  
  `--db kv` は移行が要らない。`acr` の無い既存のレコードは acr の無いトークンとして読まれ、アクセストークンの期限が来ると消える。
  
  `acrResolver` を渡していない Hono / Express / Fastify の OP は、これまで `acr_values` を要求されても ID Token に acr を載せなかったが、今後は最も優先する要求値を載せる。要求された値をそのまま acr にした場合、その acr は OP が実際に行った認証を表すとは限らないので、ログインの方式に合った acr を返すときは `acrResolver` を渡す。
- cfc0a6f: 生成される OP を箱と矢印の図にする `graph` コマンドと、その図の元になるフロー文書から生成する `--flow` を追加し、生成コードの各エンドポイントを図の箱 1 つ = export 関数 1 つの形に分ける
  
  `maronn-oidc graph [framework]` は、`generate` と同じ `--enable` / `--disable` / `--scope` / `--db` から、生成される OP を Mermaid の flowchart（既定）か JSON のフロー文書（`--format json`）として標準出力（`-o` でファイル）に書く。何も生成しない。
  
  - 既定（`--detail endpoints`）は箱がエンドポイント、矢印はエンドポイントの間でコードやトークンが渡る向き。`--detail steps` は各エンドポイントの中を生成コードの export 関数 1 つにつき箱 1 つで描き、箱にはステップの ID、関数名、根拠の仕様節を載せる。`--endpoint <ids>` で描くエンドポイントを絞り、`--no-error-edges` でエラー応答への破線を省く
  - フロー文書には、エンドポイントとステップの一覧、各ステップが読む値と作る値（`consumes` / `produces`）、消せるかどうか（`removable`）、描いたときの `features` / `scopes` / `db` が入る。framework を付けると、各エンドポイントの生成先ファイル（`module`）も入る
  
  `generate` / `setup` / `graph` の `--flow <file>` は、このフロー文書（編集済みでもよい）を機能フラグの代わりに読む。`--enable` / `--disable` / `--scope` / `--db` との併用はエラーになる。
  
  - 文書で変えられるのは、`removable: true` のステップを消す、値のやり取りが無いステップを並べ替える、エンドポイントを並べ替える、`features` / `scopes` / `db` を変える、の 4 つ。消したステップが作っていた値を後のステップが読むときは、生成コードが既定値（ID Token なら `undefined`）で補う
  - `removable: false` のステップや `feature` 付きのステップを消す、値を作るステップより前にそれを読むステップを置く、`after` / `before` の制約に反する、画面のエンドポイント（`login` / `login-google` / `consent` / `device` / `ciba` / `logout`）のステップ列を変える、必須のエンドポイントを外す、といった文書は、何も書き込まずにエラーで止まる
  - 並べ替えたステップは Hono / Express / Fastify の生成コードに反映する。Next.js は Route Handler に処理を直接書く構成のため、`steps` を変えた文書はエラーにし、エンドポイントと機能の変更だけを受け付ける
  - `.maronn-openid-connect.json` に `steps`（並べ替えたエンドポイントごとのステップ ID の列）と `endpointOrder`（エンドポイントの順番）を追加した。並べ替えていなければ `null`。エンドポイントの順番は記録だけで、生成コードのマウント順は変えない
  
  生成コードの `routes/*.ts` は、図の箱と 1 対 1 で対応する export 関数（`routes/token.ts` なら `parseTokenRequest()` → `authenticateTokenClient()` → … → `respondToken()`）に分け、ハンドラーはそれらをステップ ID のコメント（`// [parse-request] …`）を添えて順に呼ぶ形にした。対象は Hono / Express / Fastify の `authorize` / `token` / `userinfo` / `introspection` / `revocation` / `discovery` / `jwks`、experimental の `par` / `register` / `device-authorization` / `backchannel-authentication`、画面の `login` / `consent`（`prepareLogin()` / `submitLogin()` / `completeGoogleLogin()` / `prepareConsent()` / `submitConsent()` が箱ごとの関数を決まった順で呼ぶ）。`pages/` が呼ぶ入口（`tokenApp`、`processAuthorizationRequest()`、`prepareLogin()` など）と outcome の型は変えていないので、画面を差し替えている生成コードはそのまま動く。`device` / `ciba` / `logout` の生成コードと Next.js の生成物は変わらない（Next.js はマニフェストの 2 項目だけが増える）。

## 0.12.0

### Minor Changes

- 7ebde04: `generate` / `setup` に `--db sql` と `--db kv` を追加し、生成 OP のデータを SQL のテーブルかキー・バリューストアに保存できるようにする。あわせて、クライアントに登録した scope の検証を生成コードに加える
  
  `--db sql` か `--db kv` を付けると、出力先に `db/` を生成する（Next.js は `_oidc-provider/db/`）。
  `--db` の後に種類が無いときや、`sql` と `kv` 以外のときは、何も書き込まずにエラーで終わる。
  生成アプリは `storage` と `clientResolver` を渡さなければ、クライアント、ユーザー、認可トランザクション、認可コード、トークン、セッション、同意を `db/` で扱う。
  
  どちらの種類でも、`db/` には次のファイルがある。
  
  - `db/instance.ts`：DB インスタンスを返す `createDatabase()`。利用者が書くファイルなので、CLI は無いときだけ作り、`--force` を付けても上書きしない。末尾に DB ごとの例を載せる
  - `db/database.ts`：`createDatabase()` が返す型
  - `db/stores.ts`：`ProviderStores` の実装。認可コードとリフレッシュトークンの `consume` は、使用済みにする操作を不可分な 1 回の操作で行い、同時に来た 2 つ目のリクエストを `invalid_grant` で止める。認可トランザクションは消さずに、`requested` から `token_issued` まで、またはコードを出さずに終わった `failed` で進み具合を記録し、認可コードとアクセストークンから参照する。ログインフォームはユーザーのパスワードのハッシュと照合する
  - `db/clients.ts`：登録クライアントを読む `ClientResolver` と、クライアントを登録する `registerClient()`。client_secret は `hashClientSecret()`（core）のハッシュだけを保存し、`clientSecretHash` で照合する。同じ値で呼び直しても中身は変わらないので、複数のインスタンスが起動時に同時に登録してよい
  - `db/users.ts`：ユーザーを登録する `registerUser()` と、パスワードを PBKDF2（HMAC-SHA256、100,000 回）でハッシュにする `hashPassword()` / `verifyPassword()`。パスワードは NULL にでき、パスワードの無いユーザー（Sign in with Google で作ったユーザーなど）はログインフォームでは認証できない
  
  `--db sql` は SQL のテーブルにデータを置く。
  
  - `db/database.ts` の `SqlDatabase` は、SQL を 1 文実行する `all` と `run` の 2 メソッドだけなので、どのドライバーや ORM でも実装できる。`instance.ts` には node:sqlite、Cloudflare D1（Hono のみ）、PostgreSQL（pg）、Prisma、Drizzle、Kysely の例を載せる
  - `db/schema.sql` と `db/schema.ts`：テーブル定義。SQLite、Cloudflare D1、PostgreSQL のどれでもそのまま通る。クライアント（`clients` と、認証方式、シークレット、リダイレクト URI、grant type、スコープの子テーブル）、ユーザー（`users`）、認可トランザクション（`transactions`、`authentication_requests`、`auth_users`）、認可コードとトークン（`codes`、`access_tokens`、`refresh_tokens`）をエンティティごとのテーブルに分ける。Sign in with Google の `federated_identities` と `upstream_auth_requests` は `--enable google-login` のときだけ作る
  
  `--db kv` はキー・バリューストアにデータを置く。
  
  - `db/database.ts` の `KvDatabase` は `get`、`set`（TTL を付けられる）、`setIfAbsent`、`delete` の 4 メソッドだけなので、Redis、Upstash、Valkey、DynamoDB などで実装できる。`setIfAbsent` は不可分である必要がある。`instance.ts` には Upstash Redis の REST API、node-redis、ioredis、メモリ上の Map の例を載せる（Hono は Upstash Redis と Map だけ）
  - `db/keys.ts`：キーの一覧と、各キーに入れる JSON レコードの型。`--db sql` のテーブルと同じ ER モデルのエンティティごとにキーを分け、クライアントのレコードは認証方式、シークレット、リダイレクト URI、grant type、スコープを中に持つ。認可コードとリフレッシュトークンは使用済みの印のキーを `setIfAbsent` で書いて 1 回限りにし、grant 単位の失効は失効の印のキーで行う
  - Cloudflare Workers KV は、書き込みがほかの拠点に届くまで時間がかかり、不可分な書き込みも持たないので、この条件を満たさない。Cloudflare では D1（`--db sql`）か、Durable Objects の上に作ったストアを使う
  
  Sign in with Google のユーザーは、Google の sub で同じ人かを判断し、初めてのログインでランダムな ID のユーザーを作る。
  ID トークン、private_key_jwt、authorization_details は保存しない。
  ID トークンは署名で検証するので保存する必要が無く、残りの 2 つはその機能を実装するときに足す。
  Next.js の `--db` 付き生成では、クライアント用の環境変数（`OIDC_CLIENTS_JSON` など）を読まない。
  
  クライアントに登録した scope（`RegisteredClient.scope`。`--db sql` では `client_scopes`、`--db kv` ではクライアントのレコードの `scopes`）の検証は、`--db` の有無によらず生成コードに加えた。
  `/authorize` と、生成した場合は Device Authorization Grant と CIBA の要求で、登録外の scope を `invalid_scope` で拒否する。
  scope を登録していないクライアントの動きは変わらない。
  
  既存の `db/instance.ts` は、生成ログに `Kept:`、`--dry-run` に `Would keep:` と表示し、上書き保護の対象にも数えない。
  `.maronn-openid-connect.json` には `db`（`sql`、`kv`、`--db` を付けなければ `null`）を記録する。
- de5effb: `generate` / `setup` の `--enable` に experimental 機能 `dynamic-client-registration`（OAuth 2.0 Dynamic Client Registration、RFC 7591）を追加する
  
  有効にすると、生成 OP にクライアント登録エンドポイント `POST /register` が加わり、クライアントは実行時に JSON メタデータを送って `client_id` と（confidential なら）`client_secret` の払い出しを受けられる。発行されたクライアントは、設定済みのクライアント解決（静的 Map、または `--db` のクライアント表・キー）の後に引かれる in-memory ストアに入り、そのまま `/authorize` と `/token` で使える。discovery には有効時のみ `registration_endpoint` を広告する。
  
  - 受理するメタデータは `redirect_uris`（必須。静的クライアントと同じ core の検査規則を適用）、`token_endpoint_auth_method`（`client_secret_basic` / `client_secret_post` / `none`）、`grant_types`（`authorization_code` と `refresh_token` のみ）、`response_types`（`["code"]` のみ）、`client_name` の 5 つで、理解しないメタデータは RFC 7591 §2 のとおり黙って無視する
  - 既定はオープン登録（RFC 7591 §3.1 SHOULD）。生成される `dynamicClientRegistrationConfig` の `initialAccessToken` を設定すると `Authorization: Bearer` の提示を要求し、照合は定数時間比較で行う。`maxRegisteredClients`（既定 100）超過は `429`、ボディは UTF-8 で `maxRegistrationBodyBytes`（既定 16384）バイトまで。Hono / Express / Fastify では `applyOidc` のオプション `dynamicClientRegistration` からも上書きできる
  - 動的登録クライアントは in-memory ストアにだけ入り、プロセス再起動で消える（PAR / Device / CIBA の experimental ストアと同じ割り切り）。登録後の参照・更新・削除（RFC 7592）は実装しない
  - 未指定時の生成物は従来とバイト同一で、install コマンドの案内も変わらない

## 0.11.0

### Minor Changes

- cb33342: 生成物から契約テスト `conformance.test.ts` をなくす
  
  `generate` と `setup` は、選択した機能構成に合わせた契約テスト `conformance.test.ts`（Next.js は `_oidc-provider/conformance.test.ts`）を生成コードと一緒に出力していた。
  生成コードのテストは書かない方針に改めたので、今後は出力しない。
  生成 OP の挙動は、このリポジトリの E2E テスト（`tests/e2e`）と OpenID Conformance Suite（`tests/conformance`）で確認する。
  
  ## 破壊的変更
  
  - **cli: 生成物に `conformance.test.ts` が含まれなくなった**。`--force` で再生成しても、既存の `conformance.test.ts` は削除も更新もされない。残ったファイルは以後の生成コードに追随しないので、手で削除する
- 15c4e23: ログイン・同意画面の認可トランザクションを、URL のクエリではなく Cookie と HTML の csrf_token で引き継ぐ
  
  これまで生成コードは、`/authorize` から `/login`・`/consent` へ認可トランザクションの ID を `?transaction_id=` として URL に載せ、フォームにも hidden の `transaction_id` を埋め込んでいた。URL に載った ID はブラウザ履歴・アクセスログ・画面共有から漏れ、漏れた ID があれば第三者が同意画面を開いて `csrf_token` を読み、フローを完了できる。攻撃者が自分のクライアントで始めたトランザクションへ被害者を誘導し、被害者の認可コードを攻撃者のクライアントへ届かせることもできる。これを防ぐ Cookie による束縛は、opt-in の `--enable transaction-binding` でしか生成していなかった。
  
  生成コードは常に次の形で認可トランザクションを引き継ぐ。
  
  - `/authorize` はトランザクションの ID を HttpOnly Cookie `__Host-oidc_txn`（`Secure; SameSite=Lax; Path=/; Max-Age=600`）だけでブラウザに渡し、クエリの無い `/login`（SSO で同意だけが残っている場合は `/consent`）へリダイレクトする。`__Host-` プレフィックスにより、同じサイトのサブドメインからこの Cookie を設定すること（Cookie tossing）をブラウザが拒否する
  - `/login`・`/consent` は Cookie からトランザクションを引き、フォームには `csrf_token`（Cookie とは別の乱数）だけを埋め込む
  - `POST /login`・`POST /consent` は、まずブラウザが付ける `Sec-Fetch-Site` / `Origin` で OP 自身の画面から送られたかを確かめ（生成される `store.ts` の `isSameOriginFormPost()`。`Sec-Fetch-Site` は `same-origin` と `none` だけを通し、無ければ `Origin` を issuer のオリジンと比べ、どちらも無いリクエストは通す）、次に Cookie が指すトランザクションに対して `csrf_token` を照合する。送信元チェックの失敗と `csrf_token` の不一致は 403、Cookie が無い・トランザクションが無い場合は 400（Next.js はそれぞれ `oidc-error` と `not-found.tsx` の 404）を OP 自身の画面で返し、クライアントへはリダイレクトしない。Google から POST される `/login/google` は送信元チェックの対象外
  - 同意の結果をクライアントへ返すときに Cookie を消す
  
  Cookie は同意の結果を返すまで残るので、URL にトランザクションを示すものがなくても、ログイン・同意画面をリロードすれば同じトランザクションのフォームがもう一度表示される。Cookie はブラウザに 1 つなので、同じブラウザの別タブで新しい認可リクエストを始めると、先のタブのフォームは `csrf_token` が一致せず拒否される。
  
  google-login の README は、生成コードのトランザクション Cookie と `/login/google` の関係の説明に更新した。
  
  ## 破壊的変更
  
  - **cli: `--enable transaction-binding` を削除した**。トランザクションの ID が Cookie にしか載らなくなり、Cookie 自体が User-Agent への束縛になったため。指定すると未知の機能としてエラーになる。Optional 機能のカテゴリもあわせて削除し、生成マニフェスト（`.maronn-openid-connect.json`）の `features` から `transactionBinding` がなくなった
  - **cli: `/login`・`/consent` の URL とフォームから `transaction_id` を削除した**。ログイン・同意画面を差し替えている場合は hidden の `transaction_id` を外し、`csrf_token` だけを送る。`LoginPageParams` / `ConsentPageParams`、`LoginScreen` / `ConsentScreen`、`LoginSubmission` / `ConsentSubmission` から `transactionId` を、`prepareLogin()` / `prepareConsent()` から `transactionId` 引数を、`AuthorizationOutcome` の `login` / `consent` と `LoginOutcome` / `GoogleLoginOutcome` の `authenticated` から `transactionId` を削除した。Next.js の `requireTransaction()` は引数を取らず、Cookie から `{ transactionId, transaction }` を返す
  - **cli: curl などで手動でフローを進めるときは Cookie を持ち回る必要がある**（`curl -c jar.txt -b jar.txt`）

## 0.10.0

### Minor Changes

- a9dffec: 後方互換のために残していた実装を削除する
  
  core はステップ関数を導入したとき、既存の呼び出し元を壊さないよう、ステップ関数を順に呼ぶだけの合成関数を「後方互換の合成 API」として残していた。
  CLI 生成コードはステップ関数の導入と同時に各ステップを直接呼び出す形へ移っており、合成関数を必要としていたのは導入前からの呼び出し元だけである。
  一般展開を予定していないため、合成関数とそのほかの互換用の分岐を削除する。
  
  ## 破壊的変更
  
  - **core: 合成関数を削除した**。`validateAuthorizationRequest` / `validateTokenRequest` / `validateAuthorizationCodeGrant` / `validateRefreshTokenGrant` / `authenticateClient` / `checkPromptNone` / `generateTokenResponse` / `handleUserInfoRequest` / `handleIntrospectionRequest` / `handleRevocationRequest` と、それらだけが使っていた型（`ValidateAuthorizationRequestOptions` / `TokenRequestContext` / `PromptNoneOptions` / `TokenResponseOptions` / `TokenResponse` / `GenerateTokenResponseResult` / `UserInfoRequestContext` / `IntrospectionRequestContext` / `RevocationRequestContext`）を削除した。`ClientAuthContext` からは `clientResolver` を外した。代わりに各ステップ関数を CLI 生成コードと同じ順に呼び出す
  - **core: `createAuthTransaction()` の第 3 引数はオプションオブジェクト（`{ ttlMs?, bindingHash? }`）だけを受け取る**。TTL を数値で渡すシグネチャを削除した
  - **core: `validateTransactionBinding()` は `bindingHash` を持たないトランザクションを `invalid_transaction_binding` で拒否する**。束縛の導入前に発行されたトランザクションを検証せずに通す分岐を削除した
  - **cli: 生成コードの `ProviderConfig.authorizationErrorRedirectPath` を削除した**。以前の Next.js 出力が自前のエラー画面へ 303 するために使っていたフックで、現在の生成物はどれも使っていない。非リダイレクトの認可エラーの見せ方は `pages/errors.ts` の `renderAuthorizationErrorPage()` で変える
  - **cli: Hono の再生成時に、以前の CLI が出力した `.ts` の画面ファイルを一覧して警告する処理を削除した**
  - **experimental: `validatePushedAuthorizationParams()` は core のステップ関数を直接呼び、戻り値は `void` になった**。オプションの型は `PushedAuthorizationValidationOptions`（`allowNonPkceAuthorizationCodeFlow` / `maxClaimsParameterLength`）で、`PushedAuthorizationRequestContext.validationOptions` もこの型になる。PAR は Request Object と併用しないため、`request` パラメータはパースせず `invalid_request` で拒否する
  
  google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。

## 0.9.0

### Minor Changes

- e7ffeb5: 署名鍵を鍵の配列だけで扱い、配列の先頭の鍵で署名する
  
  これまで `SigningKeyProvider` は、新しい署名に使う鍵を返す `getSigningKey()` と、JWKS で公開する鍵セットを返す任意の `getSigningKeys()` の 2 つを持っていた。`getSigningKeys()` は鍵ローテーションと複数アルゴリズム（RS256 + ES256）に対応するために後から足した任意メソッドで、実装しないプロバイダは `getRegisteredSigningKeys()` が `[await getSigningKey()]` にフォールバックしていた。生成コードもこれに合わせて単一鍵のコンテキスト（`privateKey` / `idTokenPrivateKey` / `userinfoPrivateKey` など）と鍵配列（`signingKeys` / `idTokenSigningKeys` / `userinfoSigningKeys`）を両方持ち、各ルートに「鍵配列が空なら単一鍵を使う」分岐があった。同じ鍵を 2 つの経路で表すため読みにくく、デバイスコードグラントや JARM が鍵配列ではなく単一鍵で署名してしまう不具合の原因にもなっていた。
  
  鍵は配列だけで表し、役割は配列の順序で決める。
  
  - 配列の先頭の鍵で新しいトークン（アクセストークンなど、alg を指定されない署名）に署名する
  - 2 本目以降はローテーション済みの鍵や別アルゴリズムの鍵として JWKS で公開する。ID Token / UserInfo / JARM など alg が決まっている署名は、従来どおり `selectSigningKeyByAlg()` で鍵セットから alg に合う鍵を選ぶ
  - ローテーションでは新しい鍵を先頭に置き、古い鍵はそれで署名したトークンが失効するまで後ろに残す
  
  ## 破壊的変更
  
  - **core: `SigningKeyProvider` は `getSigningKeys(): Promise<SigningKey[]>` だけになった**。`getSigningKey()` は削除した
  - **core: `getRegisteredSigningKeys()` を削除した**。`provider.getSigningKeys()` を直接呼ぶ
  - **core: 鍵配列の並びを「古い → 新しい」から「新しい（署名に使う鍵）→ 古い」に変えた**。`selectSigningKeyByAlg()` は同じ alg の鍵が複数あるとき、末尾ではなく先頭に近い鍵を選ぶ
  - **core: `createCachedSigningKeyProvider()` は `getSigningKeys()` だけをキャッシュする**
  - **CLI 生成コード: リクエストコンテキストの単一鍵の変数を削除した**（`privateKey` / `publicJwk` / `keyId` / `idTokenPrivateKey` / `idTokenPublicJwk` / `idTokenKeyId` / `userinfoPrivateKey` / `userinfoPublicJwk` / `userinfoKeyId`）。鍵は `signingKeys` / `idTokenSigningKeys` / `userinfoSigningKeys` から読む
  - **CLI 生成コード: 空の鍵配列を返すプロバイダを拒否する**。鍵の読み込み時に `validateSigningKeySet()` が例外にし、エンドポイントは 503（`Failed to load signing key`）を返す
  - **CLI 生成コード（Next.js）: `SigningKeySet` を `{ active, registered }` から、先頭の鍵で署名する配列 `[SigningKey, ...SigningKey[]]` に変えた**。`keys.general.active` は `keys.general[0]` に、`keys.general.registered` は `keys.general` になる
  - **CLI 生成コード: JWKS で kid の無い鍵を 1 本だけ公開するとき、末尾ではなく先頭（最新）の鍵を選ぶ**
  
  ## 移行方法
  
  `getSigningKey()` を実装しているプロバイダは、署名に使う鍵を先頭にした配列を返す `getSigningKeys()` に置き換える。
  
  ```ts
  // 変更前
  const provider: SigningKeyProvider = {
    async getSigningKey() {
      return currentKey;
    },
    async getSigningKeys() {
      return [previousKey, currentKey];
    },
  };
  
  // 変更後
  const provider: SigningKeyProvider = {
    async getSigningKeys() {
      return [currentKey, previousKey];
    },
  };
  ```
  
  CLI で生成したコードは再生成する。
  
  experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。

## 0.8.0

### Minor Changes

- 9212767: Hono の生成物を TSX 前提にし、画面を hono/jsx で描画する
  
  `generate hono` / `setup hono` は、ログイン・同意・エラー（と device / CIBA / logout）の画面を JSX で生成する。
  
  - 既定の画面は HTML 文字列の `views.ts` ではなく、hono/jsx のコンポーネントを並べた `views.tsx` に出力する。JSX が埋め込んだ値をすべてエスケープするため、生成コードから `escapeHtml` がなくなる
  - 画面を描く `pages/errors` / `pages/login` / `pages/consent`（機能有効時は `pages/device` / `pages/ciba` / `pages/logout`）も `.tsx` になり、`renderView(<views.loginPage {...params} />)` のように JSX でビューを描画する。HTML を返さない `pages/authorize.ts` と `pages/respond.ts` は `.ts` のまま
  - Hono の `ViewResult` は JSX 要素（`JSX.Element`）になり、ビューは JSX 要素を返すコンポーネントとして書く。別の手段で組み立てた HTML は `hono/html` の `html` タグか `raw()` で返し、Response そのもの（ステータスやヘッダー）を変えるときは `pages/*.tsx` の `render*Page()` を書き換える。`renderView()` は async コンポーネントを含む要素を解決後にストリームで返す
  - ビューのパラメーター型と `Views` インターフェースのメソッド構成は他のフレームワークと共通のまま。契約テストは JSX ビューの描画（`renderView()` のシリアライズ・ステータス・非同期描画）と、`createApp` の `views` で注入したビュー（`html` タグで組み立てたもの）の描画を固定する
  
  移行: `tsconfig.json` に `"jsx": "react-jsx"` と `"jsxImportSource": "hono/jsx"` を追加する。HTML 文字列や `Response` を返していたカスタムビューは、JSX コンポーネント（または `html` / `raw()`）に書き換えるか、Response を組み立てる処理を `pages/*.tsx` の `render*Page()` へ移す。以前の CLI で生成した出力を `--force` で再生成すると古い `views.ts` や `pages/login.ts` などが残り、同名の `.tsx` より優先して解決されるので、カスタマイズを `.tsx` へ移してから古い `.ts` を削除する（CLI は残っているファイルを一覧して警告する）。Express / Fastify / Next.js の生成物は変わらない。
- 899d2e1: Next.js 向けの生成コードを、App Router の機能をそのまま使う構成に作り直す。これまでは Hono 風の共通ルーター（`_oidc-provider/web-router.ts` / `app.ts` / `next.ts` / `runtime.ts`）の上で他フレームワークと同じ `pages/` / `routes/` を動かし、各 `route.ts` はそこへ委譲するだけだったため、1 つのエンドポイントの処理を追うのに何層も読む必要があった。
  
  - エンドポイントごとの Route Handler（`authorize/route.ts`・`token/route.ts`・`userinfo/route.ts`・`introspect/route.ts`・`revoke/route.ts`・`.well-known/*/route.ts`、機能有効時の `par/route.ts`・`device_authorization/route.ts`・`backchannel_authentication/route.ts`・`logout/route.ts` など）が自分で `GET` / `POST` / `OPTIONS` を export し、検証パイプラインをそのファイルに上から順に書く
  - 全エンドポイントが共有する部品は `_oidc-provider/` にまとめる。`provider.ts` は設定・クライアント・署名鍵・ストアを組み立てる場所で、環境変数 `OIDC_ISSUER` / `OIDC_CLIENTS_JSON` / `OIDC_SIGNING_KEY_ID` などを読む。`http.ts` は CORS・キャッシュ禁止の JSON 応答・パラメータ重複の検出・エラーページへのリダイレクト、`html.ts` は device / CIBA / RP-Initiated Logout の画面を HTML で返す Route Handler 用の部品
  - ログイン・同意画面は従来どおりページと Server Action（`login/page.tsx` + `login/actions.ts` + `login/session.ts`、`consent/page.tsx` + `consent/actions.ts`）
  - OP がブラウザを止める場面を Next.js の機能で表す。`transaction_id` に対応する認可リクエストが無ければページと Server Action が `notFound()` を呼び、`login/not-found.tsx` / `consent/not-found.tsx` を HTTP 404 で表示する。クライアントへ返してはいけないエラー（未登録の `redirect_uri`、CSRF トークンの不一致、ログイン試行回数の上限、transaction-binding の不一致、判断を含まない同意の POST、Google ログインのコールバックの失敗など）は `redirect()` で `oidc-error/page.tsx` へ送る。想定外の例外は `login/error.tsx` / `consent/error.tsx`（error boundary）が表示し、本番ではエラーメッセージを出さずサーバーログと突き合わせられる `digest` だけを出す。これらの画面は `_oidc-provider/error-view.tsx` の共通レイアウトで描く（`oidc-error/error.tsx` は廃止）。従来は、トランザクションが見つからないときや CSRF トークンが一致しないときに例外がそのまま投げられ、Next.js の既定のエラー画面（500）になっていた
  - device / CIBA / RP-Initiated Logout の画面は、表示と同時に Cookie を発行し 403 や 429 などのステータスを返す必要があるため、HTML を返す Route Handler（各ディレクトリの `screens.ts`）として生成する。実験的機能の設定は、それを使うコードの隣に置く（例: `par/config.ts`、`token/token-exchange.ts` の `tokenExchangeConfig`）
  - 署名鍵プロバイダを `globalThis` で共有し、同意の Server Action でも JWKS が公開する鍵で署名できるようにした。これにより `--enable jarm` では、ログイン・同意画面を経由する応答も JARM になる（従来は平文クエリに戻る制限があった）
  - `--enable rp-initiated-logout` の `/logout` と `/logout/approve` を Next.js でも生成する（従来はロジックだけが生成され、Route Handler が無かった）
  - 同意の Server Action が grant を記録するようにし、同意を撤回（`consentResolver.revokeConsent()`）すると、同意画面を経て発行したトークンも失効するようにした。ログインフォームは `login_hint` を初期値に使う
  - 契約テスト `_oidc-provider/conformance.test.ts` を Next.js 用に書き直した。Route Handler・ページ・Server Action を Next.js と同じ形で直接呼び出し（`next/headers` の `cookies()` と `next/navigation` の `redirect()` / `notFound()` だけを差し替える）、サーバーを起動せずに `vitest run` で実行できる
  
  hono / express / fastify の生成物は変わらない。生成済みの Next.js コードを `--force` で再生成すると、`_oidc-provider/` 配下の共通ルーター関連ファイル（`app.ts` / `web-router.ts` / `next.ts` / `runtime.ts` / `views.ts` / `pages/` / `routes/`）と `oidc-error/error.tsx` は生成されなくなるので削除する。`runtime.ts` で行っていた設定・クライアント・署名鍵の差し替えは `_oidc-provider/provider.ts` へ移す。

## 0.7.1

### Patch Changes

- ed8c5a5: 空文字列の `client_secret` を「未提示」として扱う（RFC 6749 §3.2）
  
  `extractClientCredentials` が値なしのフォームフィールド（`client_secret=`）を client_secret_post の資格情報として数えていたため、public client が `client_id=x&client_secret=` を送ると方式不一致で拒否され、`Authorization: Basic` と空の `client_secret` フィールドの併存が多重認証方式として拒否されていた。RFC 6749 §3.2 の「値なしで送られたパラメータは省略として扱う（MUST）」に従い、抽出時に空文字列を未提示へ正規化する。confidential client が空の `client_secret` だけを送った場合は、従来どおり invalid_client で拒否される（拒否理由が「方式不一致」から「認証必須」になる）。CLI 生成の conformance テストにこの挙動を固定する契約テストを追加。

## 0.7.0

### Minor Changes

- f406de0: 生成コードのルーティングを「画面用（`pages/`）」と「API（`routes/`）」の 2 種類に分け、UI のカスタマイズを `pages/`（と `views.ts`）だけで完結できるようにする。ブラウザに返すもの（画面の描画・リダイレクト・Cookie の付与）はすべて `pages/` が担当し、`routes/` はロジックだけを持って Response を一切作らない。
  
  - `pages/authorize.ts` / `pages/login.ts` / `pages/consent.ts` / `pages/errors.ts` / `pages/respond.ts` を新たに生成する。ブラウザ向けのルートは GET も POST もここにあり（`GET|POST /authorize`・`GET|POST /login`・`GET|POST /consent`）、リクエストを読んで `routes/` の関数を呼び、返ってきた結果（outcome）を画面かリダイレクトに変換する。`pages/respond.ts` は Cookie を付けて Response / リダイレクトを返すヘルパ（`withCookies()` / `redirectWithCookies()`）。`--enable device-authorization-grant` / `ciba` / `rp-initiated-logout` では `pages/device.ts` / `pages/ciba.ts` / `pages/logout.ts` も生成し、各機能のブラウザ向けルートをすべて持つ
  - `routes/authorize.ts` / `routes/login.ts` / `routes/consent.ts`（機能有効時: `routes/device.ts` / `routes/ciba-verification.ts` / `routes/logout.ts`）はルーターではなく関数を export するロジックモジュールになる（`processAuthorizationRequest()` / `prepareLogin()` / `submitLogin()` / `prepareConsent()` / `submitConsent()` / `submitDevice*()` / `prepareCibaDevice()` / `submitCiba*()` / `processEndSessionRequest()` / `approveLogout()`）。結果は `kind` 付きの outcome（リダイレクト先 `location`、付与する `cookies`、画面データ、またはエラー）で返し、`c.redirect()` / `c.json()` / `Set-Cookie` / `renderView()` を行わない。`views.ts` も `pages/` も import しない。transaction-binding の `rejectUnboundTransaction()` と google-login の `buildGoogleSignIn()` / `completeGoogleLogin()` もここに置く
  - `token` / `userinfo` / `introspection` / `revocation` / `par` / `device_authorization` / `backchannel_authentication` / `jwks` / `discovery` の JSON エンドポイントは従来どおり `routes/` のルーターのまま
  - `app.ts` / `apply.ts` はブラウザ向けパス（`/authorize` `/login` `/consent` `/device` `/ciba` `/logout`）に `pages/` のルーターだけをマウントする
  - Next.js 向け生成物の契約テストで、壊れた Request Object の非リダイレクトエラーが `authorizationErrorRedirectPath` の 303 になることを期待するよう修正した（従来は HTML 400 を期待しており、生成直後から失敗していた）
  
  HTTP 上の挙動（ステータスコード・Cookie・リダイレクト先・画面の HTML）は変わらない。生成済みコードを `--force` で再生成すると `pages/` が追加され、`routes/authorize.ts` `routes/login.ts` `routes/consent.ts` などは Response を返す handler から outcome を返す関数に置き換わる。これらを直接編集していた場合は、描画・リダイレクトに関する変更を `pages/` へ移す。
- 3c4b423: `--enable rp-initiated-logout` で OpenID Connect RP-Initiated Logout 1.0 の end_session_endpoint を生成できるようにする。生成 OP に `GET|POST /logout` と確認画面の承認先 `POST /logout/approve` が追加され、discovery が `end_session_endpoint` を公表する。有効な `id_token_hint` が現在のセッションの End-User を指す場合は即時ログアウトし、それ以外は確認画面を挟む（RP-Initiated Logout 1.0 §2）。リダイレクトは `rpInitiatedLogoutConfig.postLogoutRedirectUris` に登録した URI との完全一致時のみ行い、`state` をそのまま返す（§3）。experimental には subpath export `@maronn-openid-connect/experimental/rp-initiated-logout`（end_session リクエストの正規化・ヒント audience 抽出・ログアウト分岐判定・リダイレクト解決の純関数群）が加わる。未指定時の生成コードは変更されない。
- 9df8d94: introspection エンドポイントで public client の client_id 単独提示を拒否する
  
  これまで生成 OP の introspection ルートは token エンドポイントと同じクライアント認証パイプラインを使っており、`token_endpoint_auth_method: 'none'` で登録されたクライアントは「資格情報を提示していないこと」の確認だけで通過していた。public client の client_id は公開情報なので、これを認証済み呼び出し元として扱うと誰でもトークンを走査できる（RFC 7662 §2.1 は呼び出し元の認可を要求し、RFC 9701 §5 は未認証リクエストの拒否を MUST とする）。
  
  - core に導入ステップ関数 `requireConfidentialIntrospectionCaller` を追加した。登録方式が `'none'` のクライアントを `invalid_client`（401 + `WWW-Authenticate: Basic realm="Client Authentication"`）で拒否し、それ以外（既定の `client_secret_basic` を含む）は通す
  - CLI が生成する introspection ルートは、クライアント認証パイプラインの直後・トークン解決の前にこのステップを呼ぶ。`--enable jwt-introspection-response` の JWT 経路もこの拒否より後にあるため、Accept ヘッダーで迂回できない
  - revocation ルートは変更していない（RFC 7009 §2.1 は public client が自分のトークンを失効させることを正当に許す）
  
  experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。

## 0.6.0

### Minor Changes

- 70171eb: 拡張機能カテゴリ（Extension features）を追加し、`--enable google-login` で Sign in with Google（Google Identity Services の redirect mode）を生成コードのログイン手段に足せるようにする。既定では無効で、無効時の生成物は従来と 1 バイトも変わらない。
  
  有効時は `@maronn-openid-connect/google-login` を import する次の生成物が加わる。
  
  - `config.ts`: `ProviderConfig.googleLogin?: GoogleLoginConfig`（`clientId` / 任意の `hostedDomain` / `requireVerifiedEmail`）。未設定ならボタンは描画されず `/login/google` は 404
  - `views.ts`: `LoginPageParams.googleSignIn`（`g_id_onload` の属性）。既定のログイン画面はパスワードフォームの下に GIS の 3 要素（スクリプト / `g_id_onload` / `g_id_signin`）を書き出す（UI は生成コード側にあり、パッケージは属性だけを返す）
  - `routes/login.ts`: GET `/login` で認証トランザクションに束縛した nonce を発行してボタンを描画し、`POST /login/google`（`login_uri`）で `g_csrf_token` の Double Submit Cookie 検証 → `google-auth-library` による ID トークン検証 → nonce の単回消費 → パスワードログインと同じセッション確立 → `/consent` へ進む
  - `store.ts`: `googleLoginNonceStore`（インメモリ / `JsonStoreBackend` 両対応）と、Google アカウントを `google:<sub>` の subject で JIT 登録する `userStore.linkGoogleAccount()`
  - `app.ts`: `googleIdTokenVerifier` / `googleAccountResolver` を差し替えるオプション（契約テストは偽の verifier を注入する）
  - Hono のメソッドガードと Fastify アダプタに `POST /login/google` を登録。Next.js は `login/google/route.ts`（Node.js ランタイム）を生成し、`login/page.tsx` でボタンを描画、`runtime.ts` が `GOOGLE_CLIENT_ID` / `GOOGLE_HOSTED_DOMAIN` を読む
  - `conformance.test.ts`: ボタン描画・nonce の発行と単回消費・CSRF・検証失敗・hosted domain・JIT 登録からトークン発行と UserInfo までを固定する契約テスト
  
  `--help` と未知の機能名のエラーメッセージに「Extension features (disabled by default): google-login」を追加し、`setup` の次のステップ案内に `@maronn-openid-connect/google-login` のインストールを加える。`google-auth-library` の要件により、この機能を有効にした生成コードは Node.js 22 以上限定になる。
- b8f4a14: generate / setup に上書きガードを追加する。出力先に既存の生成対象ファイルがある場合は何も書き込まずに一覧を表示して非ゼロ終了し、`--force` 指定時のみ上書きする（ログは `Created:` / `Overwritten:` で区別）。`--dry-run` で出力予定の一覧だけを確認できる。また、生成物に `.maronn-openid-connect.json` マニフェストを追加し、生成元の CLI バージョン・framework・機能構成・カスタムスコープを記録する。

## 0.5.0

### Minor Changes

- 6f9d886: `--enable ciba` で OpenID Connect Client-Initiated Backchannel Authentication（CIBA Core 1.0、Poll モード）を生成できるようにする。バックチャネル認証エンドポイント（`POST /backchannel_authentication`）、OP がホストする認証デバイス UI（`GET /ciba` / `POST /ciba/login` / `POST /ciba/approve`）、トークンエンドポイントの `urn:openid:params:grant-type:ciba` grant 分岐、discovery の `backchannel_token_delivery_modes_supported: ["poll"]` と `backchannel_authentication_endpoint` を追加する。experimental には subpath export `@maronn-openid-connect/experimental/ciba`（リクエスト処理・認証デバイス UI のステップ関数・ポーリング状態機械・ストア契約）が加わる。未選択時の生成出力は、conformance.test.ts の default-off 契約テストを除き従来と同一。
- 8c043d0: `--scope` で、生成 OP が受け付けるカスタムスコープを生成時に宣言できるようにする。宣言すると `scopes.ts`（スコープポリシー）が生成され、discovery の `scopes_supported` に宣言したスコープが載り、認可エンドポイント（`--enable device-authorization-grant` / `--enable ciba` を併用した場合はデバイス認可・バックチャネル認証エンドポイントも）は宣言していないスコープ値を `invalid_scope` で拒否するようになる。このチェックは `applyOfflineAccessPolicy` の後に置き、付与条件を満たさない `offline_access` を「無視する」挙動（OIDC Core 1.0 §11）を壊さない。
  
  「誰にどのスコープを許すか」は CLI のオプションにせず、生成コード側に置いた。`scopes.ts` の `resolveGrantableScopes()`（async。手早く絞るための `RESTRICTED_SCOPE_SUBJECTS` 付き）が絞り込みの入口で、同意画面の表示と承認、SSO fast path と `prompt=none`、device / CIBA の承認からすでに `await` された状態で生成される。SSO と `prompt=none` では保存済み同意を引く前に適用するため、そのユーザーが持てないスコープをキーに同意を探し続けることがない。落としたスコープはリクエストを失敗させず付与スコープを狭める（RFC 6749 §3.3。トークンレスポンスの `scope` に実際の付与内容が載る）。宣言が 1 つも無い場合は何も生成せず、生成出力は従来とバイト同一。
- 2eea313: `--enable jwt-introspection-response` で JWT Response for OAuth Token Introspection（RFC 9701）を生成できるようにする。イントロスペクションエンドポイントは、`Accept: application/token-introspection+jwt` を明示したリクエストに対してのみ、RFC 7662 の応答を `token_introspection` クレームへ封入し `typ: token-introspection+jwt`・RS256 で署名した JWT で返す。JWT 応答の経路には RFC 9701 §3 の呼び出し元 audience 制限（発行先本人または `aud` 記載先以外には `{"active": false}`）を適用し、discovery に `introspection_signing_alg_values_supported: ["RS256"]` を広告する。`Accept` を明示しないリクエストへの JSON 応答と、未選択時の生成出力は従来とバイト同一。`--disable introspection` との併用は生成時にエラーとして拒否する。experimental には subpath export `@maronn-openid-connect/experimental/jwt-introspection-response`（Accept 判定・audience 制限・応答 JWT 生成）が加わる。

### Patch Changes

- c1911c7: Request Object の検証失敗を `invalid_request_object`（OIDC Core 1.0 §6.3）で返す
  
  これまで `request` パラメータの Request Object がパース・署名検証に失敗すると、汎用の `invalid_request` に潰して返していた。OIDC Core 1.0 §6.3 が定義するとおり `invalid_request_object` を返すよう変更し、`request_not_supported`（Request Object の使用をやめるべき）と `invalid_request_object`（Request Object の生成処理を直すべき）をクライアントが区別できるようにした。
  
  - `AuthorizationErrorCode` に `InvalidRequestObject`（`invalid_request_object`）と `InvalidRequestUri`（`invalid_request_uri`）を追加した。既存の enum メンバーとシリアライズ値は変えていない
  - `resolveRequestObjectParams` が `RequestObjectError` を `invalid_request_object` へ変換するようになった。壊れた Request Object 内の redirect_uri を信用しない非リダイレクト挙動（OP 上でのエラー表示、state 非 echo）は従来どおり
  - CLI 生成の `conformance.test.ts` に、壊れた Request Object が非リダイレクトの `invalid_request_object` エラーページになる契約テストを追加した
  
  `invalid_request` の受信を前提にしていたクライアントは、Request Object 起因の失敗で `invalid_request_object` を受け取るようになる。

## 0.4.0

### Minor Changes

- 189f030: `--enable id-jag` を追加し、生成 OP で Cross-App Access（ID-JAG）を再現できるようにした

  Identity Assertion Authorization Grant（draft-ietf-oauth-identity-assertion-authz-grant-04）の experimental 実装を CLI から有効化できる。生成 OP は 2 つの役割を同時に持つ。

  - **発行側（IdP）**: Token Exchange grant（RFC 8693）で `requested_token_type=urn:ietf:params:oauth:token-type:id-jag` を受け、自 OP 発行の ID トークンを検証して、別トラストドメインのリソース認可サーバー宛ての ID-JAG（`typ: oauth-id-jag+jwt`、RS256 署名）を発行する
  - **受領側（リソースアプリの AS）**: `urn:ietf:params:oauth:grant-type:jwt-bearer` grant（RFC 7523）で、信頼設定済みの外部 IdP が署名した ID-JAG を検証し、自 OP のアクセストークンを発行する

  subject_token は ID トークンに加え、`idJagConfig.allowRefreshTokenSubjects`（既定 true）で自 OP 発行の refresh token も受けられる（draft §4.3 MAY。検証は通常の refresh grant と同一で、rotation 再利用は token family を失効させる。RT は消費しない）。`idJagConfig.allowActorTokens`（既定 false の opt-in）で actor_token を受けて `act` claim を発行でき、受領側は act を発行アクセストークンへ引き継ぐ。`actor_token_type` は RFC 8693 §3 / RFC 7519 §9 が定義する 6 種（access_token / refresh_token / id_token / jwt / saml1 / saml2）を種別で区別せず受理し、内容検証はすべて `idJagConfig.actorTokenResolver`（デプロイ側の検証フック）が担う。リクエスト構造とリゾルバ戻り値の構造はライブラリが検証し、トークン内容の検証はリゾルバの責務。生成コードは自 OP 発行 ID トークンを検証する既定リゾルバを配線しており、差し替え・拡張で受理範囲を決められる。

  生成コードは `routes/token.ts` の 2 分岐と `idJagConfig`（許可 audience、信頼 IdP、ID-JAG 有効期間、refresh subject と actor の受理設定、actor リゾルバのフック。信頼系はいずれも fail-safe な空デフォルト）、discovery のメタデータ（`grant_types_supported` への両 URN、`identity_chaining_requested_token_types_supported`、`authorization_grant_profiles_supported`）、XAA の契約テストで構成される。既存の `--enable token-exchange` と併用でき、`--enable id-jag` を付けない生成出力は従来とバイト単位で同一。

- 6e2e8a4: online refresh token を追加し、Refresh Token の可否判定を標準の `grant_types` に一本化した

  OIDC Core 1.0 §11 は `offline_access` を「End-User が居ない（not logged in）ときにも使える Refresh Token を要求する scope」と定義したうえで、Refresh Token の利用がその用途に限られないことを明示している（"The Authorization Server MAY grant Refresh Tokens in other contexts that are beyond the scope of this specification."）。この「other contexts」を **online refresh token** として実装した。

  Refresh Token は次の 2 種類になる。

  - **online refresh token**: `offline_access` を伴わない付与で発行する。発行元のログインセッションに束縛され、セッションが終わると `invalid_grant` になる
  - **offline refresh token**: `offline_access` が付与された場合に発行する（付与には `prompt=consent` が必要）。セッションから独立しており、ログアウト後も使える

  どちらを発行するかにかかわらず、クライアント登録メタデータ `grant_types`（RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2、既定は `["authorization_code"]`）に `refresh_token` が無ければ Refresh Token を発行しない。発行しても `unauthorized_client` で拒否されるだけの長期資格情報を渡さないためである。

  ## 破壊的変更

  - **生成コードの `RegisteredClient.offlineAccessAllowed` を削除した**。Refresh Token の可否は `grantTypes` だけで決まる。CLI で生成したコードを使っている場合、クライアント登録から `offlineAccessAllowed` を消し、`grantTypes` に `refresh_token` が入っていることを確認すること。`grantTypes` を書いていないクライアント（既定 `["authorization_code"]`）には `offline_access` が付与されなくなり、Refresh Token も発行されない
  - **`applyOfflineAccessPolicy` の引数が変わった**。`(scope, effectiveParams, promptValues, client, isOfflineAccessGranted?)` となり、`client` が第 4 引数に入る
  - **`OfflineAccessGrantedCallback` の context に `client` が加わった**。既定実装 `defaultIsOfflineAccessGranted` は `prompt=consent` かつ `grant_types` に `refresh_token` を含むことを要求する

  ## 追加

  - `ClientInfo.grantTypes`: 認可エンドポイントもクライアント登録の `grant_types` を参照できるようにした
  - `AuthenticationSessionResolver` / `AuthenticationSessionInfo`: online refresh token の束縛先セッションを `sessionId` から解決する契約
  - `validateRefreshTokenSession`: 束縛先セッションの生存を検証するステップ関数。`TokenRequestContext.authenticationSessionResolver` から `validateRefreshTokenGrant` に組み込まれる
  - `RefreshTokenInfo.sessionId` / `AuthorizationCodeInfo.sessionId` / `SessionInfo.sessionId`: 認可からトークン発行、rotation まで束縛を引き継ぐ
  - `clientAllowsGrantType` / `clientAllowsRefreshTokenGrant` / `DEFAULT_CLIENT_GRANT_TYPES`: `grant_types` の既定値の解釈を 1 箇所に集約した
  - 生成コードの `ProviderConfig.onlineRefreshTokenEnabled`（既定 `true`）: `false` にすると Refresh Token は `offline_access` が付与された grant にだけ発行される

## 0.3.0

### Minor Changes

- 38d6ac5: 同意 POST の承認判定を fail-closed にする（`action` の肯定値を明示検出する）

  **破壊的変更**: 生成される同意ハンドラは、これまで `action === 'deny'` のときだけ拒否し、
  **それ以外のすべての値（未送信・空文字・未知の値）を承認として認可コードを発行していた**。
  承認を「否定の否定」で判定する denylist 方式のため、値の欠落・変更に対して常に危険側
  （承認側）へ倒れていた。

  OIDC Core 1.0 §3.1.2.4 は「Once the End-User is authenticated, the Authorization Server MUST
  obtain an authorization decision before releasing information to the Relying Party.」と定めており、
  decision が取得できたと判定する条件は OP の責務である。「否定語に一致しないこと」で代替すると、
  利用者が生成された view の `value="approve"` を `allow` / `accept` などへ書き換えた時点で
  **拒否ボタンだけが正しく動き、承認は常に成立する**状態になり、画面上は正常に見えるため
  誤りに気づけない。

  cli（hono / express / fastify / nextjs のすべてに適用）:

  - 同意ハンドラを allowlist 判定に変更した。肯定値は `approve`（現行 view と同じ値）に固定し、
    `approve` でも `deny` でもない値は認可コードを発行せず、`recordConsent` も呼ばない
  - 未知値はクライアントへ `access_denied` で戻さず、OP 自身の 400 エラーページで止める。
    `access_denied` は「resource owner が拒否した」意味（OIDC Core 1.0 §3.1.2.6）であり、
    「決定が取得できなかった」とは意味論が異なるため
  - Next.js の Server Action 版（`src/app/consent/actions.ts`）も同じ判定にし、こちらは
    App Router の作法に合わせて OP 自身の `/oidc-error` ページへ送る
  - view（`views.ts` / `consent/page.tsx`）とハンドラが期待する値の対応を、テンプレート内の
    コメントで明示した
  - 生成される `conformance.test.ts` に、`action` の未送信・空文字・未知値が認可コードを
    発行しないことを固定する契約テストを追加した

  **移行**: 生成コードの同意 view を改変し、Approve ボタンの `value` を `approve` 以外へ
  変更している場合、承認が 400 になる。`value="approve"` へ戻すか、ハンドラ側の
  `if (action !== 'approve')` を合わせて変更すること。フォームを再構成して POST している
  自動化テスト・スクリプトも、`action=approve` を明示的に送る必要がある。

- f035419: `--enable token-exchange` で生成される OP が、Token Exchange の **delegation**（RFC 8693 §1.1 / §4.1）に対応しました。これまでは `actor_token` を含むリクエストを `invalid_request` で拒否していました。

  impersonation（`actor_token` なし）は従来どおりで、生成されるトークンにも差分はありません。

  ## 生成コードの変更点

  - `routes/token.ts`: 交換 grant の分岐が `processTokenExchangeRequest` の戻り値に含まれる `actor` を読み、delegation のときだけ `act` claim を **発行 JWT の payload とアクセストークン metadata の両方** に載せます。metadata へ保存するのは、そのトークンを後日 `subject_token` として再交換したときに委譲チェーンを繋げるためです（§4.1 のネスト）。ストア metadata の型は experimental が提供する構造的拡張型 `ExchangedAccessTokenInfo` を使います
  - `conformance.test.ts`: delegation の契約テストを追加しました。`act` に actor が記録されること、impersonation では `act` が付かないこと、委譲済みトークンを再交換すると過去の actor が `act.act` へネストされること、delegation トークンでも UserInfo が subject を返すことを固定します。あわせて `actor_token` / `actor_token_type` の組み合わせ規則（§2.1）と、無効な `actor_token` の固定文言も検証します
    - この契約テストは、subject と actor の `sub` を区別するために 2 人目のシードユーザー `otheruser` で認可コードフローを流します。`authorizeFlow` / `subjectTokenFor` にユーザー名の引数が増えていますが、既定値は `testuser` のままなので既存テストの挙動は変わりません

  `--enable token-exchange` を付けない生成物に差分はありません。

  ## 移行上の注意

  - **`actor_token` を拒否する挙動に依存していた場合は影響があります。** 生成コードを再生成すると、有効な `actor_token` を伴うリクエストが 400 ではなく 200 を返すようになります。委譲を許可したくない場合は、`routes/token.ts` の交換分岐で `params.actor_token` を検証して拒否してください（分岐内のステップ関数は個別に呼べます）
  - 再生成すると `routes/token.ts` と `conformance.test.ts` が更新されます
  - `actor_token` は交換時点で有効なアクセストークンであることだけを確認し、**発行トークンの有効期間は cap しません**。寿命は従来どおり `min(config.accessTokenExpiresIn, subject_token の残存秒数)` で決まります
  - Experimental です。API・設定値・生成コードの構造はマイナーリリースでも破壊的に変更されることがあります

## 0.2.0

### Minor Changes

- 81d28b8: `--enable device-authorization-grant` を追加しました。OAuth 2.0 Device Authorization Grant（RFC 8628）を生成 OP に組み込む Experimental 機能です。

  ブラウザを持たない・文字入力が困難なデバイス（スマート TV / CLI ツール / IoT 機器）が、別デバイスのブラウザでユーザーに承認してもらい、自分はトークンエンドポイントをポーリングしてトークンを受け取るフローを検証できます。

  ## 有効化方法

  ```bash
  maronn-oidc generate hono --enable device-authorization-grant
  pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
  ```

  hono / express / fastify / nextjs のすべてで生成できます。ロジックは `@maronn-openid-connect/experimental/device-authorization-grant` が提供します。

  ## 有効時に生成されるもの

  - `routes/device-authorization.ts`: デバイス認可エンドポイント（`POST /device_authorization`）と設定値 `deviceAuthorizationConfig`（`deviceCodeExpiresIn` / `pollInterval` / `maxLoginAttempts`）
  - `routes/device.ts`: 検証 UI（`GET/POST /device` / `POST /device/login` / `POST /device/approve`）
  - `views.ts`: `deviceVerificationPage` / `deviceLoginPage` / `deviceApprovalPage` / `deviceCompletedPage` の 4 ページ（差し替え可能）
  - `store.ts`: `InMemoryDeviceAuthorizationStore` と、ブラウザバインディング Cookie（`oidc_device_<user_code>`）のヘルパー
  - `routes/token.ts`: `grant_type=urn:ietf:params:oauth:grant-type:device_code` の分岐と RFC 8628 §3.5 の状態機械（`authorization_pending` / `slow_down` / `access_denied` / `expired_token`）
  - `routes/discovery.ts`: `device_authorization_endpoint` と `grant_types_supported` への URN 追加（RFC 8628 §4）
  - `conformance.test.ts`: デバイスフローの契約テスト

  ## 移行上の注意

  - **既定は無効です。** `--enable` を付けずに生成した OP の出力と挙動は従来どおりで、変更はありません（`conformance.test.ts` にのみ「機能が無効であること」を固定する契約テストが追加されます）
  - **検証 UI の 3 ステップにはブラウザバインディング Cookie が必須です。** `user_code` はフロー開始者に既知である前提のため、CSRF トークン単独では承認強要もログイン CSRF も防げません。この Cookie は `transaction-binding` feature とは独立に常時有効で、curl で手動実行する場合は cookie jar（`-c` / `-b`）が必要です
  - **`scope` は必須で `openid` を含む必要があります。** RFC 8628 §3.1 では OPTIONAL ですが、本 OP は認可エンドポイントと同じプロファイル制限を課します
  - **`user_code` の総当たりに対するレート制限は実装していません。** RFC 8628 §5.1 の対策のうちエントロピー（20^8）と短い TTL は実装済みですが、レート制限はデプロイ基盤の責務です
  - **Experimental です。** API・設定値・生成コードの構造はマイナーリリースでも破壊的に変更されることがあります

- fe151e8: `--enable jarm` を追加しました。JWT Secured Authorization Response Mode (JARM) の試験実装を生成コードへ組み込みます。

  有効化すると、クライアントが `response_mode=query.jwt`（または省略形 `jwt`）を指定した認可リクエストに対して、生成 OP は認可レスポンスを RS256 署名付き JWT 1 つにまとめ、`redirect_uri?response=<JWT>` で返します。JWT には JARM §2.1 の必須クレーム（`iss` / `aud` / `exp`）と、成功時は `code` / `state`、エラー時は `error` / `error_description` / `state` が入ります。素の `code` / `state` / `iss` クエリパラメータは付きません。discovery は `response_modes_supported: ['query', 'query.jwt', 'jwt']` と `authorization_signing_alg_values_supported: ['RS256']` を広告します（JARM §4）。

  ```bash
  maronn-oidc generate hono --enable jarm
  pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
  ```

  実装は `@maronn-openid-connect/experimental/jarm` にあります。**Experimental であり、API・設定・生成コードの構造はマイナーリリースでも破壊的に変更されることがあります。** 利用する場合は `@maronn-openid-connect/experimental` のバージョンを固定してください。

  移行上の注意:

  - `--enable jarm` を付けない生成物は現行とバイト単位で同一です。既存 OP を再生成しても差分は出ません
  - `--enable jarm` を付けても、クライアントが `response_mode` に `.jwt` 系の値を指定しない限り応答は従来どおりの平文クエリです。`form_post` / `fragment` など `.jwt` 以外の値は従来どおり無視します
  - `fragment.jwt` / `form_post.jwt` は非対応で、指定されると平文クエリの `invalid_request` を返します
  - 応答 JWT の暗号化（JWE）とクライアント別 `authorization_signed_response_alg` は非対応です。署名は RS256 固定です
  - JARM モードは auth transaction に記録され、ログイン・同意を挟んで store を往復します。auth transaction store の実装を差し替えている場合は、**未知のフィールドを透過的に保存する**必要があります。落とすと JARM を要求したクライアントへ静かに平文クエリで応答します
  - **Next.js ターゲットでは、ログイン・同意画面を経由する応答は平文クエリのままです。** Next.js は Server Action を Route Handler と別バンドルに分けるため、`consent/actions.ts` から署名すると `jwks_uri` が公開する鍵と一致しない JWT ができ、クライアントの署名検証が必ず失敗します。`prompt=none` と SSO 再利用は Next.js でも JARM 応答になります。Next.js 向けに生成される `routes/consent.ts` と `conformance.test.ts` もこの挙動に揃えてあります。hono / express / fastify / web-standard には、この制限はありません

### Patch Changes

- f939cfd: `--enable device-authorization-grant` で生成した OP が、デバイスコードグラントの ID Token をクライアント登録の `id_token_signed_response_alg` に従って署名するよう修正しました（OIDC Dynamic Client Registration 1.0 §4.2）。

  ## 何が起きていたか

  `routes/token.ts` の `grant_type=urn:ietf:params:oauth:grant-type:device_code` 分岐は、ID Token の署名鍵として登録鍵セットから alg を選ばず、汎用の **ACTIVE** な ID Token 鍵（`idTokenPrivateKey`）をそのまま使っていました。

  同じ生成 OP でも authorization_code / refresh_token グラントは登録鍵セットから `selectSigningKeyByAlg()` でクライアントの登録 alg に合う鍵を選ぶため、`idTokenSignedResponseAlg: 'ES256'` を登録したクライアントに対して、

  - authorization_code グラント → ES256 で署名された ID Token
  - device_code グラント → ACTIVE 鍵（既定 RS256）で署名された ID Token

  という不整合が生じていました。クライアントは登録 alg で検証するため、デバイスフローで受け取った ID Token を拒否します。あわせて `at_hash` も誤ったハッシュ関数（alg 由来）で計算されていました（OIDC Core 1.0 §3.1.3.6）。

  ## 修正内容

  デバイスコードグラント分岐に、標準グラントと同じ鍵選択を入れました。

  - 登録済み ID Token 鍵セットがある場合はクライアントの `idTokenSignedResponseAlg`（未指定は OIDC 既定の `RS256`）に合う鍵を選ぶ
  - 合う鍵が無い場合はサーバー設定エラーとして `server_error` (500) を返す（`Cache-Control: no-store` 付き）
  - 鍵セットが空の場合は従来どおり単一鍵コンテキストへフォールバックする

  `conformance.test.ts` には、RS256 を ACTIVE にしたまま RS256 + ES256 の鍵セットを登録した OP に対してデバイスフローを実行し、`id_token_signed_response_alg: ES256` のクライアントが ES256 署名の ID Token を受け取ることを固定する契約テストを追加しています。

  ## 移行上の注意

  - `id_token_signed_response_alg` を登録していないクライアント（＝既定 RS256）だけを使っている場合、生成される ID Token に変化はありません
  - 生成コードを再生成すると `routes/token.ts` と `conformance.test.ts` が更新されます

- 9daa295: `--enable jarm` で生成される OP が、JARM 応答 JWT を**登録鍵セットの RS256 鍵**で署名するようになりました。

  これまでは汎用 `signingKeyProvider` の active key（`getSigningKey()` の戻り値）をそのまま使っていました。JARM 応答 JWT の JOSE ヘッダは常に `alg: RS256` 固定なので、active key が RS256 でない構成では Web Crypto が署名を拒否し、`response_mode=query.jwt` を要求したクライアントが認可レスポンスをまったく受け取れませんでした。

  `SigningKeyProvider` は `getSigningKey()` が ES256、`getSigningKeys()` が `[RS256, ES256]` を返す実装を正式に許容しており（RS256 必須は**鍵セット**への要求です）、この構成で JARM を有効にすると認可フローが実行時に壊れていました。

  - authorize ルートと consent ルートの両方で、`selectSigningKeyByAlg(signingKeys, 'RS256')` により鍵セットから RS256 鍵を選びます
  - 鍵セットが未設定の生成コード（旧来の単一鍵コンテキストだけを配線した実装）は従来どおり動きます
  - RS256 単一鍵構成では選択結果が active key と一致するため、生成される応答 JWT は変わりません
  - 鍵セットに RS256 鍵が無い場合は、検証不能な JWT を返さず `server_error` として失敗します
  - Discovery の `authorization_signing_alg_values_supported: ['RS256']` が、実際に署名へ使う鍵の alg と一致するようになりました

  `--enable jarm` を付けない生成物に差分はありません。移行作業は不要です。

- ec6f267: 生成される `conformance.test.ts` の 2 つの不具合を修正しました。どちらも契約テストが「生成 OP の実際の挙動」を表していない状態でした。

  **1. express / fastify / nextjs の契約テストが必ず 1 件失敗していた**

  introspection の契約テスト（`should echo the jti of an access token issued by the token endpoint`）は、ストアへレコードを直接注入するのではなく実際の認可フローでトークンを発行するため `conformanceAuthorizationCode()` を呼びます。しかしこのヘルパー定義は hono のテンプレートからしか出力されていなかったため、express / fastify / nextjs の生成物では `ReferenceError: conformanceAuthorizationCode is not defined` になっていました。ヘルパーを web-standard のテンプレートからも出力するようにしています。

  これらのサンプルは `conformance.test.ts` を実行していなかった（`test` が typecheck のみ）ため気付かれていませんでした。生成物を再生成すると `conformance.test.ts` にヘルパー定義が追加されます。

  **2. Next.js + `--enable jarm` の契約テストが、生成 OP が返さない JARM 応答を固定していた**

  Next.js の consent は Server Action（`consent/actions.ts`）として動き、Route Handler とは別バンドルになるため署名鍵プロバイダの別インスタンスを持ちます。ここで署名した応答 JWT は検証できないため、Server Action は平文クエリ応答のままにしてあります（既知の制限）。

  ところがフレームワーク非依存の `routes/consent.ts` には JARM 分岐が入っており、契約テストはそちら経由で `/consent` を叩いていました。その結果、**契約テストは「ログイン・同意を挟むと署名付き JWT が返る」ことを緑で主張する一方、実際に配備される Next.js provider は平文クエリを返す**という食い違いが起きていました。

  Next.js ターゲットでは `routes/consent.ts` からも JARM 分岐を外し、生成される契約テストが平文クエリ応答を固定するようにしました。`prompt=none` と SSO 再利用（authorize ルート内で完結し、Route Handler として動く経路）は従来どおり署名付き JWT を返し、契約テストもそれを固定します。

  移行上の注意:

  - `--enable jarm` を付けない生成物は、`conformance.test.ts` へのヘルパー追加（不具合 1 の修正）を除いて現行と同一です
  - hono / express / fastify / web-standard の JARM 挙動と契約テストは変わりません
  - Next.js で `--enable jarm` を使っている場合、生成される `routes/consent.ts` から JARM 分岐が消えます。これは Server Action 側の実挙動に合わせた修正で、配備される provider の応答は変わりません

## 0.1.1

### Patch Changes

- b5ef236: Update project branding, repository metadata, and generated storage namespaces to maronn-openid-connect while preserving the maronn-oidc CLI command.

## 0.1.0

### Minor Changes

- ddd8a34: 認可トランザクションを User-Agent に Cookie で束縛する opt-in 機能を追加する（`--enable transaction-binding`）

  OIDC Core 1.0 §3.1.2.3 / §3.1.2.4 は「認可リクエストを送ってきた User-Agent の End-User」を
  認証し、その End-User から同意を得ることを前提とするが、同一性の保証手段は実装責務としている。
  これまで生成 OP は `transaction_id`（URL を流れる値）だけで login / consent を進行できたため、
  その値が漏れた場合に第三者が同意画面から CSRF トークンを取得してフローを完了させられた。
  攻撃者が自分のクライアントで開始したトランザクションへ被害者を誘導すれば、被害者 identity の
  認可コードを攻撃者のクライアントへ届かせることもできた（RP 側の `state` 検証では防げない）。

  core:

  - `AuthTransaction.bindingHash`（任意）を追加
  - `computeTransactionBindingHash()` / `validateTransactionBinding()` を追加。比較は
    `timingSafeEqual` を使い、生の秘密値ではなく SHA-256 ハッシュのみを保存する
  - `AuthTransactionErrorCode.InvalidTransactionBinding`（HTTP 400）を追加
  - `createAuthTransaction()` の第 3 引数がオプションオブジェクト
    （`{ ttlMs?, bindingHash? }`）を受け取れるようになった。数値 TTL を渡す既存の呼び出しは
    そのまま動作する

  cli（hono / express / fastify / nextjs のすべてに適用）:

  - **`--enable transaction-binding` で有効化する opt-in 機能**として追加した。stable / 実装は
    core 側だが、`AVAILABLE_FEATURES`（既定 ON）でも `EXPERIMENTAL_FEATURES` でもない第 3 の
    カテゴリ `OPTIONAL_FEATURES` を新設し、そこに置いている。既定を OFF にしたのは、
    この束縛を要求する OIDC Core / OAuth 2.1 の条文が無く、既定生成物は「仕様そのもの」に
    保ちたいため。加えて有効時は Cookie の持ち回りが要るので、curl で `/authorize` →
    `/login` と手で辿る検証フローが 400 で止まってしまう
  - 有効時: 認可エンドポイントが CSPRNG 由来の秘密値を HttpOnly / Secure / SameSite=Lax な
    `oidc_txn_<transaction_id>` Cookie で発行する。Cookie 名をトランザクションごとに分けるため、
    複数タブでの同時フローが壊れない
  - GET / POST の `/login`・`/consent` が、CSRF トークンを HTML に出す前・検証する前に束縛を
    検証する。不一致・欠落時はクライアントへリダイレクトせず OP 自身の 400 エラーページで止める
  - 完了・拒否時に該当トランザクションの Cookie を破棄する
  - 無効時（既定）: 束縛関連のコードは 1 行も生成されない。生成される `conformance.test.ts` は
    「Cookie を一切送らずにフロー全体を完走できる」ことを契約として固定するため、将来これが
    無条件で有効化されると失敗する
  - 有効時: 生成される `conformance.test.ts` に束縛の契約テストを追加した

## 0.2.0

### Minor Changes

- 14ac754: 発行するアクセストークンに `jti` を付与し、同一秒の再発行がバイト同一トークンになる問題を修正した。

  RS256（RSASSA-PKCS1-v1_5, RFC 8017 §8.2）は決定的な署名方式のため、`buildAccessTokenPayload` の
  出力に発行ごとの可変要素が無いと、`(iss, sub, aud, scope, client_id)` が同じ 2 回の発行が同じ
  壁時計秒に落ちたときにアクセストークン文字列がバイト単位で一致していた。生成 OP は
  アクセストークン文字列をキーにしてメタデータを保存するため、後の発行が先のレコードを
  黙って上書きし、次の実害が出ていた。

  - 先の grant に対する `grantId` 単位の失効（認可コード再利用検知・同意撤回・リフレッシュ
    トークンファミリー失効。OAuth 2.1 §4.1.2 / RFC 9700 §4.13）が対象トークンに届かない
  - refresh 経路の `claims: undefined` が authorization_code 経路で保存済みの `claims` を
    上書きし、UserInfo が無言で縮退する
  - rotation 後のアクセストークンが初回と同一値になり、初回トークンの漏洩をリフレッシュで
    断ち切れない

  Opaque 形式（`accessTokenFormat: 'opaque'`）は元から 256bit の乱数なので影響を受けない。

  ### @maronn-openid-connect/core

  - `AccessTokenPayload` に `jti?: string` を追加した（RFC 9068 §2.2 の REQUIRED クレーム）
  - `AccessTokenPayloadInput` に `jti?: string` を追加し、`buildAccessTokenPayload` は未指定なら
    128bit の CSPRNG 値を生成するようにした。既存の識別子を再利用したい場合のみ明示的に渡す
  - `AccessTokenIssuer.issue()` の JSDoc に「戻り値は発行ごとに一意でなければならない」という
    契約を明記した。独自 issuer に差し替える利用者向けの前提提示

  ### @maronn-openid-connect/cli

  - 生成される token route が、core が発行した `jti` をアクセストークンのメタデータとして
    保存するようにした。イントロスペクション（RFC 7662 §2.2）が `jti` を返せるようになる。
    Experimental の token-exchange を有効化した場合の交換後トークンも同様
  - 生成される `conformance.test.ts` に不変条件を追加した: rotation 後のアクセストークンが
    初回と異なること、rotation 後の ID Token が `iss` / `sub` / `aud` / `auth_time` を保持し
    `azp` を増やさないこと、同一秒に発行した 2 つの grant が互いの失効に巻き込まれないこと、
    イントロスペクションが実トークンの `jti` をエコーすること

  ### 移行上の注意

  - 発行される JWT アクセストークンに `jti` クレームが増える。トークンの claim 集合を
    完全一致で固定しているリソースサーバー側のテストは更新が必要
  - `buildAccessTokenPayload` の戻り値を `toEqual` で固定しているテストも同様に更新が必要
  - 既存の API シグネチャに破壊的変更は無い（`jti` は入力・出力とも optional）

## 0.1.0

### Minor Changes

- 45df806: CLI 生成 OpenID Provider の鍵検証、HTTP method/content-type 契約、view 拡張と HTML escaping、public client revocation、同意取り消し時の grant 失効を強化する。Hono の createApp/applyOidc を同等化し、Node adapter の複数 Set-Cookie を保持する。
- 45df806: CLI に機能トグル（--enable / --disable）を追加。pkce / refresh-token / introspection / revocation / request-object をデフォルトの全部入り構成から機能単位で増減して生成できるようにし、生成される conformance.test.ts も選択構成に合わせて無効挙動を契約テストとして固定するようにした。

  core は各エンドポイントの処理を機能単位のステップ関数として公開し、CLI 生成コードも合成関数ではなく各ステップを直接呼び出す形にした。

  - 認可リクエスト検証: クライアント解決 / redirect URI / Request Object / response_type / scope / PKCE / prompt / display / max_age / claims
  - `prompt=none`: `resolvePromptNoneSession` / `validatePromptNoneIdTokenHint` / `validatePromptNoneConsent`
  - クライアント認証: `extractClientCredentials` / `validateClientAuthMethod` / `verifyClientSecret`
  - トークンリクエスト検証: grant_type サポート / クライアント解決 / 期限 / redirect URI / PKCE / 再利用検知
  - トークンレスポンス生成: `buildAccessTokenPayload` / `computeAtHash` / `resolveAcrAmr` / `buildIdTokenPayload` / `generateIdToken`
  - UserInfo: `resolveUserInfoAccessToken` / `validateUserInfoTokenExpiration` / `validateUserInfoScope` / `validateUserInfoAudience` / `resolveUserInfoClaims` / `applyRequestedClaims`
  - Introspection: `requireIntrospectionToken` / `requireIntrospectionClient` / `resolveIntrospectionToken` / `isIntrospectionTokenActive` / `buildIntrospectionResponse`
  - Revocation: `requireRevocationToken` / `requireRevocationClient` / `resolveRevocationTarget` / `validateRevocationTokenClient` / `revokeResolvedToken` / `revokeGrantAccessTokens`

  既存の validateAuthorizationRequest / validateTokenRequest / grant 別関数 / authenticateClient / checkPromptNone / generateTokenResponse / handleUserInfoRequest / handleIntrospectionRequest / handleRevocationRequest は後方互換の合成 API として維持する。supportedGrantTypes（OP が提供する grant の制限）と requestObject.supported（OIDC Core 1.0 §6.3 の request_not_supported 拒否）オプションも追加した。既定の実行時挙動は従来と互換。

- d3658a2: Experimental 機能として Pushed Authorization Requests (PAR, RFC 9126) を追加しました。

  ### `@maronn-openid-connect/experimental`（初回リリース）

  Experimental 機能をまとめた新規 package です。`@maronn-openid-connect/core` とは独立しており、core がこの package に依存することはありません。機能ごとの subpath export で提供します（`@maronn-openid-connect/experimental/par`）。

  PAR は認可リクエストのパラメータ一式をバックチャネルで事前に預け、短命な `request_uri`（`urn:ietf:params:oauth:request_uri:<参照値>`）を引き換えに受け取る仕組みです。エンドポイント処理（`handlePushedAuthorizationRequest` と各ステップ関数）、認可エンドポイント前段の参照解決（`resolvePushedRequestUri`）、PAR 強制モード用ガード（`assertPushedRequestUsed`）、ストア契約（`PushedAuthorizationRequestStore`）を公開します。

  ### `@maronn-openid-connect/cli`

  `--enable par` を追加しました。**デフォルトでは無効**で、明示的に指定したときだけ PAR 関連のコード（`routes/par.ts`・authorize 前段フック・in-memory ストア・discovery メタデータ・conformance 契約テスト）が生成されます。`--enable par` を指定しない場合の生成結果は従来とバイト単位で同一です。

  ```bash
  maronn-oidc generate hono --enable par
  pnpm add @maronn-openid-connect/experimental
  ```

  ### 注意

  - **Experimental 機能の API は安定していません。** 関数名・引数・設定値・生成コードの構造はマイナーリリースでも破壊的に変更されることがあります。利用する場合は `@maronn-openid-connect/experimental` のバージョンを固定してください
  - 生成される in-memory ストアは検証用です。本番相当の構成では `save` / `consume`（atomic な取得＋削除）を満たす永続ストアへ差し替えてください
  - PAR + Request Object（JAR）の併用、クライアント単位の `require_pushed_authorization_requests`、レート制限・リクエストサイズ上限（413 / 429）は非対応です

  ### 移行上の注意

  既存利用者に必要な対応はありません。`--enable par` を指定しない限り生成結果・依存関係・案内文言は変わらず、`@maronn-openid-connect/core` にも変更はありません。

- d4dac9b: Experimental 機能として OAuth 2.0 Token Exchange (RFC 8693) を追加しました。

  ### `@maronn-openid-connect/experimental`

  トークンエンドポイントの `urn:ietf:params:oauth:grant-type:token-exchange` grant を処理する `@maronn-openid-connect/experimental/token-exchange` を追加しました（既存の `./par` と並ぶ subpath export で、機能間でコードは共有しません）。

  手元のアクセストークン（`subject_token`）を、scope を縮小し audience を差し替えた新しいアクセストークンへ交換できます。交換で権限は単調に狭まります（scope は部分集合・audience は許可リスト内・有効期限は subject_token の残存期間以下・`sub` は変更不可）。

  合成関数 `processTokenExchangeRequest` と、その構成要素であるステップ関数（`authorizeTokenExchangeClient` / `parseTokenExchangeParams` / `resolveSubjectToken` / `validateExchangeScope` / `resolveExchangeTarget` / `computeExchangedTokenLifetime` / `buildTokenExchangeResponse`）、エラー型 `TokenExchangeError`（RFC 8693 §2.2.2 の `invalid_target` を含む）を公開します。トークンの発行と保存はこの package では行わず、core の既存部品（`buildAccessTokenAudience` / `buildAccessTokenPayload` / `AccessTokenIssuer`）と組み合わせて使います。

  初期スコープは **impersonation 型の交換**（`actor_token` なし）に限定します。

  ### `@maronn-openid-connect/cli`

  `--enable token-exchange` を追加しました。**デフォルトでは無効**で、明示的に指定したときだけ交換関連のコード（トークンルートの grant 分岐・`tokenExchangeConfig`・`TokenExchangeError` の catch 分岐・discovery の `grant_types_supported`・サンプルクライアントの `grantTypes`・conformance 契約テスト）が生成されます。新しいエンドポイントは増えず、既存のトークンエンドポイントに分岐が 1 つ加わるだけです。

  ```bash
  maronn-oidc generate hono --enable token-exchange
  pnpm add @maronn-openid-connect/experimental
  ```

  `--enable par` と併用でき、両方指定してもインストール案内に `@maronn-openid-connect/experimental` が重複することはありません。

  ### 注意

  - **Experimental 機能の API は安定していません。** 関数名・引数・設定値・生成コードの構造はマイナーリリースでも破壊的に変更されることがあります。利用する場合は `@maronn-openid-connect/experimental` のバージョンを固定してください
  - 生成直後の `tokenExchangeConfig.allowedTargets` は**空**です（安全側デフォルト）。`audience` / `resource` を指定する交換はすべて `invalid_target` になるので、下流サービスの識別子を明示的に追加してください。scope 縮小・期限短縮のみの交換は空のままでも成立します
  - 交換は **confidential client 限定**です。public client は交換 URN を登録していても `unauthorized_client` で拒否されます（RFC 8693 §2.1 の「クライアント認証を省くと窃取トークンを STS 経由で増幅できる」という注記に対する設計判断）
  - 無効な `subject_token` は RFC 8693 §2.2.2 に従い **`invalid_request`** で拒否されます（`invalid_grant` ではありません）。失敗の種別は `error_description` からも区別できません（存在確認オラクルの防止）
  - delegation（`actor_token` / `act` / `may_act` claim）、`audience` / `resource` の複数指定、access token 以外の `subject_token_type` / `requested_token_type`、外部 IdP 発行トークンの受け入れ、交換時の ID Token / refresh token 発行は非対応です
  - 認可時の `claims` パラメータ（OIDC Core 1.0 §5.5）は交換後トークンへ継承されません。交換後トークンで UserInfo を呼ぶと scope ベースのクレームのみが返ります

  ### 移行上の注意

  既存利用者に必要な対応はありません。`--enable token-exchange` を指定しない限り生成結果・依存関係・案内文言は変わらず（バイト単位で同一）、`@maronn-openid-connect/core` にも変更はありません。

### Patch Changes

- 95c9efe: `@maronn-openid-connect/experimental` の `@maronn-openid-connect/core` 参照を `dependencies` から `peerDependencies`（`>=0.1.0 <1.0.0`）へ移した。experimental は core の `AuthorizationError` / `TokenError` を `instanceof` で判定し、resolver / store を CLI 生成コードと受け渡しするため、アプリ内の core インスタンスが 1 つである必要がある。`dependencies` のままだと利用者の core とバージョンがずれたときに core が二重インストールされ、`instanceof` 判定が静かに false になって、本来 `invalid_request` を返す場面が 500 になり得た。バージョン番号の一致は要求しない（experimental は core より速く publish される想定）。

  あわせて次を修正した。

  - `packages/experimental` の publish 対象に LICENSE が含まれていなかったため追加
  - 3 パッケージの `exports` を TypeScript の推奨どおり `types` 条件を先頭へ移動
  - `packages/experimental` の `main` / `types` がビルドされない `dist/index.js` を指していたため削除（公開は `./par` の subpath export のみ）
  - core の minor / major リリース時に experimental も同時にリリースすることを CI で強制する `pnpm run test:release-contract` を追加

- 61cb185: Next.js 生成コードの SQLite ストレージバックエンドに `PRAGMA busy_timeout` を設定し、`next build` のページデータ収集など複数プロセスが同一ファイルへ同時アクセスした際に `SQLITE_BUSY`（database is locked）で即座に失敗せず待機できるようにした。

## 0.1.1

### Patch Changes

- 9eadae8: sample version up

## 0.1.0

### Minor Changes

- 70035b4: Make the login / consent UI injectable and generate native React pages for Next.js.

  - All frameworks: the generated provider now accepts a `views?: Partial<Views>`
    option (`createApp` / `applyOidc`) so you can inject your own login / consent /
    error UI from outside instead of editing `views.ts`. The default views remain
    the default. `views.ts` now exports `defaultViews` and a `createViews()` helper.
  - Next.js: login and consent are generated as real App Router `page.tsx` React
    Server Components backed by Server Actions (`actions.ts`) instead of HTML-string
    Route Handlers, so the generated code can leverage JSX, components and the rest
    of the React/Next.js ecosystem.

### Patch Changes

- d63778f: Trusted Package と Changelog によるライブラリ発行
