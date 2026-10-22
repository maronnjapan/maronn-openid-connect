# @maronn-openid-connect/google-login

## 0.0.11

### Patch Changes

- 9b8d022: Hybrid Flow（OIDC Core 1.0 §3.3）の `response_type=code id_token`、`code token`、`code id_token token` に答えるための部品関数を追加する
  
  - `HYBRID_RESPONSE_TYPES` と `isHybridResponseType` を追加する。`AuthorizationResponseType` にこの 3 つの値が加わり、`validateResponseType` の最後の引数に `HYBRID_RESPONSE_TYPES` を加えて渡すと受け付ける
  - `requireHybridNonce` を追加する。認可エンドポイントが ID Token を返す `code id_token` と `code id_token token` では `nonce` を必須にし（§3.3.2.11）、返さない `code token` では Authorization Code Flow と同じく任意のままにする
  - `validateHybridResponseMode` を追加する。`response_mode=query` と、OP がその要求に答えない応答モードを `invalid_request` で拒否する（OAuth 2.0 Multiple Response Type Encoding Practices §5）
  - `buildHybridResponseParameters` を追加する。認可コードと、発行した ID Token と Access Token を載せた認可レスポンスのパラメータを組み立てる（§3.3.2.5）
  - `computeCHash` を追加し、`buildIdTokenPayload` に `cHash` を渡せるようにする。認可コードと一緒に返す ID Token の `c_hash` を、`at_hash` と同じ求め方で計算する（§3.3.2.11）
  - `returnsScopeClaimsInIdToken` は、`code` を含む response_type に false を返すようになる。認可コードはトークンエンドポイントで Access Token になり、scope のクレームは UserInfo エンドポイントが返すためである（§5.4）。これまでは `code id_token` に true を返していた

## 0.0.10

### Patch Changes

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
- b02ebc6: README の「CLI での利用」と「生成コードへの配線」を、`apps/hono` と `apps/nextjs` から抽出する CLI の生成コードに合わせる
  
  ドキュメントだけの変更で、パッケージの API と挙動は変わらない。
  
  - 生成物の表を、`--enable google-login` が加える `features/google-login/`（Next.js は `_oidc-provider/features/google-login/` と `(google-login)/login/google/route.ts`）のファイルで書き直した。無くなった `routes/login.ts`、`store.ts` の `googleLoginNonceStore`、`userStore.linkGoogleAccount()` の記述を消した
  - Google アカウントの subject は `--db` の有無によらずランダムな ID になり、Google の sub は Federated_identity に記録すると直した（`--db` 無しで `google:<sub>` になる、という記述は古い生成コードのもの）
  - 配線例の import を、生成コードから無くなった `./store.js` のストアと `defaultProviderConfig` ではなく、アプリ側のモジュールから取るようにした

## 0.0.9

### Patch Changes

- d61fb97: 認可リクエストの `acr_values` を検証するステップ関数を追加し、アクセストークンとイントロスペクションで `acr` を扱えるようにする
  
  - ステップ関数 `validateAcrValuesParameter()` を追加した。`acr_values`（OIDC Core 1.0 §3.1.2.1）は省略してよく、空文字と空白だけの値は省略として扱う。空白区切りの各値が RFC 6749 §3.3 の scope-token と同じ文字（`"` と `\` を除く、表示できる ASCII 文字）だけでできていなければ `invalid_request`（redirectable）で拒否し、通れば優先順を保ったまま 1 つの空白で連結し直した値を返す。値を分ける `parseAcrValues()` と、各値の構文を検査する `validateAcrValues()` も個別に呼べる
  - 要求された acr 値のうち最も優先する値（先頭の値）を返す `selectPreferredAcr()` を追加した。AcrResolver を使わずに、要求された値を acr にするときに使う
  - `buildAccessTokenPayload()` の入力に `acr` を追加した。指定すると、アクセストークンの payload に `acr` クレーム（RFC 9068 §2.2.1）が入る。`AccessTokenPayload` にも `acr` を足した
  - `AccessTokenInfo.acr` を追加した。`buildIntrospectionResponse()` は、アクセストークンに保存された `acr` をレスポンスに含める（RFC 9470 §6.2）
  
  experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。

## 0.0.8

### Patch Changes

- e9e6305: client_secret をハッシュで登録できるようにし、クライアントに登録した scope を検証できるようにする
  
  - `TokenClientInfo.clientSecretHash` を追加した。client_secret の SHA-256（base64url、パディング無し）を登録すると、`verifyClientSecret()` は提示された client_secret のハッシュをこの値と定数時間で比べ、`clientSecret` は使わない。DB に client_secret を平文で置かずに済む
  - 登録する値を作る `hashClientSecret()` と、照合だけを行うステップ関数 `verifyClientSecretHash()` を追加した。`verifyClientSecretHash()` は client_secret が提示されていなければ、空文字のハッシュが登録されていても通さない
  - `ClientInfo.scope` と `TokenClientInfo.scope`（RFC 7591 §2 の `scope`。クライアントが要求してよい scope の一覧）を追加した。省略したクライアントには制限を掛けない
  - 一覧に無い scope の要求を `invalid_scope` で拒否するステップ関数 `validateClientScope()` と、一覧に無い scope を返す `findUnregisteredClientScopes()` を追加した
  - `completeAuthTransaction()` が返す `AuthorizationResponseParams` に `transactionId` を加え、`createAuthorizationCode()` / `buildAuthorizationCodeData()` はそれを `AuthorizationCodeData.transactionId` へ引き継ぐ。ストアは、どの認可リクエストから発行したコードかを記録できる。`transactionId` は認可レスポンスのパラメータではないので、リダイレクト URL には載せない
  
  SHA-256 は速いハッシュなので、短い値や推測できる値は総当たりで元に戻される。`clientSecretHash` を使うクライアントの client_secret は、CSPRNG で作った十分長い値にすること。
  
  experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。
- 4f5cf00: production 依存の `google-auth-library` を `^11.1.0` から `^11.2.0` へ上げる（Dependabot #130）。
  
  11.2.0 の変更は Bun 向けの CLI フラグ追加だけで、ID トークン検証の API と挙動は変わらない。利用者がインストールする依存の range が変わるため、RELEASE.md の規約どおり google-login を patch でリリースする。

## 0.0.7

### Patch Changes

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

## 0.0.6

### Patch Changes

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

## 0.0.5

### Patch Changes

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

## 0.0.4

### Patch Changes

- f1e9def: README の生成コード対応表で、Hono の既定のログイン画面が `views.tsx`（hono/jsx）にあることを明記する

## 0.0.3

### Patch Changes

- ed8c5a5: core 0.4.1 との同時リリース。core peer range の下限を >=0.4.1 へ更新。

## 0.0.2

### Patch Changes

- 9df8d94: introspection エンドポイントで public client の client_id 単独提示を拒否する
  
  これまで生成 OP の introspection ルートは token エンドポイントと同じクライアント認証パイプラインを使っており、`token_endpoint_auth_method: 'none'` で登録されたクライアントは「資格情報を提示していないこと」の確認だけで通過していた。public client の client_id は公開情報なので、これを認証済み呼び出し元として扱うと誰でもトークンを走査できる（RFC 7662 §2.1 は呼び出し元の認可を要求し、RFC 9701 §5 は未認証リクエストの拒否を MUST とする）。
  
  - core に導入ステップ関数 `requireConfidentialIntrospectionCaller` を追加した。登録方式が `'none'` のクライアントを `invalid_client`（401 + `WWW-Authenticate: Basic realm="Client Authentication"`）で拒否し、それ以外（既定の `client_secret_basic` を含む）は通す
  - CLI が生成する introspection ルートは、クライアント認証パイプラインの直後・トークン解決の前にこのステップを呼ぶ。`--enable jwt-introspection-response` の JWT 経路もこの拒否より後にあるため、Accept ヘッダーで迂回できない
  - revocation ルートは変更していない（RFC 7009 §2.1 は public client が自分のトークンを失効させることを正当に許す）
  
  experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。

## 0.0.1

### Patch Changes

- a1c441f: `@maronn-openid-connect/google-login` を新設し、Sign in with Google（Google Identity Services の redirect mode）を core で組んだ OP のログイン手段として使えるようにする。Google が `login_uri` へ POST する ID トークンの検証は Google 公式の `google-auth-library`（`OAuth2Client.verifyIdToken`。公開鍵の取得とキャッシュ、署名・`aud`・`iss`・`exp` の検証）に委ね、このパッケージは `g_csrf_token` の Double Submit Cookie 検証、任意の `hd` / `email_verified` / `nonce` の確認、core の認証トランザクションへ Google ログインを束縛する nonce の発行と単回消費を提供する。ログイン画面の UI は生成せず、redirect mode に必要な `g_id_onload` の属性（`data-ux_mode="redirect"` / `data-login_uri` / `data-nonce` を必ず含む）を組み立てる `buildGoogleSignInAttributes` と、その HTML 文字列化を Node 非依存のサブパス `@maronn-openid-connect/google-login/sign-in` で提供する（プレーン HTML / React / Vue のどれからでも使える）。
  
  core と組み合わせて使う拡張パッケージであり、単体では使わない。core は experimental と同じく peerDependency（`>=0.3.0 <1.0.0`）で参照し、リリース契約（peer range の下限、core の minor / major との同時リリース）を CI で強制する対象に加えた。`google-auth-library` の要件により Node.js 22 以上限定で、エッジランタイムでは動かない。CLI の `--enable google-login`（拡張機能。既定では無効）から生成コードに組み込まれ、ログイン画面のボタンと `POST /login/google` の受け口、nonce ストア、Google ユーザーの JIT 登録が生成される（CLI 側の changeset を参照）。
  
  初回リリースは `0.0.0` から patch で `0.0.1` になる。`0.0.0` は Trusted Publisher を設定するための手動ブートストラップ用のプレースホルダーで、RELEASE.md「初回 publish（手動ブートストラップ）」に従って先に publish しておく。
