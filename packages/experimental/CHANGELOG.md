# @maronn-openid-connect/experimental

## 0.0.4

### Patch Changes

- 06ad02d: OAuth 2.0 Device Authorization Grant (RFC 8628) を `@maronn-openid-connect/experimental/device-authorization-grant` として追加しました。

  ブラウザを持たない・文字入力が困難なデバイス（スマート TV / CLI ツール / IoT 機器）を、別デバイスのブラウザで認可するグラントです。`redirect_uri` が登場しないため、リダイレクト起点の攻撃面を持ちません。

  - `processDeviceAuthorizationRequest`: RFC 8628 §3.1 / §3.2 のデバイス認可エンドポイント処理。`validateDeviceGrantAllowed` / `validateDeviceAuthorizationScope` / `applyOfflineAccessPolicy` / `createDeviceAuthorizationRecord` / `buildDeviceAuthorizationResponse` の合成で、ステップ関数を個別に呼べば検証の差し替え・削除ができます
  - `generateUserCode` / `normalizeUserCode` / `generateUniqueUserCode`: §6.1 の base-20 文字種 `BCDFGHJKLMNPQRSTVWXZ` から 8 文字を rejection sampling（modulo bias 回避）で生成し、既存 pending レコードとの衝突を確認して再生成します
  - `findPendingRecordByUserCode` / `issueVerificationBinding` / `validateVerificationBinding` / `validateVerificationCsrfToken` / `recordDeviceLoginFailure` / `approveDeviceAuthorization` / `denyDeviceAuthorization`: §3.3 の検証 UI が呼ぶステップ関数群
  - `processDeviceCodeGrant` / `evaluateDeviceCodeState`: §3.5 の状態機械。`expired_token` → `slow_down`（レコードの interval を +5）→ `authorization_pending` → `access_denied` → 承認済み（atomic な `consume` による単回使用）の順で評価します。`now` を注入して期限・interval の境界をテストできます
  - `DeviceAuthorizationStore`: `save` / `findByDeviceCode` / `findByUserCode` / `update` / `delete` / `consume` の 6 メソッド契約。`consume` の atomic 要件と、期限切れレコードの自主破棄の猶予を型コメントに明記しています
  - `DeviceAuthorizationError` / `DeviceVerificationError`: 前者は RFC 8628 §3.5 が登録した 4 コードと RFC 6749 §5.2 の既存値のみを扱い常に 400、後者は検証 UI の 401 / 403 を表します

  **ブラウザバインディングが CSRF 防御の主役です。** `user_code` はフロー開始者（＝攻撃者になり得る主体）が設計上必ず知っている識別子なので、レコード紐付きの CSRF トークンだけでは承認強要もログイン CSRF も防げません。`issueVerificationBinding` が発行する bindingSecret の生値はブラウザの HttpOnly Cookie にのみ置き、レコードには SHA-256 ハッシュだけを保存します。

  依存は `@maronn-openid-connect/core` の公開 API（`generateRandomString` / `sanitizeErrorDescription`）のみで、他の Experimental 機能とはコードを共有していません。

  **Experimental であり、API はマイナーリリースでも破壊的に変更されることがあります。** `scope` は必須かつ `openid` 必須（RFC 8628 §3.1 の scope 省略には非対応）、`nonce` / `prompt` / `resource` などのパラメータは受け付けず、`user_code` の総当たりに対するレート制限（§5.1）はデプロイ基盤の責務としています。

- 1eca98c: JWT Secured Authorization Response Mode (JARM) を `@maronn-openid-connect/experimental/jarm` として追加しました。

  - `resolveJarmResponseMode`: 認可リクエストの `response_mode` を `jarm`（`query.jwt` / 省略形 `jwt`）/ `plain`（未指定・`query`・`.jwt` 系以外）/ `unsupported-jwt-mode`（`fragment.jwt` / `form_post.jwt` など）の判別共用体へ分類します
  - `createJarmResponseJwt`: 認可レスポンスパラメータを JARM §2.1 のクレーム構造（`iss` / `aud` / `exp` ＋ `code` / `state` または `error` 系）で RS256 署名付き JWT にします。値が `undefined` のパラメータはクレームに含めず、`iss` / `aud` / `exp` はパラメータから上書きできません
  - `buildJarmRedirectUrl`: `redirect_uri` に `response` パラメータのみを付けた URL を返します（JARM §2.3.1）
  - `assertJarmLifetimeSeconds`: 応答 JWT の寿命を 5〜600 秒（JARM §2.1 の最大 10 分 RECOMMENDED 内）に制限します
  - `JarmAuthTransactionFields`: auth transaction に JARM モードを相乗りさせる交差型です

  JWS 生成は Web Crypto API による自前実装で、`@maronn-openid-connect/core` の公開 API（`SigningKey` 型）にのみ依存します。他の Experimental 機能とはコードを共有していません。

  **Experimental であり、API はマイナーリリースでも破壊的に変更されることがあります。** `fragment.jwt` / `form_post.jwt`、応答 JWT の暗号化（JWE）、クライアント別 `authorization_signed_response_alg` は非対応です。

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
