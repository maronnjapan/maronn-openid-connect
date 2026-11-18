# DPoP（RFC 9449）を拡張機能として加える

DPoP を、experimental ではなく google-login と同じ拡張機能（専用の package `@maronn-openid-connect/dpop`、既定は無効、`--enable dpop`）として加える。クライアントが DPoP proof を送ると、トークンエンドポイントがトークンをその鍵に束縛し、UserInfo エンドポイントは同じ鍵の DPoP proof の付いた提示だけを受け付ける。DPoP proof を送らないクライアントには、有効にしても従来どおり Bearer トークンを発行する。

本体（機能に属さないコード）には DPoP を知らない口だけを足した。トークンを鍵に束縛する `TokenBinding` と `cnf`、UserInfo の失敗のチャレンジの認証スキーム、機能が CORS に加えるヘッダーである。dpop を生成しない OP の動きは変わらない。

## decodeBase64Url, encodeBase64Url, isDpopError, normalizeDpopHtu, computeJwkThumbprint, ecProfile, invalidJwk, isSupportedDpopSigningAlg, profileOf, rsaModulusBits, validateDpopProofJwk, verifyJwsSignature, computeDpopAccessTokenHash, consumeDpopProofJti, decodeDpopProof, decodeJsonObject, invalidProof, readDpopProofHeader, validateDpopProofAccessTokenHash, validateDpopProofAlg, validateDpopProofClaims, verifyDpopProofSignature <!-- dpop:base64url.ts#decodeBase64Url dpop:base64url.ts#encodeBase64Url dpop:errors.ts#isDpopError dpop:htu.ts#normalizeDpopHtu dpop:jwk.ts#computeJwkThumbprint dpop:jwk.ts#ecProfile dpop:jwk.ts#invalidJwk dpop:jwk.ts#isSupportedDpopSigningAlg dpop:jwk.ts#profileOf dpop:jwk.ts#rsaModulusBits dpop:jwk.ts#validateDpopProofJwk dpop:jwk.ts#verifyJwsSignature dpop:proof.ts#computeDpopAccessTokenHash dpop:proof.ts#consumeDpopProofJti dpop:proof.ts#decodeDpopProof dpop:proof.ts#decodeJsonObject dpop:proof.ts#invalidProof dpop:proof.ts#readDpopProofHeader dpop:proof.ts#validateDpopProofAccessTokenHash dpop:proof.ts#validateDpopProofAlg dpop:proof.ts#validateDpopProofClaims dpop:proof.ts#verifyDpopProofSignature -->

RFC 9449 §4.3 の検査を、core と同じく責務ごとの関数に分けて新しいパッケージに置いた。生成コードのステップがこれを順に呼び、どれか一つを外したり独自の方針を挟んだりできる。

- 拡張機能にしたのは、core の安定版の API を増やさず、core のリリース契約（experimental と google-login の peer 下限）を動かさずに足すためである。パッケージは core に依存しない
- Web Crypto だけで検証するので、エッジランタイムでも動く（テストは Edge Runtime 環境）。`alg` は非対称の署名（ES / PS / RS / EdDSA）だけで、`none` と HS 系は設定に書いても受け付けない。RSA は 2048 ビット未満を拒否する
- `htu` は RFC 3986 §6.2.2 / §6.2.3 の正規化をしてから比べる。`iat` は `maxAge + leeway` の窓だけ受け付け、`jti` はその窓の終わりまで覚える
- 失敗の説明文は固定の文言だけにし、クライアントの値を入れない（`WWW-Authenticate` の引用符を壊さないため）
- 気をつけること: サーバーが発行する nonce（RFC 9449 §8 / §9）は実装していない。RFC の本文はこの環境から取得できなかったので、RFC 7638 §3.1 と RFC 9449 の例の値（JWK Thumbprint と `ath`）をテストで確かめている

## buildDpopConfirmation, parseDpopJkt, readDpopJkt, requireDpopProofForClient, resolvePushedDpopJkt, selectDpopRefreshTokenJkt, validateDpopBoundGrant, buildDpopChallenge, readDpopAuthorization, validateDpopAccessTokenBinding <!-- dpop:binding.ts#buildDpopConfirmation dpop:binding.ts#parseDpopJkt dpop:binding.ts#readDpopJkt dpop:binding.ts#requireDpopProofForClient dpop:binding.ts#resolvePushedDpopJkt dpop:binding.ts#selectDpopRefreshTokenJkt dpop:binding.ts#validateDpopBoundGrant dpop:resource.ts#buildDpopChallenge dpop:resource.ts#readDpopAuthorization dpop:resource.ts#validateDpopAccessTokenBinding -->

束縛の規則（`cnf.jkt`、`dpop_jkt`、`dpop_bound_access_tokens`、パブリッククライアントのリフレッシュトークン、Bearer での提示の拒否）を、生成コードの Hono と Next.js で同じに判定するための関数。

- 束縛した認可コードとリフレッシュトークンの鍵違いは `invalid_grant`、`dpop_jkt` の形の誤りは `invalid_request`、保護されたリソースでの鍵違いと Bearer での提示は `invalid_token` にした
- 鍵に束縛していないトークンを DPoP スキームで提示したときも `invalid_token` で拒否する（鍵を確かめようがないため）

## token, dpopSigningAlgsOf, tokenEndpointErrorOf, verifyDpopRequestProof, boundGrantRecordOf, validateDpopGrantBinding, verifyDpopTokenRequest, tokenEndpointRejectionOf <!-- endpoint:token hono:oidc-provider/features/dpop/config.ts#dpopSigningAlgsOf hono:oidc-provider/features/dpop/errors.ts#tokenEndpointErrorOf hono:oidc-provider/features/dpop/proof.ts#verifyDpopRequestProof hono:oidc-provider/features/dpop/steps/validate-dpop-grant-binding.ts#boundGrantRecordOf hono:oidc-provider/features/dpop/steps/validate-dpop-grant-binding.ts#validateDpopGrantBinding hono:oidc-provider/features/dpop/steps/verify-dpop-proof.ts#verifyDpopTokenRequest nextjs:app/_oidc-provider/features/dpop/config.ts#dpopSigningAlgsOf nextjs:app/_oidc-provider/features/dpop/errors.ts#tokenEndpointRejectionOf nextjs:app/_oidc-provider/features/dpop/proof.ts#verifyDpopRequestProof nextjs:app/_oidc-provider/features/dpop/token.ts#boundGrantRecordOf nextjs:app/_oidc-provider/features/dpop/token.ts#validateDpopGrantBinding nextjs:app/_oidc-provider/features/dpop/token.ts#verifyDpopTokenRequest nextjs:app/token/route.ts#token -->

クライアント認証の直後に DPoP proof を検査し、発行するトークンを束縛する鍵（`TokenBinding`）を決める。どの dispatch のグラントよりも前に置いたので、機能が答えるグラント（client_credentials、デバイス認可、CIBA、トークン交換、ID-JAG）のトークンも同じ鍵に束縛される。

- 束縛した認可コードとリフレッシュトークンの鍵の確認は、それを使用済みにするグラントの検証より前に行う。鍵の違うリクエストでコードやトークンを使用済みにしないためである。使用済みのものと別のクライアントのものは確かめず、再提示の検知（グラントの失効）をグラントの検証に任せる
- DPoP proof の `jti` は private_key_jwt と同じ `clientAssertionJtiStore` に、`["dpop", jkt, jti]` のキーで覚える。ストアや DB を増やさないためで、キーの形が違うので混ざらない
- `htu` はリクエストの URL ではなく issuer とパスから組み立てる。プロキシの後ろでもクライアントが見る URL と比べるため
- Next.js のトークンの Route Handler には固定の応答の例外が無いので、DPoP の失敗は組み立て済みの 400 の `Response` を返してブロックから応答する

## buildTokenResponse, issueAccessToken, persistAccessToken, redeemCibaRequest, issueClientCredentialsToken, redeemDeviceCode, redeemIdJag, describeIntrospectedToken, issueRefreshToken, exchangeToken, accessTokenClaimsOf, accessTokenRecordOf, confirmationOf, confirmationRecordOf, refreshTokenRecordOf, tokenTypeOf, withTokenBinding, introspect, dispatchCiba, dispatchClientCredentials, dispatchDeviceCode, dispatchIdJagRedemption, dispatchTokenExchange <!-- hono:oidc-provider/endpoints/token/steps/build-token-response.ts#buildTokenResponse hono:oidc-provider/endpoints/token/steps/issue-access-token.ts#issueAccessToken hono:oidc-provider/endpoints/token/steps/persist-access-token.ts#persistAccessToken hono:oidc-provider/features/ciba/steps/dispatch-ciba.ts#redeemCibaRequest hono:oidc-provider/features/client-credentials/steps/dispatch-client-credentials.ts#issueClientCredentialsToken hono:oidc-provider/features/device-authorization-grant/steps/dispatch-device-code.ts#redeemDeviceCode hono:oidc-provider/features/id-jag/steps/dispatch-id-jag-redemption.ts#redeemIdJag hono:oidc-provider/features/introspection/endpoints/introspection/steps/build-response.ts#describeIntrospectedToken hono:oidc-provider/features/refresh-token/steps/issue-refresh-token.ts#issueRefreshToken hono:oidc-provider/features/token-exchange/steps/dispatch-token-exchange.ts#exchangeToken hono:oidc-provider/token-binding.ts#accessTokenClaimsOf hono:oidc-provider/token-binding.ts#accessTokenRecordOf hono:oidc-provider/token-binding.ts#confirmationOf hono:oidc-provider/token-binding.ts#confirmationRecordOf hono:oidc-provider/token-binding.ts#refreshTokenRecordOf hono:oidc-provider/token-binding.ts#tokenTypeOf hono:oidc-provider/token-binding.ts#withTokenBinding nextjs:app/(introspection)/introspect/route.ts#introspect nextjs:app/_oidc-provider/features/ciba/grant.ts#dispatchCiba nextjs:app/_oidc-provider/features/ciba/grant.ts#redeemCibaRequest nextjs:app/_oidc-provider/features/client-credentials/grant.ts#dispatchClientCredentials nextjs:app/_oidc-provider/features/device-authorization-grant/grant.ts#dispatchDeviceCode nextjs:app/_oidc-provider/features/device-authorization-grant/grant.ts#redeemDeviceCode nextjs:app/_oidc-provider/features/id-jag/grant.ts#dispatchIdJagRedemption nextjs:app/_oidc-provider/features/id-jag/grant.ts#redeemIdJag nextjs:app/_oidc-provider/features/refresh-token/token.ts#issueRefreshToken nextjs:app/_oidc-provider/features/token-exchange/grant.ts#dispatchTokenExchange nextjs:app/_oidc-provider/features/token-exchange/grant.ts#exchangeToken nextjs:app/_oidc-provider/token-binding.ts#accessTokenClaimsOf nextjs:app/_oidc-provider/token-binding.ts#accessTokenRecordOf nextjs:app/_oidc-provider/token-binding.ts#confirmationOf nextjs:app/_oidc-provider/token-binding.ts#confirmationRecordOf nextjs:app/_oidc-provider/token-binding.ts#refreshTokenRecordOf nextjs:app/_oidc-provider/token-binding.ts#tokenTypeOf nextjs:app/_oidc-provider/token-binding.ts#withTokenBinding -->

本体は DPoP を知らない形で「トークンが鍵に束縛されている」ことだけを扱う。機能が渡す `TokenBinding`（`cnf`、`token_type`、リフレッシュトークンの `cnf`）を、トークンを発行・保存・応答するステップと各グラントの dispatch が省略できる入力として受け取る。

- `binding` が無ければ、`token_type` は `Bearer` で、アクセストークンとレコードに `cnf` は入らない。dpop を生成しない OP では、パイプラインに `const tokenBinding = undefined;` が残るだけで動きは変わらない
- `cnf` と `tokenType` は、型に列の無い値として SQL / KV のストアの `payload` にも保存される（DB のテストで確かめた）。不透明なトークンでもイントロスペクションが `cnf` と `token_type: DPoP` を返し（RFC 9449 §6.2）、UserInfo が提示の仕方と照らし合わせられる
- core の `IntrospectionResponse` は `token_type` に `DPoP` を許さないので、`withTokenBinding()` の中だけで型を広げた。core は変えていない
- 将来 mTLS（RFC 8705）のような別の送り手の制約を足すときも、`cnf` の別のメンバーとして同じ口を使える

## handler, respondUserInfoError, userInfoDpopError, userInfoEndpointErrorOf, formBodyHasAccessToken, readDpopUserInfoRequest, verifyDpopUserInfoAccess, buildUserInfoResponse, parseBearerAccessToken, respondUserInfo, userinfo <!-- hono:oidc-provider/endpoints/userinfo/pipeline.ts#handler hono:oidc-provider/endpoints/userinfo/steps/respond-error.ts#respondUserInfoError hono:oidc-provider/features/dpop/errors.ts#userInfoDpopError hono:oidc-provider/features/dpop/errors.ts#userInfoEndpointErrorOf hono:oidc-provider/features/dpop/steps/read-dpop-access-token.ts#formBodyHasAccessToken hono:oidc-provider/features/dpop/steps/read-dpop-access-token.ts#readDpopUserInfoRequest hono:oidc-provider/features/dpop/steps/verify-dpop-access-token.ts#verifyDpopUserInfoAccess nextjs:app/_oidc-provider/features/dpop/errors.ts#userInfoDpopError nextjs:app/_oidc-provider/features/dpop/errors.ts#userInfoEndpointErrorOf nextjs:app/_oidc-provider/features/dpop/userinfo.ts#formBodyHasAccessToken nextjs:app/_oidc-provider/features/dpop/userinfo.ts#readDpopUserInfoRequest nextjs:app/_oidc-provider/features/dpop/userinfo.ts#verifyDpopUserInfoAccess nextjs:app/userinfo/route.ts#buildUserInfoResponse nextjs:app/userinfo/route.ts#parseBearerAccessToken nextjs:app/userinfo/route.ts#respondUserInfo nextjs:app/userinfo/route.ts#respondUserInfoError nextjs:app/userinfo/route.ts#userinfo -->

`Authorization: DPoP <token>` と `ath` 入りの DPoP proof を受け付け、トークンを束縛した鍵と照らし合わせる（RFC 9449 §7.1）。鍵に束縛したトークンを Bearer で使わせない（§7.2 の MUST）。

- 失敗のチャレンジの認証スキームを、本体の `let challenge`（既定は Bearer）にした。DPoP の機能のブロックが DPoP のチャレンジに置き換えるので、期限切れのような本体のステップの失敗も、DPoP で提示したリクエストには `DPoP ... algs=...` で答える。`try` の前で宣言するのは、認可エンドポイントの `responseMode` と同じ形である
- DPoP スキームのときだけボディを読む。Express / Fastify のアダプタと Next.js の `Request` はボディを一度しか読めないので、そのときは Bearer のステップがボディを読まない
- Next.js の UserInfo の Route Handler にはステップの目印が無かったので、Hono のパイプラインと同じ目印と `endpoint.ts` を足した。Bearer の応答は変えていない

## processAuthorizationRequest, createAuthorizationTransaction, issueAuthorizationCodeResponse, issueConsentedAuthorizationCode, validateDpopJktParameter, issueHybridConsentResponse, issueHybridTokens, issueHybridResponse, authorize, issueAuthorizationResponse, POST <!-- hono:oidc-provider/endpoints/authorize/pipeline.ts#processAuthorizationRequest hono:oidc-provider/endpoints/authorize/steps/create-transaction.ts#createAuthorizationTransaction hono:oidc-provider/endpoints/authorize/steps/issue-authorization-code.ts#issueAuthorizationCodeResponse hono:oidc-provider/endpoints/consent/steps/issue-authorization-code.ts#issueConsentedAuthorizationCode hono:oidc-provider/features/dpop/steps/validate-dpop-jkt.ts#validateDpopJktParameter hono:oidc-provider/features/hybrid-flow/steps/issue-hybrid-response.ts#issueHybridConsentResponse hono:oidc-provider/features/hybrid-flow/tokens.ts#issueHybridTokens nextjs:app/_oidc-provider/features/dpop/authorize.ts#validateDpopJktParameter nextjs:app/_oidc-provider/features/hybrid-flow/authorize.ts#issueHybridResponse nextjs:app/_oidc-provider/features/hybrid-flow/consent.ts#issueHybridConsentResponse nextjs:app/_oidc-provider/features/hybrid-flow/tokens.ts#issueHybridTokens nextjs:app/authorize/route.ts#authorize nextjs:app/authorize/route.ts#issueAuthorizationResponse nextjs:app/consent/decision/route.ts#POST -->

認可リクエストの `dpop_jkt`（RFC 9449 §10）を確かめ、その鍵の確認を `cnf` として認可トランザクションに入れ、トランザクションから発行する認可コード（SSO・`prompt=none`、同意画面、Hybrid Flow）に引き継ぐ。トークンエンドポイントは、同じ鍵の DPoP proof の付いた交換だけを受け付ける。

- core の `createAuthorizationCode()` は決まった項目しか写さないので、本体のステップが保存の直前に `cnf` を足す。トランザクションのストアは型に無い値も保存するので、ログインと同意の画面を経ても `cnf` は残る
- `dpop_jkt` を省いたリクエストは、従来どおり鍵に束縛しない

## par, bindPushedDpopKey, pushAuthorizationRequest <!-- endpoint:par hono:oidc-provider/features/dpop/steps/bind-pushed-dpop-key.ts#bindPushedDpopKey nextjs:app/(par)/par/route.ts#pushAuthorizationRequest nextjs:app/_oidc-provider/features/dpop/par.ts#bindPushedDpopKey -->

PAR のリクエストに `DPoP` ヘッダーがあれば、その鍵を `dpop_jkt` としてプッシュする（RFC 9449 §10.1）。`dpop_jkt` と DPoP proof の両方があれば、同じ鍵でなければ `invalid_dpop_proof` で拒否する。

- DPoP の機能は PAR の機能なしでも生成されるので、PAR の機能のエラーの型を使わず、PAR と同じ形の 400 の JSON（`no-cache, no-store`）を組み立てて返す
- Next.js の PAR の Route Handler にはステップの目印が無かったので、目印と `endpoint.ts` を足した

## createApp, createCorsMiddleware, corsHeadersOf, corsHeaders <!-- hono:oidc-provider/app.ts#createApp hono:oidc-provider/cors.ts#createCorsMiddleware hono:oidc-provider/features/feature.ts#corsHeadersOf nextjs:app/_oidc-provider/feature.ts#corsHeadersOf nextjs:app/_oidc-provider/http.ts#corsHeaders -->

ブラウザで動くクライアント（DPoP の主な使い手）が `DPoP` ヘッダーを送り、失敗の `WWW-Authenticate` を読めるよう、機能のフックに `cors`（`allowHeaders` / `exposeHeaders`）を足した。保護されたエンドポイントの CORS は、本体の `Authorization` と `Content-Type` に、機能が挙げたヘッダーを加える。

テストを変えない理由: Next.js の `corsHeaders()` は http.ts の外から呼べない関数で、http.test.ts に足した `corsPreflight()` と `withCors()` のテスト（`Access-Control-Allow-Headers` と `Access-Control-Expose-Headers`）が、この関数の組み立てたヘッダーを確かめている。
