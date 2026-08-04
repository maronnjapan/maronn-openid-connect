# @maronn-openid-connect/experimental

## 0.0.3

### Patch Changes

- b5ef236: Update project branding, repository metadata, and generated storage namespaces to maronn-openid-connect while preserving the maronn-oidc CLI command.

## 0.0.2

### Patch Changes

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

## 0.0.4

### Patch Changes

- 14ac754: `@maronn-openid-connect/core` の minor リリース（アクセストークンへの `jti` 付与）に合わせた同時リリース。

  `packages/experimental/src` 自体に変更は無い。experimental は core を広い peer range で参照して
  いるため、core が minor で進むと「公開済みの古い experimental が、まだ組み合わせて検証していない
  新しい core を受け入れる」状態になる。RELEASE.md「core の minor / major では experimental も
  一緒にリリースする」に従い、最新 core と組み合わせて検証済みの experimental を同時に publish する。

  token-exchange が発行する交換後アクセストークンにも core 由来の `jti` が入り、同じ subject_token
  から同一秒に 2 回交換しても別トークンになる（生成 OP 側の contract テストで固定済み）。

## 0.0.3

### Patch Changes

- `packages/experimental/src` の変更をリリースする。experimental のバージョンは変更内容に関わらず patch を 1 つ上げるだけに固定しており、未リリースの変更が複数たまっている場合も 1 回の patch に吸収する。

  このリリースに含まれる変更:

  - packages/experimental/src/par/index.ts
  - packages/experimental/src/par/par-request.ts
  - packages/experimental/src/par/resolve-request-uri.ts
  - packages/experimental/src/par/store.ts
  - packages/experimental/src/token-exchange/index.ts
  - packages/experimental/src/token-exchange/token-exchange-request.ts

## 0.0.2

### Patch Changes

- c89b96d: 公開済みパッケージが利用者の環境で読み込めなかった 2 件を修正した。

  ### `@maronn-openid-connect/core`: Node の ESM ローダで解決できる形で publish する

  `packages/core` は `"type": "module"` だが、`src` の相対 import に拡張子が無く、
  `tsconfig.json` の `moduleResolution` が `bundler` だったため、`dist` にも拡張子なしの
  specifier がそのまま emit されていた。Node の ESM ローダは拡張子の補完を行わないので、
  公開済みの `@maronn-openid-connect/core@0.0.1` は `import '@maronn-openid-connect/core'` した時点で
  `ERR_MODULE_NOT_FOUND: Cannot find module '.../dist/authorization-request'` になり、
  **バンドラを通さない Node 環境では一切読み込めない状態だった**。

  `samples/*` はすべて esbuild でバンドルしてから起動しており、esbuild は拡張子を補完するため
  リポジトリ内の CI・E2E・conformance では発覚しなかった。

  - `packages/core/src` の相対 import / `export ... from` / 型の `import('./x')` すべてに
    `.js` 拡張子を付けた
  - `packages/core` と `packages/experimental` の `tsconfig.json` を
    `module` / `moduleResolution` ともに `NodeNext` へ変更し、拡張子の付け忘れを
    コンパイル時に落とすようにした（`bundler` に戻すと同じ状態を再び publish できてしまう）

  実行時の挙動と公開 API に変更はない。

  ### `@maronn-openid-connect/experimental`: core の peer range の下限を `>=0.1.0` へ上げる

  `@maronn-openid-connect/experimental` は core のステップ関数
  （`extractClientCredentials` / `resolveAuthenticatedTokenClient` /
  `validateClientAuthMethod` / `verifyClientSecret`）を import しているが、これらを export する
  core はまだ publish されていなかった。それにもかかわらず peer range の下限が `>=0.0.1` の
  ままだったため、`@maronn-openid-connect/experimental@0.0.1` と `@maronn-openid-connect/core@0.0.1` の組み合わせが
  インストールできてしまい、バンドル時に esbuild が次のエラーで落ちていた。

  ```
  ✘ [ERROR] No matching export in "node_modules/@maronn-openid-connect/core/dist/index.js"
    for import "extractClientCredentials"
  ```

  下限を `>=0.1.0 <1.0.0` へ上げ、これらを export する core 以降とだけ組み合わせられるようにした。
  古い core を使っている場合はインストール時に `unmet peer` として検出できる。

  あわせて、この下限の管理を手運用から CI へ移した。`pnpm run test:release-contract`
  （`.github/scripts/verify-release-contract.mjs`）に、**experimental の peer range の下限が
  「次に publish される core のバージョン」以上であること**を検査する
  `assertExperimentalCorePeerRangeCoversNextCore` を追加した。experimental はモノレポ内の core
  だけを相手にビルド・テストされるため、それより古い core を下限に据えることは「試していない
  組み合わせ」を許可宣言することに等しい。RELEASE.md「peer range は『下限』を宣言する」に
  書かれていた手順を機械化したもので、下限の上げ忘れは CI で止まる。

  ### 利用者への影響

  `@maronn-openid-connect/core@0.0.1` および `@maronn-openid-connect/experimental@0.0.1` は上記のとおり
  組み合わせて利用できない。本リリース以降のバージョンへ更新すること。

- 95c9efe: `@maronn-openid-connect/experimental` の `@maronn-openid-connect/core` 参照を `dependencies` から `peerDependencies`（`>=0.1.0 <1.0.0`）へ移した。experimental は core の `AuthorizationError` / `TokenError` を `instanceof` で判定し、resolver / store を CLI 生成コードと受け渡しするため、アプリ内の core インスタンスが 1 つである必要がある。`dependencies` のままだと利用者の core とバージョンがずれたときに core が二重インストールされ、`instanceof` 判定が静かに false になって、本来 `invalid_request` を返す場面が 500 になり得た。バージョン番号の一致は要求しない（experimental は core より速く publish される想定）。

  あわせて次を修正した。

  - `packages/experimental` の publish 対象に LICENSE が含まれていなかったため追加
  - 3 パッケージの `exports` を TypeScript の推奨どおり `types` 条件を先頭へ移動
  - `packages/experimental` の `main` / `types` がビルドされない `dist/index.js` を指していたため削除（公開は `./par` の subpath export のみ）
  - core の minor / major リリース時に experimental も同時にリリースすることを CI で強制する `pnpm run test:release-contract` を追加

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
