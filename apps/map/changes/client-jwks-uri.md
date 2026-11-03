# クライアントの jwks_uri と request_object_signing_alg

静的に登録したクライアントにも動的に登録したクライアントにも、`jwks_uri`（RFC 7591 §2）と `request_object_signing_alg`（OIDC Dynamic Client Registration 1.0 §2）を登録できるようにする。
OP は署名付きのリクエストオブジェクトを検証するときに、`jwks_uri` から鍵を取得してキャッシュし、見慣れない `kid` では取り直す（OIDC Core 1.0 §10.1.1）。
クライアントが `request_object_signing_alg` を登録していれば、その alg で署名したリクエストオブジェクトだけを受け付ける（OIDC Core 1.0 §6.3.2）。
あわせて、リクエストオブジェクトの署名の検証で、鍵ごとに使える alg を一つに決め、ヘッダーの `alg` と一致する鍵だけを使うようにした（RFC 8725 §3.1）。

## parseRequestObject, loadVerificationKeys

鍵は `loadJwks` だけで受け取るようにし、値で鍵を渡す `jwks` のオプションを削除した。
`loadJwks` は、登録した alg との不一致、`none`、受け付けない alg を拒否した後でだけ呼ぶ。
そのため、受け付けないリクエストオブジェクトが `jwks_uri` への通信を起こすことはない。
値で持つ鍵は `loadJwks: async () => jwks` で渡す。

`requiredSigningAlg`（クライアントが登録した alg）と違う `alg` を、`none` も含めて、ほかのどの検査よりも先に拒否する。
署名の検証には、`use` がないか `sig` で、`resolveJwkSigningAlg()` がヘッダーの `alg` を返す鍵だけを使い、`importJwkForJwsVerification()` でインポートする。
2048 ビット未満の RSA の鍵は使わない。
候補の鍵はあるのに、ヘッダーの `alg` で使える鍵がないときは、`no signing JWK matched the request object header (alg)` で拒否する。

`loadJwks` が `jwks_uri` の取得の失敗（`ClientJwksUriError`）を投げたときは、理由を含まない固定の文言（`the client jwks_uri could not be retrieved`）の `RequestObjectError` にする（`loadVerificationKeys`）。
失敗の理由は OP の内側のネットワークを探る手がかりになるので、応答に出さない。

## resolveRequestObjectParams

`loadJwks` と `requestObjectSigningAlg` を受け取り、`parseRequestObject()` に渡すようにした。
受け付ける alg（`supportedSigningAlgs`）の既定値を、RS256 だけから、core が検証できるすべての alg（`SUPPORTED_REQUEST_OBJECT_SIGNING_ALGS`。RS256、RS384、RS512、ES256、ES384、ES512）にした。
`DEFAULT_REQUEST_OBJECT_SIGNING_ALGS` は削除した。
鍵ごとに使える alg を一つに決めて検証するので、受け付ける alg を広げても alg の取り違えは起きない。

## resolveJwkSigningAlg, importJwkForJwsVerification, rsaSigningHashOf, ecSigningCurveOf, ecSigningAlgOfCurve

鍵と alg を一対一に対応させる関数を足した。
`resolveJwkSigningAlg()` は、RSA の鍵には `alg`（なければ RS256）を、EC の鍵には `crv` から決まる ES の alg を返す。
`importJwkForJwsVerification()` は、その alg がヘッダーの `alg` と一致する鍵だけを、公開鍵のメンバーだけでインポートする。

## validateClientJwksUri, isBlockedHost, isBlockedIpv4, isBlockedIpv6, parseIpv4Octets, parseIpv6Groups, authorityOf

`jwks_uri` の宛先を検査する関数を足した。
`https` で、フラグメントと userinfo がなく、`localhost` やループバック・私設・リンクローカルの IP リテラルでない宛先だけを通す（SSRF の対策。RFC 8725 §3.10、RFC 9101 §10.4.1）。
ホストは WHATWG URL の解析後の値で見るので、`0x7f.1` のような別の表記も拒否する。
開発用に、`allowInsecure` で `http` とそれらのアドレスを通せる。

## fetchClientJwkSet, readBodyWithin, discardBody, errorNameOf, parseClientJwkSet, toSigningJwk, hasRsaModulusOfAtLeast, isJsonObject

`jwks_uri` から鍵を 1 回取得する関数を足した。
タイムアウト（既定 3 秒）、本文の上限（既定 64 KiB）、鍵の数の上限（既定 32）を持ち、リダイレクトには従わない。
取得した JWK Set に秘密鍵か対称鍵があれば、全体を拒否する。
署名に使えない鍵は捨て、残りを `use: "sig"` と `alg` を補った形に正規化する。

## resolveClientJwksTtlSeconds, parseCacheControl, parseDeltaSeconds, unquote

取得した鍵を使ってよい期限を、応答の `Cache-Control: max-age` から決める関数を足した。
期限は、既定では下限 30 秒と上限 300 秒の範囲に丸める。
`no-store` と `no-cache` でも下限のあいだは使い、1 リクエストごとに外部へ取得しに行かないようにする。

## createClientJwksUriCache, copyOf, withClientJwksUriKeys, isClientJwksUriError

`jwks_uri` ごとに鍵を覚えるキャッシュと、それを `ClientKeyResolver` に組み込む関数を足した。
期限内でも、手がかりの `kid` がキャッシュになく、前回の取得から `refetchIntervalSeconds`（既定 30 秒）が過ぎていれば取り直す（OIDC Core 1.0 §10.1.1）。
期限切れの鍵の取得に失敗したときは、その失敗を `refetchIntervalSeconds` のあいだ覚え、期限切れの鍵は使わない。
既定値は `DEFAULT_CLIENT_JWKS_URI_OPTIONS` にまとめ、どれも引数で 1 項目ずつ上書きできる。
`ClientKeyResolver.findClientKeys()` は、手がかり（`hint`。検証する JWS の `kid`）を任意の第 3 引数で受け取る。

`isClientJwksUriError()` は、クラスではなく形でエラーを見分ける。
Next.js は core を 2 度読み込むことがあり、`instanceof` が偽になるからである。

## validateClientMetadata, validateJwksUri, validateRequestObjectSigningAlg, buildRegisteredClient

動的クライアント登録で、`jwks_uri` を既定で登録するようにした（`acceptJwksUri: false` で無視する）。
宛先は core の `validateClientJwksUri()` で検査し、登録の時点では取得しない。
`jwks` と `jwks_uri` を両方含む登録は、設定によらず拒否する。

`request_object_signing_alg` は、`requestObjectSigningAlgValuesSupported` を渡したときだけ検証して登録し、渡さない OP では無視する。
`jwks` も登録するときは、その alg で使える鍵が `jwks` にあることを確かめる。
`buildRegisteredClient()` は、`jwksUri` と `requestObjectSigningAlg` を登録レコードに写す。

## withRegisteredClientJwksUri, clientJwksUriLoadOptionsOf, hostOf

生成コードの base に、クライアントの鍵のリゾルバを `jwks_uri` に対応させる関数を足した（`client-jwks-uri.ts`）。
`jwksUri` を持つクライアントには、`config.clientJwksUriPurposes` の用途で `jwks_uri` の鍵だけを返し、ほかのクライアントと用途は元のリゾルバに任せる。
キャッシュはプロセスで共有し、設定は `ProviderConfig` の平たい項目（`allowInsecureClientJwksUri`、`clientJwksUri*`）で 1 項目ずつ上書きできる。
使えない `jwks_uri` は、ホストと理由を `console.warn` に書く。

## setRequestContext

`clientKeyResolver` を、db/ のリゾルバも `createApp()` / `applyOidc()` に渡したリゾルバも、`withRegisteredClientJwksUri()` で包むようにした。
渡したリゾルバも包むので、リゾルバを差し替えても `jwks_uri` は効く。
取得に使う fetch は、オプションの `clientJwksFetch` で差し替えられる（egress プロキシ）。

## secondsFromEnvironment

Next.js の provider.ts で、環境変数 `OIDC_CLIENT_JWKS_URI_CACHE_TTL_SECONDS` と `OIDC_CLIENT_JWKS_URI_REFETCH_INTERVAL_SECONDS` を設定に写すための関数を足した。
Next.js も、Hono と同じく `withRegisteredClientJwksUri()` で、機能のフックが組み立てたリゾルバを包む。

## clients.ts#registerClient, assertClientJwksUriRegistration

`registerClient()` が `jwksUri` と `requestObjectSigningAlg` を保存するようにした。
SQL は `client_jwks_uris` と `client_request_object_signing_algs` のテーブル、KV はクライアントのレコードの `jwks_uri` と `request_object_signing_alg` に書く。
`jwksUri` と `keys` を両方持つクライアントと、`http` か `https` の絶対 URL でない `jwksUri` は、何も書き込まずに拒否する（`assertClientJwksUriRegistration`）。

## clients.ts#createClientResolver

KV と SQL のクライアントのリゾルバが、保存した `jwksUri` と `requestObjectSigningAlg` を読み出すようにした。

## resolveRequestObject

Request Object のステップが、`loadJwks` で鍵を読むようにした。
鍵は、ヘッダーの `alg` の確認を通った後でだけ、ヘッダーの `kid` を手がかりに読む。
受け付ける alg は設定の `requestObjectSigningAlgValuesSupported`（既定は 6 種類で、ディスカバリーの `request_object_signing_alg_values_supported` に公開する）で、クライアントが登録した `requestObjectSigningAlg` も渡す。

## validateRegistrationMetadata, registrableRequestObjectSigningAlgs, route.ts#registerClient

登録エンドポイントが、`jwks_uri` の設定（`acceptJwksUri`、`allowInsecureClientJwksUri`）と、ディスカバリーが公開する `request_object_signing_alg` の一覧（`registrableRequestObjectSigningAlgs`）を `validateClientMetadata()` に渡すようにした。
request-object の機能のない OP では、`request_object_signing_alg` を無視する。

## toClientRegistration, withDynamicallyRegisteredClientKeys

動的に登録したクライアントの保存用のレコードに、`jwksUri` と `requestObjectSigningAlg` を入れるようにした。
鍵のリゾルバは、手がかり（`hint`）をそのまま元のリゾルバに渡す。

## 破壊的変更

- core の `parseRequestObject()` と `resolveRequestObjectParams()` の `jwks` オプションを削除した。値で持つ鍵は `loadJwks: async () => jwks` で渡す
- core の `DEFAULT_REQUEST_OBJECT_SIGNING_ALGS` を削除し、`resolveRequestObjectParams()` の受け付ける alg の既定値を `SUPPORTED_REQUEST_OBJECT_SIGNING_ALGS` にした。RS256 だけに絞るときは `supportedSigningAlgs: ['RS256']` を渡す
- core のリクエストオブジェクトの検証は、`use` が `sig` 以外の鍵と、2048 ビット未満の RSA の鍵を使わない。`alg` のない RSA の鍵は、RS256 の検証にだけ使う
- experimental の `validateClientMetadata()` は、`jwks_uri` を既定で検査して登録する（これまでは無視していた）。取得しない OP は `acceptJwksUri: false` を渡す

## 背景

クライアントが鍵を入れ替えるたびに OP の登録を書き換えなくて済むよう、RFC 7591 §2 は `jwks` より `jwks_uri` を勧めている。
`request_object_signing_alg` を登録したクライアントのリクエストオブジェクトは、その alg で署名されていなければ拒否しなければならない（OIDC Core 1.0 §6.3.2）。
また、これまでの検証は、`alg` を持たない鍵をヘッダーの `alg` のとおりに試していた。
RFC 8725 §3.1 は、鍵を一つの alg でだけ使い、それを確かめることを求める。
