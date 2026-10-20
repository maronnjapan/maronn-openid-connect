# @maronn-openid-connect/core

## 0.9.0

### Minor Changes

- 16f795b: クライアントが用途ごとに登録した公開鍵を引く `ClientKeyResolver` を追加し、1 つのクライアントに複数のクライアント認証方式を登録できるようにする
  
  - クライアントの認証方式は、使ってよい方式の一覧 `TokenClientInfo.tokenEndpointAuthMethods` で登録する。`client_secret_basic` と `client_secret_post` を並べると、どちらの方式でも同じシークレットで認証できる。省略すると `['client_secret_basic']` になり、`['none']` は public client を表す。`none` をほかの方式と並べた登録は、public client かどうかが決まらないので例外を投げる。`validateClientAuthMethod()` は、使われた方式が一覧のどれかであれば通す。方式の型 `ClientAuthMethod`、一覧を返す `selectRegisteredClientAuthMethods()`、public client かどうかを返す `isPublicTokenClient()`、照合だけを行う `validateClientAuthMethodAllowed()` も追加した
  - クライアントが用途ごとに登録した公開鍵を返す `ClientKeyResolver`（`findClientKeys(clientId, purpose)`）と、用途の型 `ClientKeyPurpose` を追加した。用途は鍵を使う処理の名前で、`request_object`（署名付き Request Object、OIDC Core 1.0 §6.3.2）、`private_key_jwt`（OIDC Core 1.0 §9）、`dpop`（RFC 9449）などの文字列で、ほかの用途も足せる。鍵を使う処理は、保存先を知らずに自分の用途の鍵だけを受け取る。core で鍵を受け取るのは `resolveRequestObjectParams()` だけで、private_key_jwt と DPoP の検証は持たない
  - クライアントごとの「用途から JWK Set への対応」（`ClientKeysByPurpose`）を返す関数から `ClientKeyResolver` を作る `createClientKeyResolver()` を追加した。呼ばれるたびにその関数を呼ぶので、返す鍵を変えれば次の呼び出しから効く
  
  ## 破壊的変更
  
  - **core: `TokenClientInfo.tokenEndpointAuthMethod` を削除した**。認証方式は一覧の `tokenEndpointAuthMethods` で登録する。`tokenEndpointAuthMethod: 'client_secret_post'` は `tokenEndpointAuthMethods: ['client_secret_post']` に、public client の `tokenEndpointAuthMethod: 'none'` は `tokenEndpointAuthMethods: ['none']` になる
  - **core: `selectRegisteredClientAuthMethod()` と `validateClientAuthMethodMatch()` を削除した**。一覧を返す `selectRegisteredClientAuthMethods()` と、一覧と照合する `validateClientAuthMethodAllowed()` を使う。public client かどうかは `isPublicTokenClient()` で確かめる。登録していない方式を使ったリクエストの `error_description` は `Client authentication method is not registered for the client` になった
  - **core: `ClientInfo.jwks` を削除した**。クライアントの公開鍵はクライアント情報に入れず、鍵を使う処理が `ClientKeyResolver` から用途ごとに引く。`resolveRequestObjectParams()` は第 2 引数のクライアントを受け取らず、`request_object` の用途の鍵を `options.jwks` で受け取る
  - **core: `requireConfidentialIntrospectionCaller()` は、クライアントの `tokenEndpointAuthMethods` を見る**
  - **experimental: Dynamic Client Registration の `DynamicallyRegisteredClient` は、`tokenEndpointAuthMethod` の代わりに `tokenEndpointAuthMethods` を持つ**。登録時の `token_endpoint_auth_method` を 1 つだけ入れた一覧で、登録応答の `token_endpoint_auth_method` はその値になる
  
  experimental の CIBA、Token Exchange、ID-JAG は、public client を `isPublicTokenClient()` で判定する。google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。
- eb08dd6: Implicit Flow（OIDC Core 1.0 §3.2）の `response_type=id_token token` と `id_token` を検証し、認可レスポンスを組み立てる関数を追加する
  
  - `response_type` の値を比べる関数を追加した。`normalizeResponseType()` は値を `code`、`id_token`、`token` の順に並べ直す（値の順序は問わない。OAuth 2.0 Multiple Response Type Encoding Practices §1.2）。`responseTypeIncludes()` は値を含むかを、`isImplicitResponseType()` は Implicit Flow の response type かを、`defaultResponseModeOf()` は既定の応答モード（トークンを返す response type はフラグメント。同 §2.1 / §3 / §5）を返す。型 `AuthorizationResponseType` と定数 `IMPLICIT_RESPONSE_TYPES` も追加した
  - Implicit Flow の要求が満たすべき条件を確かめる `requireNonce()`（`nonce` は必須）、`validateImplicitResponseMode()`（`response_mode=query` を拒否する）、`validateImplicitRedirectUri()`（https か、public client のループバックの http に限る）と、レスポンスを組み立てる `returnsScopeClaimsInIdToken()`、`buildImplicitResponseParameters()`、`buildFragmentResponseUrl()` を追加した
  - `validateResponseType()` と `validateSupportedResponseType()` は、OP が答える response type の一覧を最後の引数で受け取る。既定は `['code']` で、これまでと同じく `code` だけを受け付ける。クライアントの登録と Request Object の `response_type` は、値の順序を問わずに照合する
  - `applyOfflineAccessPolicy()` は、認可コードを返さない response type の要求から、許可条件のコールバックに関わらず `offline_access` を取り除く（OIDC Core 1.0 §11）
  - `AccessTokenInfo` に `transactionId` を追加した。認可コードを経ずに発行したトークン（Implicit Flow）が、どのトランザクションから出たかを表す
  
  ## 破壊的変更
  
  - **`ValidatedAuthorizationRequest.responseType` の型**：`'code'` から `AuthorizationResponseType`（`'code' | 'id_token' | 'id_token token'`）に広がった。`validateResponseType()` と `validateSupportedResponseType()` の戻り値の型も同じである。`'code'` を前提にした代入や比較は、型を `AuthorizationResponseType` にするか、`responseTypeIncludes(responseType, 'code')` で分ける
  
  experimental と google-login は、core の minor リリースに合わせた同時リリースのみで、機能変更はない。
- 61248a4: `claims` リクエストパラメータの `id_token` メンバー（OIDC Core 1.0 §5.5）で個別に要求されたクレームを、ID Token の payload に加える `applyRequestedIdTokenClaims()` を追加する
  
  - `applyRequestedIdTokenClaims(payload, userClaims, claims)` は、`buildIdTokenPayload()` が組み立てた payload に、`claims.id_token` が要求するクレームを End-User のクレームから足した新しい payload を返す。`value` / `values` を指定したクレームは実値が一致するときだけ足し、値の無いクレームと一致しないクレームはエラーにせず省く（§5.5.1）
  - ID Token 自身のクレーム（`iss` / `sub` / `aud` / `exp` / `iat` / `auth_time` / `nonce` / `acr` / `amr` / `azp` / `at_hash` / `c_hash`）は End-User のクレームから取らず、payload がすでに持つクレームも置き換えない。`acr` の要求はこれまでどおり `resolveAcrAmr()` が扱う（§5.5.1.1）
  
  experimental と google-login は、core の minor リリースに合わせた同時リリースのみで、機能変更はない。

## 0.8.0

### Minor Changes

- d61fb97: 認可リクエストの `acr_values` を検証するステップ関数を追加し、アクセストークンとイントロスペクションで `acr` を扱えるようにする
  
  - ステップ関数 `validateAcrValuesParameter()` を追加した。`acr_values`（OIDC Core 1.0 §3.1.2.1）は省略してよく、空文字と空白だけの値は省略として扱う。空白区切りの各値が RFC 6749 §3.3 の scope-token と同じ文字（`"` と `\` を除く、表示できる ASCII 文字）だけでできていなければ `invalid_request`（redirectable）で拒否し、通れば優先順を保ったまま 1 つの空白で連結し直した値を返す。値を分ける `parseAcrValues()` と、各値の構文を検査する `validateAcrValues()` も個別に呼べる
  - 要求された acr 値のうち最も優先する値（先頭の値）を返す `selectPreferredAcr()` を追加した。AcrResolver を使わずに、要求された値を acr にするときに使う
  - `buildAccessTokenPayload()` の入力に `acr` を追加した。指定すると、アクセストークンの payload に `acr` クレーム（RFC 9068 §2.2.1）が入る。`AccessTokenPayload` にも `acr` を足した
  - `AccessTokenInfo.acr` を追加した。`buildIntrospectionResponse()` は、アクセストークンに保存された `acr` をレスポンスに含める（RFC 9470 §6.2）
  
  experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。

## 0.7.0

### Minor Changes

- e9e6305: client_secret をハッシュで登録できるようにし、クライアントに登録した scope を検証できるようにする
  
  - `TokenClientInfo.clientSecretHash` を追加した。client_secret の SHA-256（base64url、パディング無し）を登録すると、`verifyClientSecret()` は提示された client_secret のハッシュをこの値と定数時間で比べ、`clientSecret` は使わない。DB に client_secret を平文で置かずに済む
  - 登録する値を作る `hashClientSecret()` と、照合だけを行うステップ関数 `verifyClientSecretHash()` を追加した。`verifyClientSecretHash()` は client_secret が提示されていなければ、空文字のハッシュが登録されていても通さない
  - `ClientInfo.scope` と `TokenClientInfo.scope`（RFC 7591 §2 の `scope`。クライアントが要求してよい scope の一覧）を追加した。省略したクライアントには制限を掛けない
  - 一覧に無い scope の要求を `invalid_scope` で拒否するステップ関数 `validateClientScope()` と、一覧に無い scope を返す `findUnregisteredClientScopes()` を追加した
  - `completeAuthTransaction()` が返す `AuthorizationResponseParams` に `transactionId` を加え、`createAuthorizationCode()` / `buildAuthorizationCodeData()` はそれを `AuthorizationCodeData.transactionId` へ引き継ぐ。ストアは、どの認可リクエストから発行したコードかを記録できる。`transactionId` は認可レスポンスのパラメータではないので、リダイレクト URL には載せない
  
  SHA-256 は速いハッシュなので、短い値や推測できる値は総当たりで元に戻される。`clientSecretHash` を使うクライアントの client_secret は、CSPRNG で作った十分長い値にすること。
  
  experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。

## 0.6.0

### Minor Changes

- 31c20a1: Expose smaller validation and transformation steps for authorization, token grants, client credentials, authentication transactions, introspection, UserInfo, JWT signing, and ID Token hints.
  Split the remaining step functions into single-purpose parts that take literal values: prompt and PKCE parameter checks, scope parsing, stored-record presence checks, redirect URI and PKCE binding checks at the token endpoint, refresh token session and scope checks, client authentication method selection and secret comparison, prompt=none session and consent checks, ID Token payload claim checks, and builders for auth transactions and authorization code data that take the clock and generated values as arguments.
  Narrow step inputs to the fields and store operations they actually use so callers can pass literals or small adapters.
  Existing flows compose the new steps while preserving validation order, error semantics, and token-family revocation.
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

## 0.5.0

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

## 0.4.1

### Patch Changes

- ed8c5a5: 空文字列の `client_secret` を「未提示」として扱う（RFC 6749 §3.2）
  
  `extractClientCredentials` が値なしのフォームフィールド（`client_secret=`）を client_secret_post の資格情報として数えていたため、public client が `client_id=x&client_secret=` を送ると方式不一致で拒否され、`Authorization: Basic` と空の `client_secret` フィールドの併存が多重認証方式として拒否されていた。RFC 6749 §3.2 の「値なしで送られたパラメータは省略として扱う（MUST）」に従い、抽出時に空文字列を未提示へ正規化する。confidential client が空の `client_secret` だけを送った場合は、従来どおり invalid_client で拒否される（拒否理由が「方式不一致」から「認証必須」になる）。CLI 生成の conformance テストにこの挙動を固定する契約テストを追加。

## 0.4.0

### Minor Changes

- 9df8d94: introspection エンドポイントで public client の client_id 単独提示を拒否する
  
  これまで生成 OP の introspection ルートは token エンドポイントと同じクライアント認証パイプラインを使っており、`token_endpoint_auth_method: 'none'` で登録されたクライアントは「資格情報を提示していないこと」の確認だけで通過していた。public client の client_id は公開情報なので、これを認証済み呼び出し元として扱うと誰でもトークンを走査できる（RFC 7662 §2.1 は呼び出し元の認可を要求し、RFC 9701 §5 は未認証リクエストの拒否を MUST とする）。
  
  - core に導入ステップ関数 `requireConfidentialIntrospectionCaller` を追加した。登録方式が `'none'` のクライアントを `invalid_client`（401 + `WWW-Authenticate: Basic realm="Client Authentication"`）で拒否し、それ以外（既定の `client_secret_basic` を含む）は通す
  - CLI が生成する introspection ルートは、クライアント認証パイプラインの直後・トークン解決の前にこのステップを呼ぶ。`--enable jwt-introspection-response` の JWT 経路もこの拒否より後にあるため、Accept ヘッダーで迂回できない
  - revocation ルートは変更していない（RFC 7009 §2.1 は public client が自分のトークンを失効させることを正当に許す）
  
  experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。

## 0.3.0

### Minor Changes

- c1911c7: Request Object の検証失敗を `invalid_request_object`（OIDC Core 1.0 §6.3）で返す
  
  これまで `request` パラメータの Request Object がパース・署名検証に失敗すると、汎用の `invalid_request` に潰して返していた。OIDC Core 1.0 §6.3 が定義するとおり `invalid_request_object` を返すよう変更し、`request_not_supported`（Request Object の使用をやめるべき）と `invalid_request_object`（Request Object の生成処理を直すべき）をクライアントが区別できるようにした。
  
  - `AuthorizationErrorCode` に `InvalidRequestObject`（`invalid_request_object`）と `InvalidRequestUri`（`invalid_request_uri`）を追加した。既存の enum メンバーとシリアライズ値は変えていない
  - `resolveRequestObjectParams` が `RequestObjectError` を `invalid_request_object` へ変換するようになった。壊れた Request Object 内の redirect_uri を信用しない非リダイレクト挙動（OP 上でのエラー表示、state 非 echo）は従来どおり
  - CLI 生成の `conformance.test.ts` に、壊れた Request Object が非リダイレクトの `invalid_request_object` エラーページになる契約テストを追加した
  
  `invalid_request` の受信を前提にしていたクライアントは、Request Object 起因の失敗で `invalid_request_object` を受け取るようになる。

## 0.2.0

### Minor Changes

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
