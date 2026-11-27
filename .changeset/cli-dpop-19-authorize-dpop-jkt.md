---
'@maronn-openid-connect/cli': minor
---

`--enable dpop` で生成した認可エンドポイントが、認可リクエストの `dpop_jkt`（DPoP の鍵の JWK Thumbprint、RFC 9449 §10）を読み、そこから発行する認可コードをその鍵に束縛するようにする。

- `dpop_jkt` を付けた認可リクエストから発行した認可コード（SSO、同意画面、ハイブリッドフローのどれでも）は、トークンエンドポイントで、同じ鍵の DPoP proof を送った交換だけが使える。DPoP proof が無い交換と別の鍵の交換は 400 の `invalid_grant` で拒否する（RFC 9449 §10 の MUST）。拒否した交換では、認可コードを使用済みにしない。
- `dpop_jkt` は、クエリ（`POST` ではボディ）、検証した Request Object、`par` と一緒に有効にしたときは PAR のボディで送ったパラメータのどれからでも読む。Request Object に `dpop_jkt` があれば、クエリの値より優先する（OIDC Core 1.0 §6.1）。
- 値は、SHA-256 の JWK Thumbprint を正規の base64url にした 43 文字でなければならない。それ以外の値は、`state` と `iss` を付けた `invalid_request`（`dpop_jkt must be a base64url SHA-256 JWK Thumbprint`）でクライアントへリダイレクトする。空の値は省略と同じに扱う（RFC 6749 §3.1）。
- `dpop_jkt` の無い認可リクエストへの答えは、これまでと同じである。
- 生成コードには、Hono（Express、Fastify を含む）の認可エンドポイントのパイプラインに `[validate-dpop-jkt]` のステップ（`features/dpop/steps/validate-dpop-jkt.ts` の `validateDpopJktParameter(validatedRequest, params, requestObjectClaims)`）が、Next.js の `authorize/route.ts` に同じ名前のブロック（`_oidc-provider/features/dpop/authorize.ts` の `validateDpopJktParameter(request, requestParams, requestObjectClaims)`）が加わる。どちらも、`features/dpop/binding.ts` の `parseDpopJkt(value)` で値を確かめる。

この段階で止めたリリースは、RFC 9449 の MUST のうち、PAR の `DPoP` ヘッダーをまだ満たさない。`par` と一緒に有効にしても、PAR のリクエストの `DPoP` ヘッダーの DPoP proof を検査せず、その鍵に認可コードを束縛しない（§10.1）。また、PAR のボディの形の正しくない `dpop_jkt` を PAR エンドポイントは受け付け、認可エンドポイントで `invalid_request` になる（プッシュしたリクエストを認可エンドポイントと同じに検証する RFC 9126 §2.1 に、`dpop_jkt` だけまだ合わない）。どちらも後のリリースで加える。`dpop_bound_access_tokens`（§5.2）と、サーバーが発行する nonce（§8 / §9）も後のリリースである。

`dpop` を有効にしない生成物は、認可エンドポイントの `[create-transaction]` の前に `const codeConfirmation = undefined;` が入り、トランザクションを作る処理に渡すようになる（Hono、Express、Fastify では `createAuthorizationTransaction()` の 4 番目の引数、Next.js では `createAuthTransaction()` の結果に重ねる `confirmationRecordOf({ cnf: codeConfirmation })`。答えは変わらない）。認可エンドポイントのパイプライン（Hono、Express、Fastify の `endpoints/authorize/pipeline.ts`）か Next.js の `authorize/route.ts` に手を加えている場合は、生成し直したあと、その変更を新しい形に移す。
