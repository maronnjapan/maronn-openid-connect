# client_credentials グラントと、openid スコープを伴わない OAuth 2.0 のリクエスト

これまで生成される OP は、認可リクエストに `openid` スコープを必須にし、トークンエンドポイントも認可コードとリフレッシュトークン（と実験的な機能のグラント）だけに応答していた。
そのため、エンドユーザーが関わらないサービス間の呼び出しや、ID トークンの要らない API 用のアクセストークンのような、OpenID Connect ではない OAuth 2.0 のフローを組めなかった。

この PR は二つのことをする。

- `client-credentials` 機能を足し、トークンエンドポイントが `client_credentials` グラント（RFC 6749 §4.4 / OAuth 2.1 §4.2）に応答する
- `scope` に `openid` のない認可リクエストを、OAuth 2.0 の認可リクエストとして受け付ける（OIDC Core 1.0 §3.1.2.2）。設定の `requireOpenIdScope` を `true` にすれば、これまでどおり OpenID Connect のリクエストだけを受け付ける

## 設計の選択

`client_credentials` は、トークン交換やデバイスコードと同じく、機能のステップが最後まで応答する形（dispatch）にした。
認可コードとリフレッシュトークンの本流（サブジェクトの解決、ID トークン、リフレッシュトークンの発行）に三つ目の分岐として混ぜる案は採らなかった。
本流のステップは base のコードで、機能を外した OP にも残る。そこにこのグラントの分岐を置くと、機能の識別子が owner block の外に出て、`--disable client-credentials` で消せないコードになる。
エンドユーザーのいないグラントが、ユーザーの認証を前提にしたステップ（`auth_time`、`acr`、セッションに結び付くリフレッシュトークン）を通ることもなくなる。

`openid` を求めるかどうかは、機能ではなく base の設定（`requireOpenIdScope`）にした。
認可エンドポイントの検証ステップが呼ぶ core の関数の振る舞いを変えるもので、機能のブロックを足して実現できる形ではないからである。
PAR とデバイス認可のエンドポイントも同じ設定を読むので、機能の間で値を共有する場所としても base の設定が合う。

## validateAuthorizationScope, requireExplicitAuthorizationScope, validateAuthorizationScopeNotEmpty <!-- core:authorization-request.ts#validateAuthorizationScope core:authorization-request.ts#requireExplicitAuthorizationScope core:authorization-request.ts#validateAuthorizationScopeNotEmpty -->

`openid` のないリクエストは OpenID Connect のリクエストではないが、有効な OAuth 2.0 のリクエストでありうる（OIDC Core 1.0 §3.1.2.2）。
それを受け付けるかどうかを呼び出し側が選べるように、オプション `requireOpenIdScope` を足した。
省略時は `true` で、core を直接使う側の振る舞いは変わらない。

`false` のときに `scope` のないリクエストを `invalid_request` ではなく `invalid_scope` にするのは、RFC 6749 §3.3 に合わせるためである。
`scope` を省いたリクエストは、既定のスコープで処理するか、不正なスコープとして失敗させなければならず、この認可サーバーは既定のスコープを持たない。
空白だけの `scope` は、`openid` の確認が無くなると値が一つもないまま通ってしまうので、別に確かめる。

気をつけること:
- `false` でも、クエリに `scope` が要る規則（OIDC Core 1.0 §6.1）は変えていない。リクエストオブジェクトだけに `scope` を書いたリクエストは通らない
- `openid` があるかどうかは、これまでどおりリクエストオブジェクトを適用した後の値で見る

## validateOpenIdScopeForResponseType <!-- core:authorization-request.ts#validateOpenIdScopeForResponseType -->

`code` 以外の `response_type` は、OpenID Connect が定めるインプリシットフローとハイブリッドフローの値である（OIDC Core 1.0 §3.2.2.1、§3.3.2.1）。
これらは認可エンドポイントで ID トークンを発行するので、`openid` のないリクエストを受け付ける設定でも `openid` を求める。
確認を各フローの機能ではなく base の検証に置いたのは、`code` 以外の値に応答する機能が増えても確認を足し忘れないようにするためである。

## validateClientCredentialsGrantAllowed, validateClientCredentialsConfidentialClient <!-- core:client-credentials-grant.ts#validateClientCredentialsGrantAllowed core:client-credentials-grant.ts#validateClientCredentialsConfidentialClient -->

このグラントを使えるのは、`grant_types` に `client_credentials` を登録したコンフィデンシャルクライアントだけである（RFC 6749 §4.4、RFC 7591 §2）。
パブリッククライアントは `client_id` を名乗るだけで認証していないので、登録に `client_credentials` があっても発行しない。
二つを別の関数にしたのは、生成されたコードが一つずつ呼び、片方だけを差し替えられるようにするためである。

## resolveClientCredentialsScope, validateClientCredentialsScopeAllowed, validateClientCredentialsScopeRegistered <!-- core:client-credentials-grant.ts#resolveClientCredentialsScope core:client-credentials-grant.ts#validateClientCredentialsScopeAllowed core:client-credentials-grant.ts#validateClientCredentialsScopeRegistered -->

このグラントには同意画面がなく、要求を確かめるエンドユーザーがいない。
そのため、発行するスコープの根拠をクライアントの登録（`scope`）だけにした。
認可エンドポイントは `scope` を登録していないクライアントを制限しないが、ここで同じ扱いにすると、登録の無いクライアントがどのスコープでも自分に発行できてしまう。

`openid` を発行しないのは、`sub` がクライアントを指すトークンが UserInfo エンドポイントの確認（`openid` スコープ）を通らないようにするためである。
`client_id` と同じ値のサブジェクトを持つユーザーがいると、そのユーザーのクレームを返してしまう。
`offline_access` は、このグラントがリフレッシュトークンを返さない（RFC 6749 §4.4.3）ので発行しない。

気をつけること:
- `scope` を省いたリクエストには、登録したスコープのすべて（`openid` と `offline_access` を除く）を発行する。必要なスコープだけを持つトークンにしたいクライアントは、`scope` を指定する
- スコープを登録していないクライアントには、スコープのないトークンを発行する。リソースサーバーは、スコープが無いトークンに権限を与えないこと

## resolveClientCredentialsAudience <!-- core:client-credentials-grant.ts#resolveClientCredentialsAudience -->

リソースサーバーは `aud` で、自分宛てのトークンかどうかを確かめる（RFC 9068 §3）。
エンドユーザーの同意がないグラントで、クライアントが名乗っただけのリソースを `aud` に入れると、その確認が意味を持たなくなる。
そのため、許可リストにある値だけを通し、リストが空ならすべて拒否する（トークン交換の `allowedTargets` と同じ、安全側の既定）。

気をつけること: 許可リストは OP 全体で一つで、クライアントごとではない。クライアントごとに発行先を絞るときは、生成されたステップのこの呼び出しの後に確認を足す。

## buildValidatedClientCredentialsRequest, buildClientCredentialsTokenResponse <!-- core:client-credentials-grant.ts#buildValidatedClientCredentialsRequest core:client-credentials-grant.ts#buildClientCredentialsTokenResponse -->

リソースオーナーが関わらないグラントのアクセストークンでは、`sub` をクライアントを示す値にする（RFC 9068 §2.2）。
レスポンスにリフレッシュトークンと ID トークンを入れない（RFC 6749 §4.4.3）ことを、組み立てる関数の形で保証する。

気をつけること: クライアントの ID とユーザーのサブジェクトが同じ値になりうる構成では、リソースサーバーが両者を取り違えないように名前空間を分ける（RFC 9068 §5）。

## buildAccessTokenPayload, buildAccessTokenResponse <!-- core:token-response.ts#buildAccessTokenPayload core:introspection.ts#buildAccessTokenResponse -->

スコープを登録していないクライアントの `client_credentials` グラントで、初めてスコープのないアクセストークンが発行される。
`scope` は一つ以上の値を空白で区切った文字列なので（RFC 6749 §3.3）、空文字列を入れずにクレームごと省く。
JWT のペイロードとイントロスペクションのレスポンスで同じ扱いにした。

スコープを一つ以上持つトークンの出力は変わらない。

## token <!-- endpoint:token nextjs:app/token/route.ts#token -->

`client_credentials` のリクエストに応答するブロックを、クライアントの認証の直後に足した。
ほかの機能のグラントと同じく、`grant_type` の検証（認可コードとリフレッシュトークン以外を `unsupported_grant_type` にする）より前で応答を終える。
`--disable client-credentials` でブロックを外すと、このグラントは `unsupported_grant_type` になる。

## issueClientCredentialsToken, dispatchClientCredentials <!-- hono:oidc-provider/features/client-credentials/steps/dispatch-client-credentials.ts#issueClientCredentialsToken nextjs:app/_oidc-provider/features/client-credentials/grant.ts#dispatchClientCredentials -->

グラントの検証からトークンの発行と保存までを、機能のステップ一つにまとめた。
検証は core の関数を一つずつ呼ぶので、エンドポイントから core まで型で辿れる。

`aud` に UserInfo エンドポイントを入れないのは、このトークンが `openid` を持たず、UserInfo エンドポイントで使えないからである。
`audience` の指定が無ければ、既定のリソースとして issuer を入れる（RFC 9068 §3）。
認可コードも同意もないので、グラント ID は付けない。

気をつけること:
- 許可するオーディエンスは、設定の `clientCredentialsAllowedAudiences`（Next.js は `OIDC_CLIENT_CREDENTIALS_ALLOWED_AUDIENCES`）で渡す。既定は空で、`audience` を指定したリクエストは `invalid_target` になる
- 発行したトークンは、イントロスペクションと失効のエンドポイントが読めるようにストアに保存する

## validateAuthorizationRequestParams, authorize <!-- hono:oidc-provider/endpoints/authorize/steps/validate-request.ts#validateAuthorizationRequestParams nextjs:app/authorize/route.ts#authorize -->

設定の `requireOpenIdScope` を core の検証に渡し、`code` 以外の `response_type` には設定によらず `openid` を求める。

既定を `false`（`openid` のないリクエストを受け付ける）にしたので、生成される OP の振る舞いが変わる。
これまで `invalid_scope` で拒否していたリクエストがログイン画面へ進み、認可コードを交換するとアクセストークンだけが返る。
ID トークンは発行されず、そのアクセストークンを UserInfo エンドポイントは `insufficient_scope` で拒否する（どちらも、スコープに `openid` があるかで決まる既存の規則である）。

気をつけること:
- OpenID Connect のリクエストだけを受け付ける OP に戻すには、`requireOpenIdScope: true` を渡す（Next.js は `OIDC_REQUIRE_OPENID_SCOPE=1`）
- 既定の設定では、`scope` のないリクエストのエラーが `invalid_request` から `invalid_scope` に変わる

## validatePushedAuthorizationParams, validatePushedRequest, pushAuthorizationRequest <!-- experimental:par/par-request.ts#validatePushedAuthorizationParams hono:oidc-provider/features/par/endpoints/par/steps/validate-request.ts#validatePushedRequest nextjs:app/(par)/par/route.ts#pushAuthorizationRequest -->

認可サーバーは、PAR のリクエストを認可エンドポイントと同じ規則で検証しなければならない（RFC 9126 §2.1）。
認可エンドポイントだけが `openid` のないリクエストを受け付けると、同じリクエストが直接なら通り、PAR では拒否されることになるので、同じ設定を渡す。

## validateDeviceAuthorizationScope, processDeviceAuthorizationRequest, validateDeviceAuthorizationRequest, deviceAuthorization <!-- experimental:device-authorization-grant/device-authorization-request.ts#validateDeviceAuthorizationScope experimental:device-authorization-grant/device-authorization-request.ts#processDeviceAuthorizationRequest hono:oidc-provider/features/device-authorization-grant/endpoints/device-authorization/steps/validate-request.ts#validateDeviceAuthorizationRequest nextjs:app/(device-authorization-grant)/device_authorization/route.ts#deviceAuthorization -->

デバイス認可グラントは OAuth 2.0 のグラントで、`openid` を求めない（RFC 8628 §3.1）。
これまでは認可エンドポイントと同じ制限を課していたので、認可エンドポイントが `openid` のないリクエストを受け付けるなら、デバイス認可も同じ設定に従わせる。

Hono のステップは、設定を読むためにリクエストコンテキストを受け取るようにした。

気をつけること: `scope` の省略には引き続き対応しない（既定のスコープを持たないため）。`requireOpenIdScope` が `false` のとき、そのエラーは `invalid_scope` になる。

## device-authorization <!-- endpoint:device-authorization -->

検証のステップにリクエストコンテキストを渡すようにした（ステップが設定の `requireOpenIdScope` を読むため）。

## redeemDeviceCode <!-- hono:oidc-provider/features/device-authorization-grant/steps/dispatch-device-code.ts#redeemDeviceCode nextjs:app/_oidc-provider/features/device-authorization-grant/grant.ts#redeemDeviceCode -->

これまでは、デバイス認可エンドポイントが `openid` を必須にしていることを前提に、ID トークンを必ず発行していた。
`openid` のないデバイス認可を受け付けるようになったので、標準のグラントと同じく、スコープに `openid` があるときだけ発行する。
`acr` と `amr` はリフレッシュトークンのレコードにも保存するので、ID トークンを発行しないときも決める。

## 背景

CIBA は仕様が `openid` を求めるので（CIBA Core 1.0 §7.1）、設定によらず必須のままにした。
ID-JAG がリフレッシュトークンに `openid` を求める確認も変えていない。
