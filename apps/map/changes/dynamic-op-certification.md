# Dynamic OP の認定に要る機能を足す

OpenID Certification の Dynamic OP プロファイル（Suite の `oidcc-dynamic-certification-test-plan[response_type=code]`。動的登録と private_key_jwt はプランが決める）と Config OP プロファイルに合わせて、4 つの機能を足す。

- private_key_jwt のクライアント認証（OIDC Core 1.0 §9、RFC 7523 §3）。トークン、イントロスペクション、リボケーション、PAR、Device Authorization、CIBA のエンドポイントが同じ部品で認証する
- `request_uri` からの Request Object の取得（OIDC Core 1.0 §6.2、RFC 9101 §5.2）。認可エンドポイントの `[resolve-client]` の後、`[resolve-request-object]` の前に、request-object 機能のブロックとして入る
- ログイン画面と同意画面の、クライアントの名前、ロゴ、ポリシーのリンク（OIDC Dynamic Client Registration 1.0 §2、§9.1）
- OP の署名鍵の実行中のローテーション（OIDC Core 1.0 §10.1.1）。core はキャッシュの破棄だけを持ち、ローテーションの口は各サンプルと apps/hono の開発サーバーに置く（生成コードには入れない）

pairwise の subject（OIDC Core 1.0 §8.1）は入れない。
Suite の `oidcc-registration-sector-uri` と `oidcc-registration-sector-bad` は SKIPPED になり、認定では許容される。

## rejectUnsupportedRequestParams <!-- core:authorization-request.ts#rejectUnsupportedRequestParams -->

JSDoc だけを変えた。
`request_uri` は `resolveRequestUriParams` が取得して `request` に置き換えるので、ここに残る `request_uri` は取得していないものとして `request_uri_not_supported` で拒否する、と書いた。
`request` との併用の拒否は `resolveRequestUriParams` だけが持つ。

## consumeClientAssertionJti <!-- core:client-assertion.ts#consumeClientAssertionJti -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:device-authorization, nextjs:backchannel-authentication -->
同じアサーションの再送を拒否する（RFC 7523 §3 の `jti`）。
キーは client_id と `jti` の組で、別のクライアントが同じ `jti` を使っても衝突しない。
記録は `exp` に時計のずれを足した時刻まで持てば足り、それより後のアサーションは `exp` の検査で落ちる。
ストアの `consume` は 1 回の不可分な操作でなければならない（同時に届いた 2 つの同じアサーションを両方通さないため）。

## decodeClientAssertion <!-- core:client-assertion.ts#decodeClientAssertion -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:par, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:par, nextjs:device-authorization, nextjs:backchannel-authentication -->
アサーションを分解し、ヘッダーとクレームを JSON のオブジェクトとして読む。
署名の検証より前に、`crit` を持つもの（理解しない拡張を無視しないため。RFC 7515 §4.1.11）と空の署名を落とす。

## decodeJsonObjectSegment <!-- core:client-assertion.ts#decodeJsonObjectSegment -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:par, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:par, nextjs:device-authorization, nextjs:backchannel-authentication -->
`decodeClientAssertion` のヘッダーとペイロードの共通の読み方。JSON のオブジェクトでなければ `invalid_client` にする。

## invalidClientAssertion <!-- core:client-assertion.ts#invalidClientAssertion -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:par, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:par, nextjs:device-authorization, nextjs:backchannel-authentication -->
失敗をすべて同じ `invalid_client` の形で作る。
どの検査で落ちたかを細かく返すと、攻撃者に検査の順序を教えることになるので、`error_description` は短く保つ。

## loadClientAssertionKeys <!-- core:client-assertion.ts#loadClientAssertionKeys -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:device-authorization, nextjs:backchannel-authentication -->
鍵を `ClientKeyResolver` の `private_key_jwt` の用途から読む。
`kid` を渡すので、`jwks_uri` のクライアントでは、見慣れない `kid` のときに `jwks_uri` を取り直す（Suite の `oidcc-refresh-token-rp-key-rotation` がこれに頼る）。
`jwks_uri` を取得できないときの理由は応答に出さず、固定文言の `invalid_client` にする（Request Object の `invalid_request_object` と同じ方針）。

## requireClientAssertionJti <!-- core:client-assertion.ts#requireClientAssertionJti -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:device-authorization, nextjs:backchannel-authentication -->
`jti` を必須にする。`jti` が無いと再送を見分けられない。

## validateClientAssertionAlg <!-- core:client-assertion.ts#validateClientAssertionAlg -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:device-authorization, nextjs:backchannel-authentication -->
`none` と HS 系を拒否する。
HS 系を通すと、公開鍵を HMAC の鍵として使わせる取り違えが起きうる（RFC 8725 §2.1）。
クライアントが `token_endpoint_auth_signing_alg` を登録していれば、その alg だけを通す（OIDC Dynamic Client Registration 1.0 §2）。

## validateClientAssertionAudience <!-- core:client-assertion.ts#validateClientAssertionAudience -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:device-authorization, nextjs:backchannel-authentication -->
`aud` に、呼ばれたエンドポイントの URL か issuer を含むものを受け付ける。
OIDC Core 1.0 §9 はトークンエンドポイントの URL を求めるが、Suite の `oidcc-ensure-client-assertion-with-iss-aud-succeeds` は issuer を `aud` にしたアサーションも通ることを確かめる（RFC 7523 §3 は AS を表す値を許す）。
エンドポイントごとに URL を渡すので、トークンエンドポイント向けのアサーションをイントロスペクションに流用されることは、issuer を `aud` にしない限り起きない。

## validateClientAssertionClaims <!-- core:client-assertion.ts#validateClientAssertionClaims -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:device-authorization, nextjs:backchannel-authentication -->
クレームの検査をまとめて呼び、`jti` と、記録を持つ期限を返す。
エンドポイントの側はこの戻り値をそのまま `consumeClientAssertionJti` に渡すだけで済む。

## validateClientAssertionSubject <!-- core:client-assertion.ts#validateClientAssertionSubject -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:device-authorization, nextjs:backchannel-authentication -->
`iss` と `sub` が client_id であることを確かめる（RFC 7523 §3）。
client_id をボディに書かないリクエストでは、`resolveClientAssertionClientId` が `sub` を client_id に使うので、ここでの比較は自分自身との比較にならないよう `iss` も見る。

## validateClientAssertionTimes <!-- core:client-assertion.ts#validateClientAssertionTimes -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:device-authorization, nextjs:backchannel-authentication -->
`exp` を必須にし、`nbf` と `iat` は任意で、時計のずれ（既定 60 秒）を許して比べる。
`iat` が未来すぎるアサーションも拒否する。

## verifyClientAssertionSignature <!-- core:client-assertion.ts#verifyClientAssertionSignature -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:device-authorization, nextjs:backchannel-authentication -->
既存の JWS の検証部品（`importJwkForJwsVerification`）で、ヘッダーの alg と同じ alg を使える鍵だけで検証する（RFC 8725 §3.1）。
どの鍵でも検証できなければ `invalid_client`。

## extractClientAssertion <!-- core:client-auth.ts#extractClientAssertion -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:par, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:par, nextjs:device-authorization, nextjs:backchannel-authentication -->
`client_assertion_type` と `client_assertion` を読む。
片方だけのリクエストは形が壊れているので `invalid_request`、jwt-bearer 以外の type は、この OP が知らない認証なので `invalid_client` にする。

## extractClientCredentials <!-- core:client-auth.ts#extractClientCredentials -->

<!-- 自動要約: `extractClientAssertion()` の呼び出し を足した / 条件 `clientAssertion !== undefined` を足した（早期リターン） / JSDoc を変えた -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:par, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:par, nextjs:device-authorization, nextjs:backchannel-authentication -->
アサーションを先に見て、あれば方式 `private_key_jwt` として返す。
シークレットとの併用は、どちらで認証したかが曖昧になるので `invalid_request` で拒否する（OAuth 2.1 §2.3 の、1 リクエスト 1 方式）。

## resolveClientAssertionClientId <!-- core:client-auth.ts#resolveClientAssertionClientId -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:par, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:par, nextjs:device-authorization, nextjs:backchannel-authentication -->
ボディに client_id が無ければ、アサーションの `sub` を client_id にする（RFC 7521 §4.2 で client_id は任意）。
ボディの client_id と `sub` が違うときは、ここでは決めず、後の `validateClientAssertionSubject` が `invalid_client` にする。

## validateClientAssertionNotCombined <!-- core:client-auth.ts#validateClientAssertionNotCombined -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:par, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:par, nextjs:device-authorization, nextjs:backchannel-authentication -->
Basic 認証か `client_secret` と一緒に送られたアサーションを `invalid_request` にする。

## validateClientAuthMethod <!-- core:client-auth.ts#validateClientAuthMethod -->

<!-- 自動要約: 条件 `presented.method === 'private_key_jwt'` を足した（早期リターン） / JSDoc を変えた -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:par, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:par, nextjs:device-authorization, nextjs:backchannel-authentication -->
private_key_jwt はシークレットを持たないので、シークレットの登録を求める検査を飛ばす。
登録した方式の一覧に無い方式は `invalid_client` になる。

## buildProviderMetadata <!-- core:discovery.ts#buildProviderMetadata -->

`token_endpoint_auth_signing_alg_values_supported` を出せるようにした（OIDC Discovery 1.0 §3）。
`none` を含む設定は設定の誤りとして例外にする（Discovery が `none` を禁じる）。
`private_key_jwt` か `client_secret_jwt` を広告する設定に alg の一覧が無ければ例外にする（RFC 8414 §2 は、そのときこの項目を必須とする）。空の一覧も無いものとして例外にする。
どちらも広告しない設定では任意で、一覧が無いか空なら出さない。

## discardBody <!-- core:request-uri.ts#discardBody -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
200 以外の応答の本文を捨て、接続を残さない。

## errorNameOf <!-- core:request-uri.ts#errorNameOf -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
ログに出す理由を、例外の名前（`TimeoutError` など）だけにする。メッセージには取得先の内部の情報が入りうる。

## fetchRequestObjectByReference <!-- core:request-uri.ts#fetchRequestObjectByReference -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
`request_uri` を 1 回取得する。
方針は `fetchClientJwkSet` と同じで、宛先の検査、リダイレクトに従わない、タイムアウト、本文の上限を持つ（RFC 9101 §10.4）。
`fetch` を注入できるので、egress プロキシを通す fetch に差し替えられる。

## isRequestUriError <!-- core:request-uri.ts#isRequestUriError -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
取得の失敗を名前で見分ける。core が二重に入った環境でも `instanceof` に頼らずに済む。

## matchesRegisteredRequestUri <!-- core:request-uri.ts#matchesRegisteredRequestUri -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
`require_request_uri_registration` の照合は、フラグメントを含めた完全一致にする。前方一致を許すと、登録した URL の下の別の文書を取得させられる。

## readBodyWithin <!-- core:request-uri.ts#readBodyWithin -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
本文を上限まで読み、超えたら途中で止める。`Content-Length` を信用しない。

## requestUriFetchUrl <!-- core:request-uri.ts#requestUriFetchUrl -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
フラグメントを除いた URL を取得に使う（OIDC Core 1.0 §6.2。フラグメントは文書の中身のハッシュなどを表す）。

## resolveRequestUriParams <!-- core:request-uri.ts#resolveRequestUriParams -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
取得した Request Object を `request` に置き換えたパラメータを返し、以降の検証を by value と同じ経路に載せる。
署名、alg、`allowUnsigned` の規則を 2 回書かないためである。
取得の失敗は理由を応答に出さず、固定文言の `invalid_request_uri` にする（取得先の内部のネットワークを探る手がかりを与えない）。

## validateRequestUri <!-- core:request-uri.ts#validateRequestUri -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize, nextjs:authorize -->
`request_uri` の長さ（既定 512 文字。RFC 9101 §5.2）と宛先を検査する。
宛先の検査は `validateClientJwksUri` を使い回すので、`jwks_uri` と同じく、https の公開ホストに限り、DNS の解決先は見ない。

## createCachedSigningKeyProvider <!-- core:signing-key.ts#createCachedSigningKeyProvider -->

<!-- 自動要約: 宣言（引数か戻り値の型）を変えた / `SigningKeyProvider.getSigningKeys`、`CachedSigningKeyProvider.invalidate` の実装: `invalidate(): void { cache = null; },` を足した / JSDoc を変えた -->
<!-- 届く先: nextjs:discovery, nextjs:jwks, nextjs:authorize, nextjs:consent, nextjs:token, nextjs:userinfo, nextjs:introspection, nextjs:register, nextjs:logout -->
キャッシュを捨てる `invalidate()` を足した。
ローテーションの直後に、TTL を待たずに JWKS と新しい ID Token の `kid` を変えるためである（Suite の `oidcc-server-rotate-keys` は、ローテーションの後すぐに Start を押す）。
戻り値を `invalidate()` 付きの `CachedSigningKeyProvider`（`SigningKeyProvider` の拡張）にした。

## validateRequestUris <!-- experimental:dynamic-client-registration/metadata-values.ts#validateRequestUris -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:register, nextjs:register -->
`request_uris` を登録できるようにした（OIDC Dynamic Client Registration 1.0 §2）。
登録の時点では取得せず、形だけを見る。
フラグメントを許すのは、Suite がランダムなフラグメント付きで登録するからである。

## buildRegisteredClient <!-- experimental:dynamic-client-registration/registered-client.ts#buildRegisteredClient -->

<!-- 自動要約: `return { clientId, ...(issuesSecret ? { clientSec…`: 式を書き換えた -->
<!-- 届く先: hono:register, nextjs:register -->
登録した `token_endpoint_auth_signing_alg`、`request_uris`、`client_name` と表示用の URL を、OP が使うクライアントに写す。
写さないと、登録は成功しても、アサーションの alg の制限も画面の表示も効かない。

## validateClientMetadata <!-- experimental:dynamic-client-registration/registration-request.ts#validateClientMetadata -->

private_key_jwt の登録に `jwks` か `jwks_uri` を求める（鍵の無いクライアントは認証できないので、登録の時点で気づかせる）。
`token_endpoint_auth_signing_alg` は、OP が受け付ける alg（`tokenEndpointAuthSigningAlgValuesSupported`、省略時は core の `SUPPORTED_CLIENT_ASSERTION_SIGNING_ALGS`。`none` は受け付けない）で検証して登録する。
この一覧は `token_endpoint_auth_method` によらず使うので、client_secret_jwt を許す OP は HS256 などの HMAC の alg も一覧に含める。
`request_uris` は `request_uri` に応答する OP（`acceptRequestUris`）でだけ登録し、ほかの OP では理解しないメタデータとして無視する（RFC 7591 §2）。
`client_name` と表示用の URL は、検証した値を OP のクライアントにも渡すため、`validated` に残すようにした。

## verifyPresentedClientCredential <!-- hono:oidc-provider/client-auth.ts#verifyPresentedClientCredential -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:device-authorization, hono:backchannel-authentication -->
6 つのエンドポイントの authenticate-client が共有する、方式ごとの振り分け。
シークレットの方式は core の `verifyClientSecret`、private_key_jwt は `verifyPrivateKeyJwtAssertion` に渡す。
1 か所に集めたので、方式を足すときに 6 か所を書き換えずに済む。

## verifyPrivateKeyJwtAssertion <!-- hono:oidc-provider/client-auth.ts#verifyPrivateKeyJwtAssertion -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:device-authorization, hono:backchannel-authentication -->
core の部品を、alg、クレーム、鍵、署名、`jti` の順に呼ぶ。
`aud` に許すのは、そのエンドポイントの URL（`${issuer}${endpointPath}`）と issuer である。
`jti` の消費は署名の検証の後に行う。署名の通らないアサーションで正しいクライアントの `jti` を潰させないためである。

## hostsOf <!-- hono:oidc-provider/client-display.ts#hostsOf -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:login, hono:consent -->
`redirect_uris` のホストの一覧。ホストの一致を求める設定のときだけ使う。

## resolveClientDisplay <!-- hono:oidc-provider/client-display.ts#resolveClientDisplay -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:login, hono:consent -->
ログイン画面と同意画面に出すクライアントの名前と URL を決める。
OIDC Dynamic Client Registration 1.0 §2 は、`client_name`、`logo_uri`、`policy_uri`、`tos_uri` を End-User に見せることを SHOULD とし、Suite はログイン画面の screenshot で確かめる。
クライアントが見つからないときも画面は出せるよう、client_id だけを返す。

## selectClientDisplayUri <!-- hono:oidc-provider/client-display.ts#selectClientDisplayUri -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:login, hono:consent -->
画面に入れる URL を https に限る（`javascript:` や平文の http を、OP のページに入れない）。
`requireClientDisplayUriHostMatch` では、`logo_uri` と `policy_uri` のホストを `redirect_uris` のホストに限る（同 §9.1 の SHOULD。ほかのサイトのロゴやポリシーを名乗らせない）。
`tos_uri` と `client_uri` は比べない。Suite の `tos_uri` は別のホスト（openid.net）であり、既定ではホストを比べない。

## getClientKeyResolver <!-- hono:oidc-provider/client-jwks-uri.ts#getClientKeyResolver -->

<!-- 自動要約: `return withRegisteredClientJwksUri(c, base, { fet…`: 引数の `'clientJwksFetch'` を `'outboundFetch'` に変えた / `withRegisteredClientJwksUri()` の呼び出し: 引数の `'clientJwksFetch'` を `'outboundFetch'` に変えた -->
<!-- 届く先: hono:authorize, hono:token, hono:introspection, hono:revocation, hono:device-authorization, hono:backchannel-authentication -->
`jwks_uri` の取得に使う fetch を、`clientJwksFetch` から、`request_uri` と共有する `outboundFetch` に変えた。
egress プロキシを 1 か所で渡せば、OP が外へ出すすべての取得がそれを通る。

## createClientResolver <!-- hono:oidc-provider/db/kv/clients.ts#createClientResolver -->

レコードの `client_auths` から方式の一覧を 1 度に作り（`private_key_jwt` の要素を含む）、シークレットの方式の要素が同じシークレットを持つことを確かめて `clientSecretHash` にする。
`token_endpoint_auth_signing_alg`、`request_uris`、`name` と表示用の URL の項目を読む。
レコードはどの項目も必ず持つ（値の無い項目は `null` か空の配列）ので、項目の有無は確かめない。

## createClientResolver <!-- hono:oidc-provider/db/sql/clients.ts#createClientResolver -->

`clients` の列（`jwks_uri`、`request_object_signing_alg`、`token_endpoint_auth_signing_alg`、`name` と表示用の URL）を 1 つの SELECT で読み、`client_auths` の行から方式の一覧を 1 度に作る。
どれもクライアントに 1 つしかない値なので、別のテーブルではなく `clients` の列に持つ（RFC 7591 §2、OIDC Dynamic Client Registration 1.0 §2）。
シークレットの検査は、シークレットの方式の行だけで行う（`private_key_jwt` の行はシークレットを持たない）。
`client_request_uris` を読む。

## processAuthorizationRequest <!-- hono:oidc-provider/endpoints/authorize/pipeline.ts#processAuthorizationRequest -->

<!-- 自動要約: ステップ「request_uri からリクエストオブジェクトを取得する」 を足した -->
<!-- 届く先: hono:authorize -->
`[fetch-request-uri]` のブロック（request-object 機能）を、`[resolve-client]` の後、`[resolve-request-object]` の前に足した。
クライアントが決まらないと登録した `request_uris` と照合できず、取得した Request Object は後の `[resolve-request-object]` で by value と同じく検証したいからである。
PAR の URN は先の `[resolve-pushed-request]` が展開するので、このブロックには URL だけが届く。
エラーはリダイレクトしない。検証前の Request Object の `redirect_uri` は信用できない。

## describeConsentScreen <!-- hono:oidc-provider/endpoints/consent/steps/describe-consent-screen.ts#describeConsentScreen -->

同意画面の値のクライアントを、client_id だけから、`resolveClientDisplay` が返す表示（`ClientDisplay`。`clientId` を含む）にした。同意する相手の名前が client_id だけでは、End-User は判断できない。
client_id は `client.clientId` が持つので、画面の値に別の `clientId` は持たない。

## buildDiscoveryMetadata <!-- hono:oidc-provider/endpoints/discovery/steps/build-metadata.ts#buildDiscoveryMetadata -->

<!-- 自動要約: `buildProviderMetadata()` の呼び出し: 引数の `'private_key_jwt',` を足した / `buildProviderMetadata()` の呼び出し: 引数の `tokenEndpointAuthSigningAlgValuesSuppor…` を足した -->
<!-- 届く先: hono:discovery -->
`token_endpoint_auth_methods_supported` に `private_key_jwt` を、`token_endpoint_auth_signing_alg_values_supported` に受け付ける alg を足した。
Suite の動的登録は、この広告を見て `private_key_jwt` で登録する。
`request_uri_parameter_supported: false` は base に残し、request-object 機能が上書きする。

## describeLoginScreen <!-- hono:oidc-provider/endpoints/login/steps/describe-login-screen.ts#describeLoginScreen -->

<!-- 自動要約: `return { kind, csrfToken, loginHint, client, … }`: `client: await resolveClientDisplay(c.ge…` を足した / `resolveClientDisplay()` の呼び出し を足した / JSDoc を変えた -->
<!-- 届く先: hono:login -->
ログイン画面の値に、表示するクライアントを足した。Suite の logo-uri、policy-uri、tos-uri の module はこの画面の screenshot を求める。

## authenticateTokenClient <!-- hono:oidc-provider/endpoints/token/steps/authenticate-client.ts#authenticateTokenClient -->

<!-- 自動要約: `await verifyClientSecret()` の呼び出し を `await verifyPresentedClientCredential()` の呼び出し に置き換えた / JSDoc を変えた -->
<!-- 届く先: hono:token -->
資格情報の検証を `verifyPresentedClientCredential` に任せ、private_key_jwt を受け付けるようにした。`aud` に許すパスは `/token`。

## authenticateCibaClient <!-- hono:oidc-provider/features/ciba/endpoints/backchannel-authentication/steps/authenticate-client.ts#authenticateCibaClient -->

<!-- 自動要約: `await verifyClientSecret()` の呼び出し を `await verifyPresentedClientCredential()` の呼び出し に置き換えた / JSDoc を変えた -->
<!-- 届く先: hono:backchannel-authentication -->
トークンエンドポイントと同じ部品で private_key_jwt を受け付ける（CIBA Core 1.0 §7.1 は、クライアントが登録した方式での認証を求める）。`aud` に許すパスは `/backchannel_authentication`。

## authenticateDeviceClient <!-- hono:oidc-provider/features/device-authorization-grant/endpoints/device-authorization/steps/authenticate-client.ts#authenticateDeviceClient -->

<!-- 自動要約: `await verifyClientSecret()` の呼び出し を `await verifyPresentedClientCredential()` の呼び出し に置き換えた / JSDoc を変えた -->
<!-- 届く先: hono:device-authorization -->
トークンエンドポイントと同じ部品で private_key_jwt を受け付ける（RFC 8628 §3.1）。`aud` に許すパスは `/device_authorization`。

## requestUriRegistrationPolicyOf <!-- hono:oidc-provider/features/dynamic-client-registration/endpoints/register/steps/validate-metadata.ts#requestUriRegistrationPolicyOf -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:register -->
`request_uris` を受け付けるかを、discovery の `request_uri_parameter_supported` から決める。
動的登録の機能は request-object 機能の設定を型で参照できない（機能どうしの import 境界）ので、`allowInsecureRequestUri` は名前で読む。

## validateRegistrationMetadata <!-- hono:oidc-provider/features/dynamic-client-registration/endpoints/register/steps/validate-metadata.ts#validateRegistrationMetadata -->

<!-- 自動要約: `requestUriRegistrationPolicyOf()` の呼び出し を足した / `validateClientMetadata()` の呼び出し: 引数の `tokenEndpointAuthSigningAlgValuesSuppor…` を足した / JSDoc を変えた -->
<!-- 届く先: hono:register -->
`token_endpoint_auth_signing_alg` に受け付ける alg と、`request_uris` の扱いを、experimental の検証に渡す。

## toClientRegistration <!-- hono:oidc-provider/features/dynamic-client-registration/store.ts#toClientRegistration -->

<!-- 自動要約: `return { clientId, clientType, redirectUris, gran…`: 式を書き換えた / JSDoc を変えた -->
<!-- 届く先: hono:register -->
登録したクライアントの、アサーションの alg、`request_uris`、表示用の値を、OP のクライアントに写す。

## authenticateIntrospectionClient <!-- hono:oidc-provider/features/introspection/endpoints/introspection/steps/authenticate-client.ts#authenticateIntrospectionClient -->

<!-- 自動要約: `await verifyClientSecret()` の呼び出し を `await verifyPresentedClientCredential()` の呼び出し に置き換えた / JSDoc を変えた -->
<!-- 届く先: hono:introspection -->
トークンエンドポイントと同じ部品で private_key_jwt を受け付ける。discovery の `introspection_endpoint_auth_methods_supported` も同じにした。`aud` に許すパスは `/introspect`。

## fetchRequestUri <!-- hono:oidc-provider/features/request-object/steps/fetch-request-uri.ts#fetchRequestUri -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize -->
`request_uri` が URL なら取得し、`request` に置き換える。
`requestUriParameterSupported` が false の設定では何もせず、後の `rejectUnsupportedRequestParams` が `request_uri_not_supported` で拒否する。
取得の失敗は、ホストと理由を `console.warn` に書き、応答には固定文言だけを返す。

## hostOf <!-- hono:oidc-provider/features/request-object/steps/fetch-request-uri.ts#hostOf -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: hono:authorize -->
ログに URL 全体ではなくホストだけを出す。パスやクエリに秘密が入りうる。

## authenticateRevocationClient <!-- hono:oidc-provider/features/revocation/endpoints/revocation/steps/authenticate-client.ts#authenticateRevocationClient -->

<!-- 自動要約: `await verifyClientSecret()` の呼び出し を `await verifyPresentedClientCredential()` の呼び出し に置き換えた / JSDoc を変えた -->
<!-- 届く先: hono:revocation -->
トークンエンドポイントと同じ部品で private_key_jwt を受け付ける。discovery の `revocation_endpoint_auth_methods_supported` も同じにした。`aud` に許すパスは `/revoke`。

## backchannelAuthentication <!-- nextjs:app/(ciba)/backchannel_authentication/route.ts#backchannelAuthentication -->

<!-- 自動要約: `await verifyClientSecret()` の呼び出し を `await verifyPresentedClientCredential()` の呼び出し に置き換えた -->
<!-- 届く先: nextjs:backchannel-authentication -->
Hono の `authenticateCibaClient` と同じ変更。

## deviceAuthorization <!-- nextjs:app/(device-authorization-grant)/device_authorization/route.ts#deviceAuthorization -->

<!-- 自動要約: `await verifyClientSecret()` の呼び出し を `await verifyPresentedClientCredential()` の呼び出し に置き換えた -->
<!-- 届く先: nextjs:device-authorization -->
Hono の `authenticateDeviceClient` と同じ変更。

## registerClient <!-- nextjs:app/(dynamic-client-registration)/register/route.ts#registerClient -->

<!-- 自動要約: `requestUriRegistrationPolicyOf()` の呼び出し を足した / `validateClientMetadata()` の呼び出し: 引数の `tokenEndpointAuthSigningAlgValuesSuppor…` を足した -->
<!-- 届く先: nextjs:register -->
Hono の `validateRegistrationMetadata` と同じ変更。

## requestUriRegistrationPolicyOf <!-- nextjs:app/(dynamic-client-registration)/register/route.ts#requestUriRegistrationPolicyOf -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: nextjs:register -->
Hono の `requestUriRegistrationPolicyOf` と同じ。

## introspect <!-- nextjs:app/(introspection)/introspect/route.ts#introspect -->

<!-- 自動要約: `await verifyClientSecret()` の呼び出し を `await verifyPresentedClientCredential()` の呼び出し に置き換えた -->
<!-- 届く先: nextjs:introspection -->
Hono の `authenticateIntrospectionClient` と同じ変更。

## revoke <!-- nextjs:app/(revocation)/revoke/route.ts#revoke -->

<!-- 自動要約: `await verifyClientSecret()` の呼び出し を `await verifyPresentedClientCredential()` の呼び出し に置き換えた -->
<!-- 届く先: nextjs:revocation -->
Hono の `authenticateRevocationClient` と同じ変更。

## providerMetadata <!-- nextjs:app/.well-known/openid-configuration/route.ts#providerMetadata -->

<!-- 自動要約: `buildProviderMetadata()` の呼び出し: 引数 `tokenEndpointAuthMethodsSupported: [ 'c…` を足した / `buildProviderMetadata()` の呼び出し: 引数 `tokenEndpointAuthSigningAlgValuesSuppor…` を足した / `buildProviderMetadata()` の呼び出し: 引数 `tokenEndpointAuthMethodsSupported: [ 'c…` を消した -->
<!-- 届く先: nextjs:discovery -->
Hono の `buildDiscoveryMetadata` と同じ変更。

## verifyPresentedClientCredential <!-- nextjs:app/_oidc-provider/client-auth.ts#verifyPresentedClientCredential -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:device-authorization, nextjs:backchannel-authentication -->
Hono の `verifyPresentedClientCredential` と同じ。Next.js にはリクエストのコンテキストが無いので、設定とストアは provider から読む。

## verifyPrivateKeyJwtAssertion <!-- nextjs:app/_oidc-provider/client-auth.ts#verifyPrivateKeyJwtAssertion -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:device-authorization, nextjs:backchannel-authentication -->
Hono の `verifyPrivateKeyJwtAssertion` と同じ。

## createClientResolver <!-- nextjs:app/_oidc-provider/db/kv/clients.ts#createClientResolver -->

Hono の kv の `createClientResolver` と同じ変更。

## createClientResolver <!-- nextjs:app/_oidc-provider/db/sql/clients.ts#createClientResolver -->

Hono の sql の `createClientResolver` と同じ変更。

## toClientRegistration <!-- nextjs:app/_oidc-provider/features/dynamic-client-registration/store.ts#toClientRegistration -->

<!-- 自動要約: `return { clientId, clientType, redirectUris, gran…`: 式を書き換えた -->
<!-- 届く先: nextjs:register -->
Hono の `toClientRegistration` と同じ変更。

## fetchRequestUri <!-- nextjs:app/_oidc-provider/features/request-object/authorize.ts#fetchRequestUri -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: nextjs:authorize -->
Hono の `fetchRequestUri` と同じ。Next.js の認可エンドポイントのパラメータの型に合わせて、型引数を取る。

## hostOf <!-- nextjs:app/_oidc-provider/features/request-object/authorize.ts#hostOf -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: nextjs:authorize -->
Hono の `hostOf` と同じ。

## getClientKeyResolver <!-- nextjs:app/_oidc-provider/provider.ts#getClientKeyResolver -->

<!-- 自動要約: `return withRegisteredClientJwksUri(config, (…) =>…`: 引数の `, outboundFetch === undefined ? {} : { …` を足した / `> …, …)()` の呼び出し: 引数の `, outboundFetch === undefined ? {} : { …` を足した / JSDoc を変えた -->
<!-- 届く先: nextjs:authorize, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:device-authorization, nextjs:backchannel-authentication -->
`jwks_uri` の取得に、`request_uri` と共有する `outboundFetch`（`provider.ts` で書き換える）を使うようにした。
未設定なら `globalThis.fetch` を使う。

## authorize <!-- nextjs:app/authorize/route.ts#authorize -->

<!-- 自動要約: ステップ「request_uri からリクエストオブジェクトを取得する」 を足した -->
<!-- 届く先: nextjs:authorize -->
Hono の `processAuthorizationRequest` と同じく、`[fetch-request-uri]` のブロックを足した。

## token <!-- nextjs:app/token/route.ts#token -->

<!-- 自動要約: `await verifyClientSecret()` の呼び出し を `await verifyPresentedClientCredential()` の呼び出し に置き換えた -->
<!-- 届く先: nextjs:token -->
Hono の `authenticateTokenClient` と同じ変更。

## setRequestContext <!-- hono:oidc-provider/app.ts#setRequestContext -->

コンテキストとオプションの fetch を `outboundFetch` にし、`jwks_uri` と `request_uri` の取得で共有する。

## registerClient <!-- hono:oidc-provider/db/kv/clients.ts#registerClient -->

private_key_jwt を、シークレットを持たない `client_auths` の要素として書く。
レコードにはどの項目も書き（渡されない値は `null` か空の配列）、`token_endpoint_auth_signing_alg`、`request_uris`、表示用の URL を足した。`clientName` は `name` に書く。
`private_key_jwt` はコンフィデンシャルクライアントの方式なので、public client では書かない。

## createProviderStores <!-- hono:oidc-provider/db/kv/stores.ts#createProviderStores -->

<!-- 自動要約: `ClientAssertionJtiStorage.consume` の実装 を足した / `return { transactionStore, authCodeStore, accessT…`: `clientAssertionJtiStore,` を足した / JSDoc を変えた -->
<!-- 届く先: なし -->
`jti` のストアを足した。`client_assertion_jti:<hash>` のキーを `setIfAbsent` で書き、アサーションの期限を TTL にする。
`setIfAbsent` が不可分なので、同じアサーションを同時に 2 つ受け付けることはない。

## createEmptyDatabase <!-- hono:oidc-provider/db/memory/database.ts#createEmptyDatabase -->

<!-- 自動要約: `return { transactions, codes, accessTokens, refre…`: `clientAssertionJtis: new Map(),` を足した -->
<!-- 届く先: なし -->
メモリの `jti` の記録を足した。

## createProviderStores <!-- hono:oidc-provider/db/memory/stores.ts#createProviderStores -->

<!-- 自動要約: `ClientAssertionJtiStorage.consume` の実装 を足した / `return { transactionStore, authCodeStore, accessT…`: `clientAssertionJtiStore,` を足した / JSDoc を変えた -->
<!-- 届く先: なし -->
メモリの `jti` のストアを足した。記録するたびに期限切れの記録を消すので、記録は期限内のアサーションの数を超えて増えない。

## registerClient <!-- hono:oidc-provider/db/sql/clients.ts#registerClient -->

private_key_jwt を `client_auths` の方式の行として（`client_secrets` 無し）、`request_uris` を `client_request_uris` に、`client_name`、`jwks_uri`、`request_object_signing_alg`、`token_endpoint_auth_signing_alg`、表示用の URL を `clients` の 1 つの upsert で書く。
`clients` の列には、渡されない値を NULL で書く。

## createProviderStores <!-- hono:oidc-provider/db/sql/stores.ts#createProviderStores -->

<!-- 自動要約: `ClientAssertionJtiStorage.consume` の実装 を足した / `return { transactionStore, authCodeStore, accessT…`: `clientAssertionJtiStore,` を足した / JSDoc を変えた -->
<!-- 届く先: なし -->
`client_assertion_jtis` を使う `jti` のストアを足した。期限切れの行を消してから `INSERT ... ON CONFLICT DO NOTHING` で書き、書けた行の数で初回かを判断する（1 文で不可分）。
キーは client_id と `jti` のハッシュで、長さを固定する。

## validateAuthorizationRequestParams <!-- hono:oidc-provider/endpoints/authorize/steps/validate-request.ts#validateAuthorizationRequestParams -->

<!-- 自動要約: コメントや書き方だけを変えた（木は同じ） -->
<!-- 届く先: hono:authorize -->
コメントだけを変えた。`request_uri` の取得が前の `[fetch-request-uri]` に移ったことを書いた。

## loginPageParams <!-- hono:oidc-provider/endpoints/login/page.tsx#loginPageParams -->

<!-- 自動要約: `return { csrfToken, loginHint, client, loginMetho…`: `client: screen.client,` を足した -->
<!-- 届く先: なし -->
ログイン画面の値の `client` を、ビューに渡す。

## ClientSummary <!-- hono:oidc-provider/views.tsx#ClientSummary -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: なし -->
ログイン画面と同意画面の共通の、クライアントの名前、ロゴ、リンクの表示。
画面の一文（「Sign in to continue to …」）を中に入れ、クライアント名を 1 つの `<strong>` で示す。
リンクは新しいタブで開き、参照元を送らない（`rel="noopener noreferrer"`）。

## clientDisplayName <!-- hono:oidc-provider/views.tsx#clientDisplayName -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: なし -->
`client_name` が無ければ client_id を出す。

## defaultConsentPage <!-- hono:oidc-provider/views.tsx#defaultConsentPage -->

同意画面に `ClientSummary` を使い、クライアントの名前（無ければ client_id）、ロゴ、リンクを出す。
`ConsentPageParams` は `client`（`ClientDisplay`。`clientId` を含む）を必ず受け取り、別の `clientId` は持たない。

## defaultLoginPage <!-- hono:oidc-provider/views.tsx#defaultLoginPage -->

ログイン画面に `ClientSummary` を使い、クライアントの名前（無ければ client_id）、ロゴ、リンクを出す。
`LoginPageParams` は `client`（`ClientDisplay`）を必ず受け取る。画面の値を作るステップが、いつも `resolveClientDisplay` でクライアントの表示を決める（クライアントが見つからなくても client_id だけの表示を返す）からである。

## hostsOf <!-- nextjs:app/_oidc-provider/client-display.ts#hostsOf -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: なし -->
Hono の `hostsOf` と同じ。

## resolveClientDisplay <!-- nextjs:app/_oidc-provider/client-display.ts#resolveClientDisplay -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: なし -->
Hono の `resolveClientDisplay` と同じ。ログインと同意のページから呼ぶ。

## selectClientDisplayUri <!-- nextjs:app/_oidc-provider/client-display.ts#selectClientDisplayUri -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: なし -->
Hono の `selectClientDisplayUri` と同じ。

## ClientSummary <!-- nextjs:app/_oidc-provider/client-summary.tsx#ClientSummary -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: なし -->
Hono の `ClientSummary` と同じ表示を、React のコンポーネントで書いた。

## clientDisplayName <!-- nextjs:app/_oidc-provider/client-summary.tsx#clientDisplayName -->

<!-- 自動要約: 関数を足した -->
<!-- 届く先: なし -->
Hono の `clientDisplayName` と同じ。

## registerClient <!-- nextjs:app/_oidc-provider/db/kv/clients.ts#registerClient -->

Hono の kv の `registerClient` と同じ変更。

## createProviderStores <!-- nextjs:app/_oidc-provider/db/kv/stores.ts#createProviderStores -->

<!-- 自動要約: `ClientAssertionJtiStorage.consume` の実装 を足した / `return { transactionStore, authCodeStore, accessT…`: `clientAssertionJtiStore,` を足した / JSDoc を変えた -->
<!-- 届く先: なし -->
Hono の kv の `createProviderStores` と同じ変更。

## createEmptyDatabase <!-- nextjs:app/_oidc-provider/db/memory/database.ts#createEmptyDatabase -->

<!-- 自動要約: `return { transactions, codes, accessTokens, refre…`: `clientAssertionJtis: new Map(),` を足した -->
<!-- 届く先: なし -->
Hono の memory の `createEmptyDatabase` と同じ変更。

## createProviderStores <!-- nextjs:app/_oidc-provider/db/memory/stores.ts#createProviderStores -->

<!-- 自動要約: `ClientAssertionJtiStorage.consume` の実装 を足した / `return { transactionStore, authCodeStore, accessT…`: `clientAssertionJtiStore,` を足した / JSDoc を変えた -->
<!-- 届く先: なし -->
Hono の memory の `createProviderStores` と同じ変更。

## registerClient <!-- nextjs:app/_oidc-provider/db/sql/clients.ts#registerClient -->

Hono の sql の `registerClient` と同じ変更。

## createProviderStores <!-- nextjs:app/_oidc-provider/db/sql/stores.ts#createProviderStores -->

<!-- 自動要約: `ClientAssertionJtiStorage.consume` の実装 を足した / `return { transactionStore, authCodeStore, accessT…`: `clientAssertionJtiStore,` を足した / JSDoc を変えた -->
<!-- 届く先: なし -->
Hono の sql の `createProviderStores` と同じ変更。

## runClientAuthentication <!-- experimental:par/par-request.ts#runClientAuthentication -->

消した。役割は `resolveParClient`（資格情報の取り出しから方式の照合まで）に移り、資格情報の検証は呼び出し側に残した。

## verifyClientSecretValue <!-- core:client-auth.ts#verifyClientSecretValue -->

<!-- 自動要約: 条件 `presentedSecret !== undefined && presentedSecret !== ''` を足した / `timingSafeEqual()` の呼び出し を消した / JSDoc を変えた -->
<!-- 届く先: hono:token, hono:introspection, hono:revocation, hono:par, hono:device-authorization, hono:backchannel-authentication, nextjs:token, nextjs:introspection, nextjs:revocation, nextjs:par, nextjs:device-authorization, nextjs:backchannel-authentication -->
シークレットが無いか空なら、比べずに `invalid_client` にする（`verifyClientSecretHash` と同じ）。
これまでは「無い」と「無い」を空文字列どうしとして一致させ、提示の有無の確認を `validateClientAuthMethod` に任せていた。
`validateClientAuthMethod` は private_key_jwt の提示にシークレットを求めないので、そのままでは、core の関数を文書どおりの順に呼んで最後に `verifyClientSecret` を呼ぶコードが、シークレットを登録していない private_key_jwt のクライアントを、アサーションを検証せずに通してしまう。
シークレットの照合そのものを閉じる側に倒し、呼び出し側の順序に頼らないようにした。

## resolveParClient <!-- experimental:par/par-request.ts#resolveParClient -->

PAR のクライアント認証のうち、資格情報の取り出し、クライアントの解決、方式の照合までを行い、クライアントと提示された資格情報を返す。
資格情報そのものの検証は呼び出し側に残す。
生成 OP の PAR のステップが、ほかの 5 つのエンドポイントと同じ `verifyPresentedClientCredential` を直接呼び、地図が PAR から鍵の読み込みと `jti` の検査へ辿れるようにするためである。
検証をコールバック（`verifyClientCredential`）で受け取るのはライブラリの合成関数 `handlePushedAuthorizationRequest` だけで、どのエンドポイントもそれを通らない。
`authorizationHeader` は必須の文字列で、ヘッダーが無ければ空文字を渡す（core の `extractClientCredentials` と同じ）。

## toParError <!-- experimental:par/par-request.ts#toParError -->

公開した。
`resolveParClient` の後に行う資格情報の検証（生成 OP の PAR のステップが呼ぶ `verifyPresentedClientCredential` と、合成関数 `handlePushedAuthorizationRequest` が呼ぶ `verifyClientCredential`）の `TokenError` を、PAR の `ParError`（401 と `WWW-Authenticate` 付き）にするためである。
変換の規則は変えていない。

## handlePushedAuthorizationRequest <!-- experimental:par/par-request.ts#handlePushedAuthorizationRequest -->

資格情報の検証を、必須の `verifyClientCredential` で受け取るようにした。
`resolveParClient` の後にこれを呼び、投げた `TokenError` は `toParError` で `ParError` にする。それ以外の例外はそのまま投げ、レコードは保存しない。
シークレットだけを照合する形では、private_key_jwt のクライアントが必ず `invalid_client` になる。
シークレットだけを受け付ける OP は core の `verifyClientSecret` を、private_key_jwt も受け付ける OP はクライアントアサーションの検証を渡す。
`authorizationHeader` は必須の文字列（無ければ空文字）にした。
生成 OP はこの関数を使わず、PAR のステップが `resolveParClient` と `verifyPresentedClientCredential` を直接呼ぶので、どのエンドポイントにも届かず、地図の到達は変わらない。

## authenticatePushingClient <!-- hono:oidc-provider/features/par/endpoints/par/steps/authenticate-client.ts#authenticatePushingClient -->

<!-- 自動要約: `authenticateParClient()` の呼び出し を `resolveParClient()` の呼び出し に置き換えた / 例外の捕捉 を足した / 処理 `const clientId = presented.clientId` を足した / 処理 `const { _assertionType, _assertion, requestParams…` を足した / `return { clientId, pushedParams }`: `params` を `requestParams` に変えた / JSDoc を変えた -->
<!-- 届く先: hono:par -->
private_key_jwt を受け付けるようにした。
`resolveParClient` でクライアントと資格情報を決め、ほかのエンドポイントと同じ `verifyPresentedClientCredential` を直接呼ぶ（`aud` に許すパスは `/par`）。
型で辿れる直接の呼び出しなので、地図は PAR から `loadClientAssertionKeys` と `consumeClientAssertionJti` まで辿る。
検証の `TokenError` は `toParError` で `ParError` にする。
認証に使ったクライアントアサーションは、預けるパラメータから外す。外さないと、認可エンドポイントが展開したパラメータに `client_assertion` が残る。

## pushAuthorizationRequest <!-- nextjs:app/(par)/par/route.ts#pushAuthorizationRequest -->

<!-- 自動要約: `authenticateParClient()` の呼び出し を `resolveParClient()` の呼び出し に置き換えた / 例外の捕捉 を足した / 処理 `const clientId = presented.clientId`: 式を書き換えた / 処理 `const { _assertionType, _assertion, requestParams…` を足した / 処理 `const pushedParams = { ...requestParams, client_i…` を足した -->
<!-- 届く先: nextjs:par -->
Hono の `authenticatePushingClient` と同じ変更。

## authenticateParClient <!-- experimental:par/par-request.ts#authenticateParClient -->

消した。PAR のクライアント認証は `resolveParClient`（取り出しから方式の照合まで）と、呼び出し側の資格情報の検証（生成 OP は `verifyPresentedClientCredential`、合成関数は `verifyClientCredential`）に分けた。
シークレットだけを照合する入口を残すと、private_key_jwt を受け付ける OP が誤った入口を選べてしまう。

## 背景

Suite の Dynamic OP のプランは、クライアントをすべて自分で動的登録し、トークンエンドポイントでは private_key_jwt で認証する。
そのため、これまでの static client のプラン（Basic、Implicit、Hybrid）と違い、動的登録した `jwks` と `jwks_uri` の鍵でアサーションを検証する経路が要る。
`jwks_uri` の取得、キャッシュ、見慣れない `kid` での取り直しは既存の `withClientJwksUriKeys` をそのまま使い、新しく足したのは `private_key_jwt` の用途から鍵を読む側だけである。

`request_uri` は、取得した Request Object を `request` に置き換えて既存の `[resolve-request-object]` に渡す設計を選んだ。
取得と検証を 1 つのステップにまとめる案もあったが、署名と alg の規則を 2 か所に持つことになり、by value と by reference で挙動がずれる危険があるので採らなかった。

外へ出す取得（`jwks_uri`、`request_uri`）の fetch は `outboundFetch` 1 つにまとめ、egress プロキシを 1 か所で渡せるようにした。

PAR のクライアント認証は、最初は experimental の関数（今は消した `authenticateParClient`）に検証の関数をコールバックで渡し、生成 OP もそれを呼ぶ形にした。
地図はコールバックの登録と実行を結ばないので、PAR だけが鍵の読み込みと `jti` の検査に届かない形になっていた。
地図の側でコールバックの橋を足す案と、コード側で、エンドポイントが型付きの helper を直接呼ぶ形にする案を比べ、後者を選んだ。
ほかの 5 つのエンドポイントと同じ形になり、手書きの到達先も地図の解析の変更も要らないからである。
コールバックの形は、ライブラリの合成関数 `handlePushedAuthorizationRequest` の `verifyClientCredential` にだけ残る。生成 OP はこの合成関数を使わないので、地図の到達には関わらない。
`packages/map-analysis` の到達の検査（`repository.test.ts`）は、Hono と Next.js の両方で、鍵の読み込みに届くエンドポイントが認可、トークン、イントロスペクション、リボケーション、PAR、Device Authorization、CIBA の 7 つであることを確かめる。
