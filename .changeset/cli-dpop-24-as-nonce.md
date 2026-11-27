---
'@maronn-openid-connect/cli': minor
---

`--enable dpop` で生成する OP の認可サーバー（トークンエンドポイントと PAR エンドポイント）が、設定すれば DPoP proof にサーバーの nonce を求めるようにする（RFC 9449 §8）。

- 設定 `ProviderConfig.dpopNonceRequiredAtAuthorizationServer` が加わる（既定は `false`）。Next.js では環境変数 `OIDC_DPOP_NONCE_REQUIRED_AT_AUTHORIZATION_SERVER` を `1` にすると `true` になる。
- `true` のとき、トークンエンドポイントと PAR エンドポイントは、`DPoP` ヘッダーのあるリクエストへのどのレスポンス（200・201 もエラーも）にも、次の DPoP proof に入れる nonce を `DPoP-Nonce` ヘッダーで一つ付ける。DPoP proof に `nonce` が無いか、認可サーバーが `dpopNonceLifetimeSeconds` 秒（既定は 120）の間に発行した nonce でなければ、400 の `use_dpop_nonce` で拒否する（`error_description` は、無いときは `Authorization server requires nonce in DPoP proof`）。保護されたリソースの nonce は受け付けない。二つのエンドポイントは同じ認可サーバーなので、どちらで渡した nonce もどちらでも使える。
- nonce は、クライアントの認証の前のブロック（`[require-dpop-nonce]`、PAR では `[require-pushed-dpop-nonce]`）が、DPoP proof のクレームを署名を確かめずに読んで確かめる。そのため、nonce で拒否したリクエストの `private_key_jwt` のクライアントアサーションは消費されず、クライアントは同じクライアントアサーションでやり直せる。DPoP proof の署名とほかのクレームは、これまでどおりクライアントの認証の後で確かめ、そこでも nonce を署名と一緒に確かめ直す。
- `true` のときに変わるエラーの順: `DPoP` ヘッダーの値が一つの JWT でないリクエストと、`DPoP` ヘッダーが二つあるリクエストは、クライアントの認証より前に 400 の `invalid_dpop_proof` で拒否する（二つのときは `DPoP-Nonce` を付けない）。nonce の無い DPoP proof を送ったリクエストは、クライアントの認証に失敗するものでも、401 の `invalid_client` より前に 400 の `use_dpop_nonce` で答える。
- PAR エンドポイントは、クライアントの認証の後の DPoP proof の検査が `use_dpop_nonce` を投げたときも 400 で答える（PAR のエラーと同じ形で `no-cache, no-store`）。
- `false` のとき（既定）は、`DPoP-Nonce` を返さず、DPoP proof の `nonce` クレームも確かめないので、トークンと PAR の応答はこれまでと同じである。`DPoP` ヘッダーの無いリクエストには、設定によらず nonce を渡さず、求めもしない。
- 秘密は前のリリースと同じく、Hono、Express、Fastify では `createApp()` / `applyOidc()` の `dpopNonceSecret`、Next.js では環境変数 `OIDC_DPOP_NONCE_SECRET` で、複数のインスタンスで動かすときはすべてに同じ秘密（32 バイト以上）を与える。秘密が無いと、インスタンスごと（Workers の Hono では isolate ごと、Node.js の Hono、Express、Fastify ではプロセスごと、Next.js では `next start` のプロセスかサーバーレスの関数のインスタンスごと）の鍵で nonce を作るので、ほかのインスタンスに届いたやり直しは、また `use_dpop_nonce` で拒否される。`true` で秘密が 32 バイトより短いときは、`DPoP` ヘッダーのあるリクエストに 500 の `server_error` で答える。

生成コードの変更:

- dpop の機能を有効にすると、クライアントが直接呼ぶエンドポイント（トークン、UserInfo、PAR など）の CORS の `Access-Control-Expose-Headers` が `WWW-Authenticate,DPoP-Nonce` になる（これまでは `WWW-Authenticate`）。設定によらず、DPoP を使わないリクエストへのレスポンスでも変わる。
- `features/dpop/server-nonce.ts`（`requireDpopNonce()`、`authorizationServerNonceOf()`）、`features/dpop/steps/require-dpop-nonce.ts`（`requireTokenDpopNonce()`）、`features/dpop/steps/require-pushed-dpop-nonce.ts`（`requirePushedDpopNonce()`）が加わる。Next.js では `_oidc-provider/features/dpop/server-nonce.ts` が加わり、`token.ts` に `requireTokenDpopNonce()`、`par.ts` に `requirePushedDpopNonce()` が加わる。`error-responses.ts` に、PAR エンドポイントの DPoP の失敗を 400 の JSON にする `parEndpointRejectionOf()` が加わり、`bindPushedDpopKey()` もそれを使う。PAR のファイルは、par の機能が無くても生成されるが、どこからも呼ばれない。
- Next.js の `_oidc-provider/http.ts` に、ブロックがレスポンスに付けるヘッダーを預ける `setResponseHeader()` が加わり、`withCors()` が、同じリクエストへのレスポンスにそれを付ける。dpop を有効にしない生成物にも入るが、何も預けなければレスポンスは変わらない。
- トークンエンドポイントと PAR エンドポイントの先頭のコメント、`endpoint.ts` の JSDoc（Next.js はルートの JSDoc も）に、nonce のブロックの説明が加わる。dpop を有効にしない生成物では、変わるのはこのコメントと `http.ts` だけである。
- 生成したトークンエンドポイント（Hono 系の `endpoints/token/pipeline.ts`、Next.js の `token/route.ts` と `token/endpoint.ts`）や PAR エンドポイントを書き換えて使っていて、nonce のブロックを足さずに `dpopNonceRequiredAtAuthorizationServer` を `true` にすると、nonce を渡さないまま DPoP proof の検査が nonce を求め、DPoP のリクエストがすべて `use_dpop_nonce` で拒否される。設定を `true` にする前に、新しく生成したエンドポイントからブロックを写す。

保護されたリソース（UserInfo エンドポイント）は、まだ nonce を求めない（RFC 9449 §9）。nonce を使うかどうかはサーバーが選べる（RFC 9449 §8 / §9 の MAY）ので、これは RFC 9449 に反しない。
