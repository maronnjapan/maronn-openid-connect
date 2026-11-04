# クライアントの jwks_uri と request_object_signing_alg

クライアントが鍵を入れ替えるたびに OP の登録を書き換えなくて済むよう、静的に登録したクライアントにも動的に登録したクライアントにも `jwks_uri`（RFC 7591 §2）を登録できるようにする。
OP は署名付きのリクエストオブジェクトを検証するときに `jwks_uri` から鍵を取得してキャッシュし、見慣れない `kid` では取り直す（OIDC Core 1.0 §10.1.1）。
クライアントが `request_object_signing_alg`（OIDC Dynamic Client Registration 1.0 §2）を登録していれば、その alg で署名したリクエストオブジェクトだけを受け付ける（OIDC Core 1.0 §6.3.2）。
あわせて、リクエストオブジェクトの検証で鍵ごとに使える alg を一つに決め、ヘッダーの `alg` と一致する鍵だけを使う（RFC 8725 §3.1）。

`jwks_uri` から鍵を取る関数（取得、期限、キャッシュ、生成コードのリゾルバ）は、地図では届く先が無いと出る。
鍵は `ClientKeyResolver.findClientKeys()`（型で追えない呼び出し）の先で読むからで、実際には /authorize のリクエストオブジェクトの検証から呼ばれる。

## parseRequestObject, loadVerificationKeys <!-- core:request-object.ts#parseRequestObject core:request-object.ts#loadVerificationKeys -->

鍵を読むのを、登録した alg、`none`、受け付けない alg を確かめた後に移した。
受け付けないリクエストオブジェクトのために `jwks_uri` へ通信しないためで、値で鍵を受け取る `jwks` のオプションは、検査の前に鍵を用意させる経路が残るので削除した。
登録した alg の検査を最初に置くのは、OIDC Core 1.0 §6.3.2 が、登録した alg 以外（`none` を含む）を拒否することを求めるからである。

気をつけること:
- `use` が `sig` 以外の鍵と 2048 ビット未満の RSA の鍵は、検証に使わなくなる。`alg` の無い RSA の鍵は RS256 の検証にだけ使う。これまで通っていたリクエストオブジェクトが拒否されることがある
- `jwks_uri` の取得の失敗は、理由を含まない固定の文言にする（`loadVerificationKeys`）。理由は OP の内側のネットワークを探る手がかりになるので、生成コードが `console.warn` に書くログで見る

## resolveRequestObjectParams <!-- core:authorization-request.ts#resolveRequestObjectParams -->

受け付ける alg の既定を RS256 だけにしていたのは、互換を保つためだった。
鍵と alg を一対一に固定したので、core が検証できるすべての alg（`SUPPORTED_REQUEST_OBJECT_SIGNING_ALGS`）を既定にしても alg の取り違えは起きず、生成コードの既定とも揃う。

気をつけること: RS256 だけを受け付けたい呼び出し側は `supportedSigningAlgs: ['RS256']` を渡す。値で持つ鍵は `loadJwks: async () => jwks` で渡す。

## resolveJwkSigningAlg, importJwkForJwsVerification, rsaSigningHashOf, ecSigningCurveOf, ecSigningAlgOfCurve <!-- core:crypto-utils.ts#resolveJwkSigningAlg core:crypto-utils.ts#importJwkForJwsVerification core:crypto-utils.ts#rsaSigningHashOf core:crypto-utils.ts#ecSigningCurveOf core:crypto-utils.ts#ecSigningAlgOfCurve -->

鍵は一つの alg でだけ使い、それを確かめる（RFC 8725 §3.1）という規則を、鍵の種類と alg の対応の一か所にまとめた。
`alg` の無い RSA の鍵を RS256 とみなすのは、DCR の `validateJwks()` の正規化と同じ規則にそろえるためである。

気をつけること: RSA-PSS（PS256 など）は検証できないので、その alg を持つ鍵は使わない。

## validateClientJwksUri, isBlockedHost, isBlockedIpv4, isBlockedIpv6, parseIpv4Octets, parseIpv6Groups, authorityOf <!-- core:client-jwks-uri.ts#validateClientJwksUri core:client-jwks-uri.ts#isBlockedHost core:client-jwks-uri.ts#isBlockedIpv4 core:client-jwks-uri.ts#isBlockedIpv6 core:client-jwks-uri.ts#parseIpv4Octets core:client-jwks-uri.ts#parseIpv6Groups core:client-jwks-uri.ts#authorityOf -->

`jwks_uri` はクライアントが決める URL で、OP がそこへ取りに行く。
そのため、OP の内側のネットワーク（ループバック、私設、リンクローカル、クラウドのメタデータ）へ届かせる SSRF の踏み台になりうる（RFC 8725 §3.10、RFC 9101 §10.4.1）。
地図では DCR の登録にだけ届くと出るが、鍵を取るたびに、キャッシュと取得の関数もこの検査を通す。

気をつけること:
- 見るのはホスト名で、DNS の解決先は見ない（Web 標準の API では解決先を得られない）。解決先まで縛るときは、egress プロキシを通る fetch を注入する（生成コードの `clientJwksFetch`）
- `allowInsecure`（生成コードの `allowInsecureClientJwksUri`）は開発用で、本番では有効にしない

## fetchClientJwkSet, readBodyWithin, discardBody, errorNameOf, parseClientJwkSet, toSigningJwk, hasRsaModulusOfAtLeast, isJsonObject <!-- core:client-jwks-uri.ts#fetchClientJwkSet core:client-jwks-uri.ts#readBodyWithin core:client-jwks-uri.ts#discardBody core:client-jwks-uri.ts#errorNameOf core:client-jwks-uri.ts#parseClientJwkSet core:client-jwks-uri.ts#toSigningJwk core:client-jwks-uri.ts#hasRsaModulusOfAtLeast core:client-jwks-uri.ts#isJsonObject -->

外部への取得なので、時間（タイムアウト）、大きさ（本文と鍵の数）、行き先（リダイレクトに従わない。リダイレクト先は宛先の検査を通っていない）を限った。
秘密鍵か対称鍵を含む JWK Set を全体で拒否するのは、OIDC Dynamic Client Registration 1.0 §2 が禁じており、秘密鍵を公開してしまった RP に気づかせるためである。
エラーのメッセージに元のエラーの名前だけを載せる（`errorNameOf`）のは、宛先から返った内容をログに流し込まないためである。

気をつけること: `redirect: 'error'` を受け付けない実行環境（Cloudflare Workers）があるので、`redirect: 'manual'` にして 3xx を拒否している。

## resolveClientJwksTtlSeconds, parseCacheControl, parseDeltaSeconds, unquote <!-- core:client-jwks-uri.ts#resolveClientJwksTtlSeconds core:client-jwks-uri.ts#parseCacheControl core:client-jwks-uri.ts#parseDeltaSeconds core:client-jwks-uri.ts#unquote -->

RP が `Cache-Control` で知らせる期限で、鍵の入れ替えを反映するため（RFC 9111）。
下限は 1 リクエストごとに外部へ取りに行くのを防ぎ、上限は失効した鍵を使い続ける最長の時間を決める。

気をつけること: `no-store` と `no-cache` でも、下限（既定 30 秒）のあいだは使う。仕様どおりにするには下限を 0 にする。

## createClientJwksUriCache, copyOf, withClientJwksUriKeys, isClientJwksUriError <!-- core:client-jwks-uri.ts#createClientJwksUriCache core:client-jwks-uri.ts#copyOf core:client-jwks-uri.ts#withClientJwksUriKeys core:client-jwks-uri.ts#isClientJwksUriError -->

リクエストオブジェクトのたびに `jwks_uri` へ取りに行かないため、`jwks_uri` ごとに鍵を覚える。
見慣れない `kid` で取り直すのは、RP が鍵を足して入れ替えたことに追いつくためである（OIDC Core 1.0 §10.1.1）。
期限切れの鍵を使わないのは、失効させた鍵を受け付けないためである。
`isClientJwksUriError` がクラスではなく形でエラーを見分けるのは、Next.js が core を 2 度読み込むと `instanceof` が偽になるからである。

気をつけること:
- キャッシュはプロセスごとにあり、複数のインスタンスでは別々に取得する
- 取り直しの間隔（既定 30 秒）のあいだは、見慣れない `kid` のリクエストオブジェクトは拒否される

## validateClientMetadata, validateJwksUri, validateRequestObjectSigningAlg, buildRegisteredClient <!-- experimental:dynamic-client-registration/registration-request.ts#validateClientMetadata experimental:dynamic-client-registration/metadata-values.ts#validateJwksUri experimental:dynamic-client-registration/metadata-values.ts#validateRequestObjectSigningAlg experimental:dynamic-client-registration/registered-client.ts#buildRegisteredClient -->

RFC 7591 §2 は `jwks` より `jwks_uri` を勧めるので、`jwks_uri` を既定で受け付ける。
登録の時点で取得しないのは、オープン登録の受け口をそのまま外部への取得の引き金にしないためである。
`request_object_signing_alg` は、リクエストオブジェクトを扱う OP（`requestObjectSigningAlgValuesSupported` を渡した OP）でだけ理解する。
扱わない OP では、理解しないメタデータとして無視する（RFC 7591 §2 の MUST）。

気をつけること:
- これまで無視していた正しくない `jwks_uri` は、`invalid_client_metadata` で拒否される。`jwks_uri` を取得しない OP は `acceptJwksUri: false` を渡す
- `jwks` と `request_object_signing_alg` を両方登録するときは、その alg で使える鍵が `jwks` に要る。登録はできるのに検証できないクライアントを作らないためである

## withRegisteredClientJwksUri, clientJwksUriLoadOptionsOf, hostOf, setRequestContext, secondsFromEnvironment <!-- hono:oidc-provider/client-jwks-uri.ts#withRegisteredClientJwksUri nextjs:app/_oidc-provider/client-jwks-uri.ts#withRegisteredClientJwksUri hono:oidc-provider/client-jwks-uri.ts#clientJwksUriLoadOptionsOf nextjs:app/_oidc-provider/client-jwks-uri.ts#clientJwksUriLoadOptionsOf hono:oidc-provider/client-jwks-uri.ts#hostOf nextjs:app/_oidc-provider/client-jwks-uri.ts#hostOf hono:oidc-provider/app.ts#setRequestContext nextjs:app/_oidc-provider/provider.ts#secondsFromEnvironment -->

生成コードで、`jwksUri` を持つクライアントの鍵の出どころを `jwks_uri` だけにし、ほかのクライアントは今までどおり db/ か渡したリゾルバに任せるため。
`createApp()` / `applyOidc()` に渡したリゾルバも包む（`setRequestContext`）のは、リゾルバを差し替えても `jwks_uri` が効くようにするためである。
Next.js の provider.ts は、取得とキャッシュの設定の一部を環境変数（`OIDC_CLIENT_JWKS_URI_CACHE_TTL_SECONDS`、`OIDC_CLIENT_JWKS_URI_REFETCH_INTERVAL_SECONDS`）から読む（`secondsFromEnvironment`）。

気をつけること: 使えない `jwks_uri` は、ホストと理由を `console.warn` に書き、応答には出さない。ログにはクライアントが決めたホスト名が載る。

## registerClient, assertClientJwksUriRegistration <!-- hono:oidc-provider/db/kv/clients.ts#registerClient hono:oidc-provider/db/memory/clients.ts#registerClient hono:oidc-provider/db/sql/clients.ts#registerClient nextjs:app/_oidc-provider/db/kv/clients.ts#registerClient nextjs:app/_oidc-provider/db/memory/clients.ts#registerClient nextjs:app/_oidc-provider/db/sql/clients.ts#registerClient hono:oidc-provider/client-jwks-uri.ts#assertClientJwksUriRegistration nextjs:app/_oidc-provider/client-jwks-uri.ts#assertClientJwksUriRegistration -->

RFC 7591 §2 は `jwks` と `jwks_uri` を同時に使うことを禁じる。
鍵の出どころをクライアントごとに一つにするため、`jwksUri` と `keys` を両方持つクライアントを、何も書き込む前に拒否する。
`jwksUri` の宛先がよいかは、登録の時点ではなく取得するときに `allowInsecureClientJwksUri` で決める（開発と本番で同じ登録を使えるようにするため）。

気をつけること:
- SQL は新しいテーブル（`client_jwks_uris`、`client_request_object_signing_algs`）に書く。`schema.sql` は `CREATE TABLE IF NOT EXISTS` なので、実行し直せば既存の DB にも足される
- `jwksUri` や `requestObjectSigningAlg` を持たない登録は、登録済みの値を消す

## createClientResolver <!-- hono:oidc-provider/db/kv/clients.ts#createClientResolver hono:oidc-provider/db/sql/clients.ts#createClientResolver nextjs:app/_oidc-provider/db/kv/clients.ts#createClientResolver nextjs:app/_oidc-provider/db/sql/clients.ts#createClientResolver -->

保存した `jwksUri` と `requestObjectSigningAlg` を、リクエストオブジェクトの検証と鍵のリゾルバに渡すため。

気をつけること: 地図は `findClient()` を使うすべてのエンドポイント（/authorize、/consent、/token、/userinfo、/par）に届くと出すが、増えるのは返すクライアントの 2 つのフィールドだけで、ほかのフィールドと判定は変わらない。

## resolveRequestObject <!-- hono:oidc-provider/features/request-object/steps/resolve-request-object.ts#resolveRequestObject nextjs:app/_oidc-provider/features/request-object/authorize.ts#resolveRequestObject -->

鍵を読むのをヘッダーの検査の後にし（`loadJwks`）、`kid` を手がかりに渡して、`jwks_uri` を登録したクライアントの鍵の入れ替えに追いつくため。
クライアントが登録した alg を渡すのは、OIDC Core 1.0 §6.3.2 のためである。

気をつけること: 受け付ける alg の既定は RS256 だけから 6 種類になり、ディスカバリーの `request_object_signing_alg_values_supported` も同じになる。RS256 だけに戻すには、設定の `requestObjectSigningAlgValuesSupported` を `['RS256']` にする。

## validateRegistrationMetadata, registrableRequestObjectSigningAlgs, registerClient <!-- hono:oidc-provider/features/dynamic-client-registration/endpoints/register/steps/validate-metadata.ts#validateRegistrationMetadata hono:oidc-provider/features/dynamic-client-registration/endpoints/register/steps/validate-metadata.ts#registrableRequestObjectSigningAlgs nextjs:app/(dynamic-client-registration)/register/route.ts#registrableRequestObjectSigningAlgs nextjs:app/(dynamic-client-registration)/register/route.ts#registerClient -->

登録で受け付ける `request_object_signing_alg` を、ディスカバリーが公開する一覧と同じにして、登録できるのに使えない alg を作らないため。
`jwks_uri` の宛先の方針を、取得するときと同じ `allowInsecureClientJwksUri` にそろえるためでもある。

気をつけること: request-object の機能を外した OP は、`request_object_signing_alg` を理解しないメタデータとして無視する。

## toClientRegistration, withDynamicallyRegisteredClientKeys <!-- hono:oidc-provider/features/dynamic-client-registration/store.ts#toClientRegistration nextjs:app/_oidc-provider/features/dynamic-client-registration/store.ts#toClientRegistration hono:oidc-provider/features/dynamic-client-registration/store.ts#withDynamicallyRegisteredClientKeys nextjs:app/_oidc-provider/features/dynamic-client-registration/store.ts#withDynamicallyRegisteredClientKeys -->

動的に登録したクライアントも、静的なクライアントと同じく `jwks_uri` と登録した alg を使えるようにするため。
鍵のリゾルバが手がかり（`hint`）を元のリゾルバへそのまま渡すのは、`jwks_uri` を取り直す合図（`kid`）を落とさないためである。

## 破壊的変更

- core の `parseRequestObject()` と `resolveRequestObjectParams()` の `jwks` オプションを削除した。値で持つ鍵は `loadJwks: async () => jwks` で渡す
- core の `DEFAULT_REQUEST_OBJECT_SIGNING_ALGS` を削除し、`resolveRequestObjectParams()` の受け付ける alg の既定値を `SUPPORTED_REQUEST_OBJECT_SIGNING_ALGS` にした。RS256 だけに絞るときは `supportedSigningAlgs: ['RS256']` を渡す
- core のリクエストオブジェクトの検証は、`use` が `sig` 以外の鍵と、2048 ビット未満の RSA の鍵を使わない。`alg` の無い RSA の鍵は、RS256 の検証にだけ使う
- experimental の `validateClientMetadata()` は、`jwks_uri` を既定で検査して登録する（これまでは無視していた）。取得しない OP は `acceptJwksUri: false` を渡す

## 背景

RFC 7591 §2 は、鍵を入れ替えられるよう `jwks` より `jwks_uri` を勧めている。
`request_object_signing_alg` を登録したクライアントのリクエストオブジェクトは、その alg で署名されていなければ拒否しなければならない（OIDC Core 1.0 §6.3.2）。
また、これまでの検証は、`alg` を持たない鍵をヘッダーの `alg` のとおりに試していた。
RFC 8725 §3.1 は、鍵を一つの alg でだけ使い、それを確かめることを求める。
