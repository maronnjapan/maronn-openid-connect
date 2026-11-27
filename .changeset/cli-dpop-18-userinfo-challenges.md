---
'@maronn-openid-connect/cli': minor
---

`--enable dpop` で生成した UserInfo エンドポイントが、失敗の応答の `WWW-Authenticate` に、Bearer のチャレンジと並べて DPoP のチャレンジを返すようにする（RFC 9449 §7.2 の RECOMMENDED）。

- チャレンジを付けて答えるどの失敗にも、`Bearer realm="UserInfo"` の後ろに、受け付ける alg を並べた DPoP のチャレンジ（`DPoP algs="ES256 …"`）を並べる。エラーの情報（`error` と `error_description`）は、トークンを提示したスキームのチャレンジだけが伝える。
  - アクセストークンを提示しないリクエスト（Bearer でも DPoP でもない `Authorization` を含む）: `Bearer realm="UserInfo", DPoP algs="…"`（どちらもエラーを伝えない。RFC 9449 Figure 17）。
  - Bearer（`Authorization: Bearer` かフォームのボディの `access_token`）で提示したトークンの失敗: `Bearer realm="UserInfo", error="…", error_description="…", DPoP algs="…"`（RFC 9449 Figure 18）。DPoP の鍵に束縛したアクセストークンを Bearer で提示したときの 401 の `invalid_token` も、この形である。
  - DPoP スキームで提示したトークンの失敗は、これまでどおり `Bearer realm="UserInfo", DPoP algs="…", error="…", error_description="…"` である。
  - ステータスと JSON のボディは変わらない。読めないボディの 400 と、サーバーの誤りの 500 / 503 には、これまでどおりチャレンジを付けない。`WWW-Authenticate` を一つのチャレンジとして読むクライアントは、コンマで並んだ複数のチャレンジを読めるようにする（RFC 9110 §11.6.1）。
- Bearer と DPoP の両方でアクセストークンを送ったリクエストは、400 の `invalid_request`（`Multiple access token methods are not allowed`）で拒否し、両方のチャレンジにエラーの情報を入れる（RFC 9449 Figure 19）。
  - `Authorization` のフィールドを Bearer と DPoP の二つ送ったリクエスト（Fetch の `Headers` は一つの値にコンマでつなぐ）。これまでは、`Bearer X, DPoP X` は 401 の `invalid_token`、`DPoP X, Bearer X` は DPoP のチャレンジだけがエラーを伝える 400 だった。
  - `Authorization: DPoP` とフォームのボディの `access_token` の両方で送ったリクエスト。400 の `invalid_request` は変わらず、これまで DPoP のチャレンジだけに入れていたエラーを、Bearer のチャレンジにも入れる。`Authorization: DPoP` にトークンが無いか、token68 でない値のときも同じである（これまでは、DPoP のチャレンジだけがその形の誤りを伝える 400 だった）。
  - Bearer のヘッダーとフォームのボディの両方で送ったリクエストは、どちらも Bearer の方法なので、これまでどおり Bearer のチャレンジだけがエラーを伝える。
  - 二つの `Authorization` を検出できるのは、ランタイムが二つの値をつないで渡すとき（Cloudflare Workers、`@hono/node-server`）である。Node.js の `http` モジュールは二つ目の `Authorization` を捨てるので、そのヘッダーから `Request` を作るランタイム（生成する Express と Fastify のアダプタ、`runtime = 'nodejs'` で動く Next.js の UserInfo のルートなど）では、最初のフィールドのスキームのリクエストとして答える。
- 生成コードでは、`readDpopUserInfoRequest()`（Hono、Express、Fastify では `[read-dpop-access-token]` のステップの `features/dpop/steps/read-dpop-access-token.ts`、Next.js では `userinfo/route.ts` の `[read-dpop-access-token]` のブロックが呼ぶ `_oidc-provider/features/dpop/userinfo.ts`）が DPoP のチャレンジを先に足し、`features/dpop/resource.ts` の `namesBearerAndDpopSchemes(authorizationHeader)` と `features/dpop/error-responses.ts` の `ambiguousUserInfoRequestError()` で両方のスキームのリクエストを拒否する。ステップのラベルは「DPoP のチャレンジを並べ、DPoP スキームのアクセストークンを読んで DPoP proof を検証する」になる。

この段階で止めたリリースも、RFC 9449 の MUST のうち、認可コードの鍵への束縛をまだ満たさない。認可リクエストの `dpop_jkt` を読まないので、トークンリクエストの DPoP proof の鍵がそれと違っても拒否しない（§10）。`par` と一緒に有効にしても、PAR の `dpop_jkt` と `DPoP` ヘッダーを受け付けない（§10.1）。どちらも後のリリースで加える。`dpop_bound_access_tokens`（§5.2）と、サーバーが発行する nonce（§8 / §9）も後のリリースである。

`dpop` を有効にしない生成物は、UserInfo エンドポイントのパイプライン（Hono、Express、Fastify の `endpoints/userinfo/pipeline.ts`）と Next.js の `userinfo/route.ts` の先頭のコメントだけが変わり、答えは変わらない（`WWW-Authenticate` も `Bearer realm="UserInfo"` のチャレンジだけのままである）。
