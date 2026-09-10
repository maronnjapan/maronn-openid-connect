# @maronn-openid-connect/cli

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
