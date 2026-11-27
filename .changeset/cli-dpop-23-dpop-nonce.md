---
'@maronn-openid-connect/cli': minor
---

`--enable dpop` で生成する DPoP の機能に、サーバーが発行する DPoP の nonce（RFC 9449 §8 / §9）を作って確かめる仕組みを加える。このリリースでは、どのエンドポイントも nonce を求めず、`DPoP-Nonce` ヘッダーも返さないので、OP の応答は変わらない。

- `features/dpop/nonce.ts`（Next.js は `_oidc-provider/features/dpop/nonce.ts`）が加わる。nonce はサーバーに状態を持たず、発行した時刻と 12 バイトの乱数に、秘密の鍵での HMAC-SHA256（発行したサーバーの役割と issuer も入れる）を付けたもので、`issueDpopNonce()` が作り、`verifyDpopNonce()` が確かめる。データベースのテーブルやキーは増えない。認可サーバーの nonce は保護されたリソースで受け付けず、保護されたリソースの nonce は認可サーバーで受け付けない。
- `features/dpop/proof.ts` の `verifyDpopRequestProof()` の `target`（`DpopProofTarget`）に、省略できる `nonceServer`（`'authorization-server'` か `'resource-server'`）が加わる。渡すと、DPoP proof の `nonce` がそのサーバーの最近の nonce であることを、`jti` を消費する前に確かめ（`validateDpopProofNonce()`）、無いか受け付けないときは `use_dpop_nonce` の `DpopError` を投げる。省略すれば、これまでどおり `nonce` は確かめない。DPoP の検査のエラーコード（`DpopErrorCode`）に `use_dpop_nonce` が加わる。
- 設定 `ProviderConfig.dpopNonceLifetimeSeconds`（nonce を発行から受け付ける秒数）が加わり、dpop の機能が既定の 120 を与える。
- nonce の秘密は、Hono、Express、Fastify では `createApp()` / `applyOidc()` に渡す `OidcProviderOptions.dpopNonceSecret`（省略できる）で、dpop の機能がリクエストごとにリクエストコンテキストの `dpopNonceSecret` に入れる。Next.js では環境変数 `OIDC_DPOP_NONCE_SECRET` である。どちらも UTF-8 で 32 バイト以上にし、複数のインスタンスで動かすときはすべてに同じ秘密を与える。秘密が無ければ、インスタンスごと（Workers の Hono では isolate ごと、Node.js の Hono、Express、Fastify ではプロセスごと、Next.js では `next start` のプロセスかサーバーレスの関数のインスタンスごと）に乱数の鍵を作るので、その nonce は、発行したインスタンスのほかと、再起動した後のインスタンスでは受け付けられない。
- 秘密が 32 バイトより短いときと、`dpopNonceLifetimeSeconds` が 0 以上の有限の数でないときは、nonce を確かめるときに `Error` を投げる（設定の誤り）。

nonce を求めるかどうかの設定と、トークンエンドポイント、PAR エンドポイント、UserInfo エンドポイントが nonce を求めて `DPoP-Nonce` ヘッダーで渡すこと（RFC 9449 §8 / §9）は、後のリリースで加える。nonce を使うかどうかはサーバーが選べる（RFC 9449 §8 / §9 の MAY）ので、nonce を求めないことは RFC 9449 に反しない。

`dpop` を有効にしない生成物は変わらない。
