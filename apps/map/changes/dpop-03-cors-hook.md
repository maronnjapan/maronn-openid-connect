# 機能が保護されたエンドポイントの CORS に、送らせるリクエストヘッダーと読ませるレスポンスヘッダーを足せるようにする（DPoP の段 3）

DPoP（RFC 9449）を生成 OP に入れる段の 3 つ目で、DPoP の機能が後の段で使う CORS の口を本体に足す。
ブラウザで動くクライアントは、CORS で許可されないと `DPoP` リクエストヘッダーを送れず、`Access-Control-Expose-Headers` に挙がっていない `WWW-Authenticate` と `DPoP-Nonce` を読めない（RFC 9449 §7.1 と §8 の注記）。
本体は機能を import しないので、ヘッダーは機能が `defineFeature()` の `cors` で挙げ、本体がそれを集めて保護されたエンドポイントの CORS に加える。
この段ではどの機能も `cors` を挙げないので、どのエンドポイントの CORS のヘッダーも変わらない。

## corsHeadersOf <!-- hono:oidc-provider/features/feature.ts#corsHeadersOf nextjs:app/_oidc-provider/feature.ts#corsHeadersOf -->

機能の `cors` を、ほかのフックの `*Of()` と同じく機能の一覧の順に集める関数を足した。
同じヘッダーを二つの機能が挙げても一度だけ入れる（ヘッダーの値に同じ名前が並ばないように）。
順番を機能の一覧に揃えるので、同じ機能構成からは同じヘッダーの値になる。

## createApp, createCorsMiddleware <!-- hono:oidc-provider/app.ts#createApp hono:oidc-provider/cors.ts#createCorsMiddleware -->

保護されたエンドポイント（トークンエンドポイント、UserInfo エンドポイント、機能が `cors: 'protected'` で登録したルート）の CORS が、OP 自身の `Authorization` と `Content-Type` の後ろに機能のリクエストヘッダーを足し、機能のレスポンスヘッダーを `Access-Control-Expose-Headers` に入れる。
ミドルウェアは、`exposeHeaders` を省くか空にすると `Access-Control-Expose-Headers` を付けない。機能が何も挙げない OP のレスポンスは、ヘッダーまでこれまでと同じになる。
ディスカバリーと JWKS の CORS には機能のヘッダーを入れない。認証情報も DPoP proof も送らないリクエストだけを受けるからである。
Express と Fastify の出力も同じミドルウェアを `WebRouter` で動かすので、同じヘッダーになる。

## corsHeaders <!-- nextjs:app/_oidc-provider/http.ts#corsHeaders -->

Next.js の Route Handler が付ける CORS のヘッダーにも、`policy.exposeHeaders` があれば `Access-Control-Expose-Headers` を入れる。省くか空なら付けないのは Hono と同じである。
機能のヘッダーは、`clientCors`（クライアントが直接呼ぶエンドポイントの方針）にだけ、http.ts を読み込むときに一度だけ加える。`publicCors` には加えない。
http.ts が `features.ts` を import するようになったが、循環はしない。`features.ts` から読み込まれるモジュールは、http.ts も `provider.ts` も実行時には import しないので、`clientCors` を組み立てるときには機能の一覧がそろっている。
