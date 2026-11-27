# グラントの dispatch が、発行するトークンを鍵に束縛できるようにする（DPoP の段 8）

DPoP（RFC 9449）を生成 OP に入れる段の 8 つ目で、機能が答えるグラント（client_credentials、デバイス認可、CIBA、トークン交換、ID-JAG の引き換え）の dispatch に、段 7 と同じ省略できる入力 `binding`（`TokenBinding`）を足す。
RFC 9449 §5 は、DPoP proof を送ったトークンリクエストで発行するアクセストークンを、グラントの種類によらずその鍵に束縛するとしている。
標準のグラント（認可コードとリフレッシュトークン）のステップだけでなく、自分でトークンを発行して応答まで行う dispatch も、束縛を受け取れなければならない。
束縛があれば、アクセストークンのペイロードに `cnf`（§6.1）が入り、保存するレコードに `cnf` と `tokenType`（§6.2 のイントロスペクションのため）が残り、レスポンスの `token_type` が束縛の `tokenType` になる。
リフレッシュトークンを発行するデバイス認可と CIBA は、束縛が `refreshTokenCnf` を持つときだけ、リフレッシュトークンも束縛する。
値はすべて段 7 の `token-binding.ts` の関数から得るので、グラントごとに束縛の値を組み立てるコードは無い。
この段では、まだどのパイプラインも Route Handler も束縛を渡さないので、どのグラントの応答も保存するレコードも変わらない。
Hono のステップの `tokenBinding` は `optional` の入力にしたので、それをつくるステップの無い生成（この段ではすべて）では、フローのデータから消える。

## issueClientCredentialsToken, dispatchClientCredentials <!-- hono:oidc-provider/features/client-credentials/steps/dispatch-client-credentials.ts#issueClientCredentialsToken nextjs:app/_oidc-provider/features/client-credentials/grant.ts#dispatchClientCredentials -->

client_credentials のアクセストークンも、DPoP proof の鍵に束縛できるようにした。
クライアントがそのまま API を呼ぶトークンなので、盗まれたときに使わせないという DPoP の目的（RFC 9449 §2）が、エンドユーザーの関わるトークンと同じように当てはまるためである。

- core の `buildClientCredentialsTokenResponse()` は `token_type` を `Bearer` の型で返すので、core は変えず、返したオブジェクトを展開してから `token_type` を上書きした。core の公開 API を変えると、experimental と google-login のリリースまで要るためである
- すでにあるメンバーを上書きしてもメンバーの順番は変わらないので、束縛の無いレスポンスの JSON は前と同じになる。束縛の有無で順番が同じことをテストで確かめた
- このグラントはリフレッシュトークンを発行しない（RFC 6749 §4.4.3）ので、束縛の `refreshTokenCnf` は使わない
- PR #205 にはこのグラントの束縛のテストが無かったので、JWT のペイロードとレコードに `cnf` が入ることを確かめるテストを足した（Hono では不透明な文字列のトークンのレコードも確かめた）

## redeemDeviceCode, dispatchDeviceCode, redeemCibaRequest, dispatchCiba <!-- hono:oidc-provider/features/device-authorization-grant/steps/dispatch-device-code.ts#redeemDeviceCode nextjs:app/_oidc-provider/features/device-authorization-grant/grant.ts#dispatchDeviceCode nextjs:app/_oidc-provider/features/device-authorization-grant/grant.ts#redeemDeviceCode hono:oidc-provider/features/ciba/steps/dispatch-ciba.ts#redeemCibaRequest nextjs:app/_oidc-provider/features/ciba/grant.ts#dispatchCiba nextjs:app/_oidc-provider/features/ciba/grant.ts#redeemCibaRequest -->

`device_code` と `auth_req_id` を引き換えて発行するアクセストークンを鍵に束縛し、束縛が `refreshTokenCnf` を持つときはリフレッシュトークンも束縛するようにした。
experimental の `processDeviceCodeGrant()` と `processCibaGrant()` は承認済みのグラントを返すだけで、トークンの発行と保存は生成コードのこの関数が行うので、束縛もここで行う。experimental は変えていない。

- リフレッシュトークンを束縛するかどうかは、関数の中でクライアントの種類から決めず、束縛の `refreshTokenCnf` の有無に従う。RFC 9449 §5 は、パブリッククライアントのリフレッシュトークンを束縛し、機密クライアントのものは束縛しない（クライアント認証で送り手が制約されている）としていて、その判断は束縛をつくる機能（後の段の DPoP の機能）が一か所で行うためである。段 7 の `issueRefreshToken()` と同じ規則である
- CIBA のクライアントはバックチャネル認証エンドポイントでクライアント認証をする（CIBA Core 1.0 §7.1）機密クライアントなので、`refreshTokenCnf` の無い束縛ではリフレッシュトークンを束縛しないことをテストで確かめた（デバイス認可も同じ）
- Next.js の `dispatchDeviceCode()` と `dispatchCiba()` は、受け取った束縛を `redeemDeviceCode()` と `redeemCibaRequest()` へ渡すだけである

## exchangeToken, dispatchTokenExchange <!-- hono:oidc-provider/features/token-exchange/steps/dispatch-token-exchange.ts#exchangeToken nextjs:app/_oidc-provider/features/token-exchange/grant.ts#dispatchTokenExchange nextjs:app/_oidc-provider/features/token-exchange/grant.ts#exchangeToken -->

トークン交換（RFC 8693）で新しく発行するアクセストークンを、交換を求めたクライアントの DPoP proof の鍵に束縛できるようにした。
トークン交換もトークンエンドポイントへのトークンリクエストなので、RFC 9449 §5 の束縛がそのまま当てはまるためである。

- 束縛するのは交換して発行するトークンだけで、`subject_token` が鍵に束縛されていても、その鍵の DPoP proof は求めない。`subject_token` を提示するのはその鍵を持たないリソースサーバーであることが多く、RFC 8693 も RFC 9449 もそれを求めないためである
- core の `buildTokenExchangeResponse()` の `token_type` を上書きするのは、client_credentials と同じ理由である。束縛の無いレスポンスのメンバーの順番が変わらないことをテストで確かめた
- Next.js の `dispatchTokenExchange()` は、受け取った束縛を `exchangeToken()` へ渡すだけである

## redeemIdJag, dispatchIdJagRedemption <!-- hono:oidc-provider/features/id-jag/steps/dispatch-id-jag-redemption.ts#redeemIdJag nextjs:app/_oidc-provider/features/id-jag/grant.ts#dispatchIdJagRedemption nextjs:app/_oidc-provider/features/id-jag/grant.ts#redeemIdJag -->

ID-JAG を jwt-bearer グラントで引き換えて、この OP が発行するアクセストークンを鍵に束縛できるようにした。
引き換えもトークンリクエストで、発行するのはこの OP のアクセストークンなので、RFC 9449 §5 の束縛が当てはまるためである。

- リフレッシュトークンは発行しない（ID-JAG draft §4.4.3）ので、束縛の `refreshTokenCnf` は使わない
- ID-JAG を発行するトークン交換（`dispatchIdJagIssuance()`）は束縛しない。ID-JAG はアクセストークンではなく、RFC 9449 の束縛の対象ではないためである
- Next.js の `redeemIdJag()` は `answerIdJagError()` に渡すコールバックの中から呼ぶので、地図はそこからエンドポイントまでを辿れない。テストは `dispatchIdJagRedemption()` を通して、束縛がアクセストークンとレコードに届くことを確かめた
