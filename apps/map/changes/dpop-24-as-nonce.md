# トークンエンドポイントと PAR エンドポイントが、設定すれば DPoP proof に認可サーバーの nonce を求めるようにする（DPoP の段 24）

DPoP（RFC 9449）を生成 OP に入れる段の 24 個目で、前の段で作った nonce を、認可サーバー（トークンエンドポイントと PAR エンドポイント）が求めるようにする（RFC 9449 §8）。
`ProviderConfig` に `dpopNonceRequiredAtAuthorizationServer`（既定は `false`。Next.js は環境変数 `OIDC_DPOP_NONCE_REQUIRED_AT_AUTHORIZATION_SERVER=1` で `true`）を足した。
`true` のとき、二つのエンドポイントは、`DPoP` ヘッダーのあるリクエストには、リクエストを解析した後のどのレスポンス（成功もエラーも）にも、次の DPoP proof に入れる nonce を `DPoP-Nonce` ヘッダーで一つ付け、認可サーバーが `dpopNonceLifetimeSeconds` 秒の間に発行した nonce の無い DPoP proof を 400 の `use_dpop_nonce` で拒否する。
nonce の確認は、クライアントの認証の前の新しいブロックで行い、クライアントの認証の後の DPoP proof の検査も、署名と一緒に nonce を確かめ直す。
`false` のとき（既定）は、`DPoP-Nonce` を返さず、DPoP proof の `nonce` クレームも見ないので、トークンと PAR の応答は、次に書く CORS のヘッダーのほかはこれまでと同じである（地図の生きた OP のケースも、すべて期待どおりの状態とエラーで答える）。
設定によらず変わるのは、dpop の機能を有効にした OP で、クライアントが直接呼ぶエンドポイント（トークン、UserInfo、PAR など）の CORS の `Access-Control-Expose-Headers` に `DPoP-Nonce` が加わること（`WWW-Authenticate,DPoP-Nonce`）と、Next.js の `http.ts` に、ブロックがレスポンスに付けるヘッダーを預ける `setResponseHeader()` が加わり、`withCors()` がそれを付けるようになること（預けたヘッダーが無ければ、レスポンスは変わらない）である。
保護されたリソース（UserInfo エンドポイント）の nonce（RFC 9449 §9）は、次の段で足す。

## token <!-- endpoint:token nextjs:app/token/route.ts#token -->

クライアントの認証の直前に、dpop の機能のブロック `[require-dpop-nonce]` を置いた。
nonce の確認をクライアントの認証より前にしたのは、`private_key_jwt` のクライアントアサーションの `jti` を、nonce で拒否するリクエストで消費しないためである。認証の後で拒否すると、nonce を入れてやり直すクライアントは、クライアントアサーションも作り直さなければならない（同じものは再利用として `invalid_client` になる）。RFC 9449 §4.3 は検査の順を問わない。
DPoP proof の署名と、そのほかのクレームの検査は、これまでどおり認証の後の `[verify-dpop-proof]` で行う。認証に失敗したリクエストの DPoP proof の `jti` を覚えないためである。
Next.js では、ブロックから後のどのレスポンスにも `DPoP-Nonce` を付けるために、ブロックが nonce を `setResponseHeader()` に預け、`POST` の `withCors()` が付ける。Route Handler には Hono の `c.header()` にあたるものが無く、早く応答する分岐（機能のグラント、エラー）がいくつもあるためである。
ブロックは `try` の中の最初に置いた。設定の誤り（短すぎる秘密など）は `[respond-error]` の 500 になる。

## par, pushAuthorizationRequest <!-- endpoint:par nextjs:app/(par)/par/route.ts#pushAuthorizationRequest -->

トークンエンドポイントと同じ理由で、クライアントの認証の直前に `[require-pushed-dpop-nonce]` を置いた。
PAR エンドポイントもトークンエンドポイントと同じ認可サーバーなので、同じ役割の nonce を使い、どちらで渡した nonce もどちらでも受け付ける（RFC 9449 §8 は、クライアントが一つの nonce を使い続けることを期待している）。
拒否は PAR のエラーと同じ形（RFC 9126 §2.3）の 400 で返し、`DPoP-Nonce` は Hono ではコンテキストの `c.header()`、Next.js では `withCors()` が付ける。

## requireDpopNonce, authorizationServerNonceOf <!-- hono:oidc-provider/features/dpop/server-nonce.ts#requireDpopNonce hono:oidc-provider/features/dpop/server-nonce.ts#authorizationServerNonceOf nextjs:app/_oidc-provider/features/dpop/server-nonce.ts#requireDpopNonce nextjs:app/_oidc-provider/features/dpop/server-nonce.ts#authorizationServerNonceOf -->

`requireDpopNonce()` は、`DPoP` ヘッダーのあるリクエストに、そのサーバーが今発行した nonce をレスポンスの `DPoP-Nonce` として預け、DPoP proof の `nonce` クレームが、そのサーバーが最近発行した nonce かを確かめる。
nonce を先に預けるので、`use_dpop_nonce` の応答に、やり直しに使う nonce が必ず一つ付く（RFC 9449 §8 の MUST）。成功の応答にも付けるので、クライアントは nonce が古くなる前に新しい nonce に替えられる（RFC 9449 §8.2）。nonce に状態は無く、古い nonce も期間の中なら受け付けるので、同時に送ったリクエストどうしが互いの nonce を無効にすることはない。
DPoP proof は、クレームを読むために `decodeDpopProof()` で分解する（JWS のコンパクト形式で、JOSE ヘッダーの `typ` が `dpop+jwt`、`alg` と `jwk` があり、`crit` が無いことを確かめる）が、署名は確かめない。分解できない `DPoP` ヘッダーは後の検査でも必ず拒否されるので、ここで `invalid_dpop_proof` で拒否する。そのため、設定が `true` のときは、この形の誤りもクライアントの認証の失敗より前に答える。ここを通った DPoP proof も、後の検査が署名と一緒に nonce を確かめ直すので、署名の無い nonce で受け付けることはない。`DPoP` ヘッダーが二つあるリクエストは、nonce を預けずに `invalid_dpop_proof` で拒否する（どの proof の nonce を確かめるのか決まらないため）。
`authorizationServerNonceOf()` は、設定が認可サーバーに nonce を求めるときだけ役割を返す。nonce を渡さないサーバーが nonce を求めると、クライアントは nonce を得られずに拒否され続け、逆に nonce を渡したサーバーが求めないと、nonce の無い DPoP proof を受け付けてしまう（RFC 9449 §11.3）ので、渡すことと求めることを一つの設定で決める。
認可サーバーの役割は、ここでは `ProviderConfig` の項目一つだけで決める。保護されたリソースの nonce の設定は次の段で足す。

## requireTokenDpopNonce <!-- hono:oidc-provider/features/dpop/steps/require-dpop-nonce.ts#requireTokenDpopNonce nextjs:app/_oidc-provider/features/dpop/token.ts#requireTokenDpopNonce -->

トークンエンドポイントのブロックの本体で、設定が nonce を求めないときは何もしない。
拒否は、トークンエンドポイントの DPoP の失敗と同じ形（Hono は `TokenEndpointError`、Next.js はキャッシュさせない 400 のレスポンス）で返す。`use_dpop_nonce` は RFC 6749 §5.2 の形の 400 で答える（RFC 9449 §8 Figure 20）。
設定の誤り（32 バイトより短い秘密、`dpopNonceLifetimeSeconds` が数でない）は、DPoP の失敗ではないので、そのまま投げて 500 の `server_error` にする。

## requirePushedDpopNonce <!-- hono:oidc-provider/features/dpop/steps/require-pushed-dpop-nonce.ts#requirePushedDpopNonce nextjs:app/_oidc-provider/features/dpop/par.ts#requirePushedDpopNonce -->

PAR エンドポイントのブロックの本体で、トークンエンドポイントと同じに nonce を求める。
PAR の機能のエラーの型は使わず、拒否のレスポンスをブロックが返す（`dpopNonceRejection`）。DPoP の機能は PAR の機能なしでも生成されるためで、そのときもこのファイルは生成されるが、どこからも呼ばれない（`[bind-pushed-dpop-key]` と同じ）。

## verifyDpopTokenRequest, bindPushedDpopKey <!-- hono:oidc-provider/features/dpop/steps/verify-dpop-proof.ts#verifyDpopTokenRequest hono:oidc-provider/features/dpop/steps/bind-pushed-dpop-key.ts#bindPushedDpopKey nextjs:app/_oidc-provider/features/dpop/token.ts#verifyDpopTokenRequest nextjs:app/_oidc-provider/features/dpop/par.ts#bindPushedDpopKey -->

クライアントの認証の後の DPoP proof の検査に、設定が nonce を求めるときは認可サーバーの役割（`nonceServer`）を渡すようにした。
認証の前のブロックは署名を確かめずに nonce を読むので、署名と一緒に確かめ直して、受け付ける DPoP proof の `nonce` が、その proof の署名した値であることを保つ。認証の前のブロックを消した OP でも、nonce の無い DPoP proof を受け付けない。
PAR エンドポイントの拒否は `parEndpointRejectionOf()` に移し、`use_dpop_nonce` も 400 で答えるようにした。これまでは `invalid_dpop_proof` と `invalid_request` のほかの DPoP の失敗を 500 にしていたので、そのままでは nonce の失敗も 500 になるためである。

## parEndpointRejectionOf <!-- hono:oidc-provider/features/dpop/error-responses.ts#parEndpointRejectionOf nextjs:app/_oidc-provider/features/dpop/error-responses.ts#parEndpointRejectionOf -->

PAR エンドポイントの DPoP の失敗の応答を、二つのブロック（nonce と DPoP proof の鍵）で同じにするためにまとめた。
`invalid_dpop_proof`、`invalid_request`、`use_dpop_nonce` を、PAR のエラーと同じ形の 400（`no-cache, no-store`）にし、トークンエンドポイントだけの `invalid_grant` と保護されたリソースだけの `invalid_token` は答えずに投げ直させる（PAR エンドポイントは 500）。
Hono ではレスポンスをコンテキストで組み立てるので、CORS のミドルウェアのヘッダーと、先に預けた `DPoP-Nonce` が残る。

## setResponseHeader, withCors <!-- nextjs:app/_oidc-provider/http.ts#setResponseHeader nextjs:app/_oidc-provider/http.ts#withCors -->

Next.js の Route Handler のブロックが、どこで応答するかによらずレスポンスに付けるヘッダーを預ける `setResponseHeader()` を足し、`withCors()` が、同じリクエストへのレスポンスにそれを付けるようにした。
Hono のステップは `c.header()` でレスポンスのヘッダーを足せるが、Next.js の Route Handler はブロックごとに `Response` を作って早く返すので、DPoP の nonce のように、成功にもどのエラーにも付けるヘッダーを、すべての `return` に書かずに付ける場所が要るためである。
どの Route Handler も最後に `withCors()` を通るので、そこで付ける。預けたヘッダーはリクエストのオブジェクトをキーにした `WeakMap` に置くので、ほかのリクエストに混ざらず、リクエストが終われば残らない。
預けたヘッダーが無いリクエストのレスポンスは、これまでと同じである。
