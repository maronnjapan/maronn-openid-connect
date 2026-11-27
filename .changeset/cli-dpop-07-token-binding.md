---
'@maronn-openid-connect/cli': patch
---

生成コードに、トークンを鍵に束縛するための本体のモジュール `token-binding.ts`（Hono では `oidc-provider/token-binding.ts`、Next.js では `app/_oidc-provider/token-binding.ts`）を足す。後の段で加える DPoP（RFC 9449）の機能が、トークンを DPoP proof の鍵に束縛するときに使う。

- `TokenBinding`（アクセストークンの確認 `cnf`、`tokenType`、パブリッククライアントのリフレッシュトークンの `refreshTokenCnf`）と、そこから値を決める `tokenTypeOf()`、`accessTokenClaimsOf()`、`accessTokenRecordOf()`、`refreshTokenRecordOf()` を足す。束縛が無ければ `Bearer` と空のオブジェクトを返す。
- Hono（Express、Fastify を含む）のトークンエンドポイントのステップ `issueAccessToken()`、`persistAccessToken()`、`buildTokenResponse()` と、リフレッシュトークンの `issueRefreshToken()`（Next.js の `features/refresh-token/token.ts` も）は、省略できる入力 `binding` を受け取る。渡すと、アクセストークンに `cnf` が入り、保存するアクセストークンのレコードに `cnf` と `tokenType` が、リフレッシュトークンのレコードに `refreshTokenCnf` が `cnf` として残り、トークンレスポンスの `token_type` が束縛の `tokenType` になる。ステップの説明の入力には、省略できる `tokenBinding` が加わる。

今はどのパイプラインも Route Handler も `binding` を渡さないので、トークンエンドポイントの応答、発行するアクセストークン、保存するレコードは変わらない。
`buildTokenResponse()` の戻り値の型（`TokenEndpointResponse`）も変わらない。
