---
'@maronn-openid-connect/cli': minor
---

生成コードの機能のフックに `cors` を足す。機能が `defineFeature({ cors: { allowHeaders, exposeHeaders } })` で挙げたヘッダーを、保護されたエンドポイントの CORS が OP 自身のヘッダーの後ろに加える。`allowHeaders` はブラウザのクライアントに送らせるリクエストヘッダーとして `Access-Control-Allow-Headers` に、`exposeHeaders` は読ませるレスポンスヘッダーとして `Access-Control-Expose-Headers` に入る。対象は Hono、Express、Fastify ではトークンエンドポイント、UserInfo エンドポイントと `cors: 'protected'` で登録したルート、Next.js では `_oidc-provider/http.ts` の `clientCors` を使う Route Handler で、ディスカバリーと JWKS には入らない。

あわせて、Hono の `createCorsMiddleware()` の `CorsOptions` と Next.js の `CorsPolicy` に `exposeHeaders` を足す。省くか空にすると `Access-Control-Expose-Headers` を付けない。

今の機能はどれも `cors` を使わないので、生成した OP の CORS のヘッダーは変わらない。後のリリースで DPoP の機能が、`DPoP` リクエストヘッダーと、`WWW-Authenticate` などのレスポンスヘッダーをこのフックで挙げる。
