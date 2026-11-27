---
'@maronn-openid-connect/cli': minor
---

`--enable dpop` で生成する OP の保護されたリソース（UserInfo エンドポイント）が、設定すれば DPoP proof にサーバーの nonce を求めるようにする（RFC 9449 §9）。

- 設定 `ProviderConfig.dpopNonceRequiredAtResourceServer` が加わる（既定は `false`）。Next.js では環境変数 `OIDC_DPOP_NONCE_REQUIRED_AT_RESOURCE_SERVER` を `1` にすると `true` になる。
- `true` のとき、UserInfo エンドポイントは、`Authorization: DPoP` でアクセストークンを提示したリクエストには、そのスキームを読んだ後のどのレスポンス（200 もエラーも）にも、次の DPoP proof に入れる nonce を `DPoP-Nonce` ヘッダーで一つ付ける（`Authorization` に Bearer と DPoP を並べたリクエストへの 400、Next.js で署名鍵を読み込めないときの 503、秘密が 32 バイトより短いときの 500 には付けない）。`DPoP` ヘッダーの無い DPoP スキームのリクエストへの 401 の `invalid_dpop_proof` にも付ける。
- DPoP proof に `nonce` が無いか、保護されたリソースが `dpopNonceLifetimeSeconds` 秒（既定は 120）の間に発行した nonce でなければ、401 の `use_dpop_nonce` で拒否し、エラーは `DPoP` のチャレンジが伝える（`nonce` が無いときは `WWW-Authenticate: Bearer realm="UserInfo", DPoP algs="…", error="use_dpop_nonce", error_description="Resource server requires nonce in DPoP proof"`）。nonce は、DPoP proof の検査が署名と `htm`・`htu`・`iat` を確かめた後、`ath` の前に確かめ、nonce で拒否した DPoP proof の `jti` は覚えない。
- 保護されたリソースの nonce と認可サーバー（トークンエンドポイントと PAR エンドポイント）の nonce は別のもので、UserInfo エンドポイントは認可サーバーの nonce を、認可サーバーは UserInfo エンドポイントの nonce を受け付けない。
- Bearer で提示したリクエストとトークンの無いリクエストには、設定によらず nonce を渡さず、求めもしない。
- `false` のとき（既定）は、`DPoP-Nonce` を返さず、DPoP proof の `nonce` クレームも確かめないので、UserInfo の応答はこれまでと同じである。
- 秘密は認可サーバーの nonce と同じもの（Hono、Express、Fastify では `createApp()` / `applyOidc()` の `dpopNonceSecret`、Next.js では環境変数 `OIDC_DPOP_NONCE_SECRET`）を使う。複数のインスタンスで動かすときはすべてに同じ秘密（32 バイト以上）を与える。秘密が無いと、インスタンスごと（Workers の Hono では isolate ごと、Node.js の Hono、Express、Fastify ではプロセスごと、Next.js では `next start` のプロセスかサーバーレスの関数のインスタンスごと）の鍵で nonce を作るので、ほかのインスタンスに届いたやり直しは、また `use_dpop_nonce` で拒否される。

生成コードの変更:

- `features/dpop/server-nonce.ts`（Next.js は `_oidc-provider/features/dpop/server-nonce.ts`）に、nonce をレスポンスに付ける `provideDpopNonce()` と、設定が保護されたリソースに nonce を求めるときにその役割を返す `resourceServerNonceOf()` が加わり、UserInfo エンドポイントの dpop の処理（`readDpopUserInfoRequest()`）がそれを使う。Next.js では `_oidc-provider/features/dpop/userinfo.ts` が `server-nonce.ts` を読むようになる。
- nonce の処理は dpop の機能のファイルの中にあるので、生成した UserInfo エンドポイントを書き換えて使っていても、`[read-dpop-access-token]` のブロックが残っていれば、ブロックを写さずに設定を `true` にできる。
- UserInfo エンドポイントのコメント（Hono 系はパイプラインの先頭のコメントと `endpoint.ts` の JSDoc、Next.js は `route.ts` の先頭のコメントと JSDoc と `endpoint.ts` の JSDoc）に nonce の説明が加わり、`[read-dpop-access-token]` のブロックの見出しに RFC 9449 §9 が加わる。dpop を有効にしない生成物で変わるのは、このコメントだけである。
