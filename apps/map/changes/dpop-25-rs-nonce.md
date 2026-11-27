# UserInfo エンドポイントが、設定すれば DPoP proof に保護されたリソースの nonce を求めるようにする（DPoP の段 25）

DPoP（RFC 9449）を生成 OP に入れる段の 25 個目で、段 23 で作った nonce を、保護されたリソース（UserInfo エンドポイント）が求めるようにする（RFC 9449 §9）。
`ProviderConfig` に `dpopNonceRequiredAtResourceServer`（既定は `false`。Next.js は環境変数 `OIDC_DPOP_NONCE_REQUIRED_AT_RESOURCE_SERVER=1` で `true`）を足した。
`true` のとき、UserInfo エンドポイントは、`Authorization: DPoP` でアクセストークンを提示したリクエストには、そのスキームを読んだ後のどのレスポンス（成功もエラーも。nonce の秘密が 32 バイトより短いときの 500 は除く）にも、保護されたリソースが今発行した nonce を `DPoP-Nonce` ヘッダーで一つ付け、保護されたリソースが `dpopNonceLifetimeSeconds` 秒の間に発行した nonce の無い DPoP proof を 401 の `use_dpop_nonce` で拒否する（エラーは `DPoP` のチャレンジが伝える）。
nonce の MAC にはサーバーの役割が入るので、トークンエンドポイントと PAR エンドポイント（認可サーバー）の nonce は UserInfo エンドポイントで受け付けず、UserInfo エンドポイントの nonce も認可サーバーで受け付けない（RFC 9449 §9）。
Bearer で提示したリクエストとトークンの無いリクエストには、設定によらず nonce を渡さず、求めもしない。
`false` のとき（既定）は、`DPoP-Nonce` を返さず、DPoP proof の `nonce` クレームも見ないので、UserInfo の応答はこれまでと同じである（地図の生きた OP のケースも、すべて期待どおりの状態とエラーで答える）。
dpop の機能を有効にしない生成物で変わるのは、UserInfo エンドポイントのコメント（Hono 系はパイプラインの先頭のコメントと `endpoint.ts` の JSDoc、Next.js は `route.ts` の先頭のコメントと JSDoc と `endpoint.ts` の JSDoc）だけである。

## userinfo, handler <!-- nextjs:app/userinfo/route.ts#userinfo hono:oidc-provider/endpoints/userinfo/pipeline.ts#handler -->

`[read-dpop-access-token]` のブロックの見出しの仕様に RFC 9449 §9 を足し、先頭のコメントと JSDoc に、設定が nonce を求めるときの振る舞いを書いた。
ブロックの並びと文は変えていない。nonce を渡すことも確かめることも、DPoP スキームのトークンを読むこのブロックの中で行うためである。

## readDpopUserInfoRequest <!-- hono:oidc-provider/features/dpop/steps/read-dpop-access-token.ts#readDpopUserInfoRequest nextjs:app/_oidc-provider/features/dpop/userinfo.ts#readDpopUserInfoRequest -->

設定が保護されたリソースに nonce を求めるときは、リクエストが DPoP スキームでトークンを提示したと分かった直後に、保護されたリソースの nonce をレスポンスに付け（`provideDpopNonce()`）、DPoP proof の検査に保護されたリソースの役割（`nonceServer`）を渡すようにした。
nonce をほかの検査より先に付けるので、`use_dpop_nonce` の応答に、やり直しに使う nonce が必ず一つ付く（RFC 9449 §9 は、保護されたリソースも、認可サーバーと同じく 401 の応答の `DPoP-Nonce` で nonce を渡すとする）。DPoP proof の無いリクエスト、フォームのボディにもトークンを送ったリクエスト、鍵の違うトークン、`openid` スコープの無いトークンなど、後のどの失敗にも付けるので、クライアントは次の DPoP proof にその nonce を入れられる（RFC 9449 §8.2）。
DPoP スキームを読んだ後に付けるのは、Bearer のリクエストに nonce を渡さないためである。トークンエンドポイントは `DPoP` ヘッダーのあるリクエストにだけ nonce を渡すが、UserInfo エンドポイントでは、`Authorization: DPoP` が DPoP を使うリクエストのしるしで、`DPoP` ヘッダーの無い DPoP スキームのリクエストも DPoP proof を送り直すので、その応答にも nonce を付ける。
`Authorization` に Bearer と DPoP の両方を並べたリクエストは、スキームを決める前に 400 で拒否するので、nonce を付けない。
nonce は、トークンエンドポイントと違って、DPoP proof を署名を確かめずに先に読むことはせず、DPoP proof の検査（`verifyDpopRequestProof()`）が、署名と `htm`・`htu`・`iat` の後、`ath` と `jti` の前に確かめる。保護されたリソースには、検査より先に済ませたい処理（クライアントの認証）が無いためである。
設定の誤り（32 バイトより短い秘密）は、DPoP の失敗ではないので、そのまま投げて 500 の `server_error` にする。

## provideDpopNonce, resourceServerNonceOf <!-- hono:oidc-provider/features/dpop/server-nonce.ts#provideDpopNonce hono:oidc-provider/features/dpop/server-nonce.ts#resourceServerNonceOf nextjs:app/_oidc-provider/features/dpop/server-nonce.ts#provideDpopNonce nextjs:app/_oidc-provider/features/dpop/server-nonce.ts#resourceServerNonceOf -->

`provideDpopNonce()` は、サーバーの役割が今発行した nonce を、このリクエストへのレスポンスの `DPoP-Nonce` ヘッダーとして一つ付ける（Hono は `c.header()`、Next.js は `setResponseHeader()` に預けて `withCors()` が付ける）。
段 24 の `requireDpopNonce()` は、nonce を付けたうえで、署名を確かめずに DPoP proof の `nonce` を確かめる。UserInfo エンドポイントは `nonce` を DPoP proof の検査で確かめるので、nonce を付けるところだけを分けた。
`resourceServerNonceOf()` は、設定が保護されたリソースに nonce を求めるときだけ役割を返す。nonce を渡すことと求めることを一つの設定で決めるので、渡した nonce の無い DPoP proof を受け付けることも、渡さない nonce を求め続けることもない（RFC 9449 §11.3）。
認可サーバーの設定（`dpopNonceRequiredAtAuthorizationServer`）とは別の設定にしたのは、RFC 9449 が §8 と §9 で別々に、サーバーごとに nonce を使うかを選べるようにしているためである。
