---
'@maronn-openid-connect/cli': minor
---

`--enable dpop` を `--enable par` と一緒に指定して生成した PAR エンドポイントが、リクエストの `DPoP` ヘッダーの DPoP proof を検査し、その鍵の JWK Thumbprint をプッシュした認可リクエストの `dpop_jkt` として保存するようにする（RFC 9449 §10.1）。

- `DPoP` ヘッダーを付けて PAR でプッシュした認可リクエストの `request_uri` から発行した認可コードは、トークンエンドポイントで、同じ鍵の DPoP proof を送った交換だけが使える。DPoP proof の無い交換と別の鍵の交換は 400 の `invalid_grant` で拒否する（RFC 9449 §10.1 の MUST）。
- DPoP proof は、`htm` をリクエストのメソッド、`htu` を issuer の `/par` にして、トークンエンドポイントと同じに検査する。受け付けない DPoP proof（`htu` の違い、二つの `DPoP` ヘッダー、使い終えた `jti` など）は 400 の `invalid_dpop_proof`（理由を書いた `error_description` 付き、`Cache-Control: no-cache, no-store`）で拒否し、リクエストを保存しない。クライアントの認証に失敗したリクエストの DPoP proof は検査せず、その `jti` も覚えない。
- ボディの `dpop_jkt` と `DPoP` ヘッダーの両方を送ったリクエストは、同じ鍵なら受け付け、違えば 400 の `invalid_dpop_proof`（`dpop_jkt does not match the key of the DPoP proof`）で拒否する（RFC 9449 §10.1 の MUST）。
- PAR エンドポイントは、プッシュした `dpop_jkt` の形も認可エンドポイントと同じに確かめ、JWK Thumbprint の形でない値を 400 の `invalid_request`（`dpop_jkt must be a base64url SHA-256 JWK Thumbprint`）で拒否する（RFC 9126 §2.1）。これまでは 201 で受け付け、認可エンドポイントで `invalid_request` になっていた。空の値は省略と同じに扱い、`DPoP` ヘッダーがあればその鍵で置き換える。
- `DPoP` ヘッダーの無いリクエストは、これまでどおり、ボディの `dpop_jkt`（あれば）ごとそのまま保存する。
- 生成コードには、Hono（Express、Fastify を含む）の PAR エンドポイントのパイプライン（`features/par/endpoints/par/pipeline.ts`）に `[bind-pushed-dpop-key]` のステップ（`features/dpop/steps/bind-pushed-dpop-key.ts` の `bindPushedDpopKey(c, pushedParams)`）が、Next.js の `(par)/par/route.ts` に同じ名前のブロック（`_oidc-provider/features/dpop/par.ts` の `bindPushedDpopKey(request, pushedParams)`）が加わる。鍵の照らし合わせは `features/dpop/binding.ts` の `resolvePushedDpopJkt(dpopJkt, proofJkt)` が行う。

これで、RFC 9449 §10.1 の二つの方法（ボディの `dpop_jkt` と `DPoP` ヘッダー）の両方を受け付け、鍵が違うリクエストを拒否する。クライアントのメタデータ `dpop_bound_access_tokens`（§5.2）と、サーバーが発行する nonce（§8 / §9）は後のリリースで加える。

`dpop` を有効にしない生成物（`par` を有効にしたもの）は、PAR エンドポイントのクライアントの認証の後に `const dpopBoundParams = undefined;` が入り、検証と保存に `dpopBoundParams ?? pushedParams` を渡すようになる（答えは変わらない）。PAR エンドポイントのパイプライン（Hono、Express、Fastify の `features/par/endpoints/par/pipeline.ts`）か Next.js の `(par)/par/route.ts` に手を加えている場合は、生成し直したあと、その変更を新しい形に移す。
