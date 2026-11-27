---
'@maronn-openid-connect/cli': minor
---

`--enable dpop` と `--enable dynamic-client-registration` を一緒に指定して生成したクライアント登録エンドポイント（`POST /register`）が、クライアントメタデータ `dpop_bound_access_tokens`（RFC 9449 §5.2）を検証して登録し、201 のレスポンスで返すようにする。

- 値は真偽値で、省略すると `false` を登録して返す。そのため `dpop` を有効にした OP では、この値を送らない登録の 201 のボディにも `"dpop_bound_access_tokens": false` が加わる。
- 真偽値でない値（文字列の `"true"`、数、`null` など）は、何も保存せずに、キャッシュさせない 400 の `invalid_client_metadata`（`dpop_bound_access_tokens must be a boolean`）で拒否する。ほかのメタデータの誤りは先に答え、登録数の上限（429）より先にこの誤りを答える。
- `true` で登録したクライアントは、登録したメタデータ（`registrationMetadata`）にこの値を持つので、トークンエンドポイントは、そのクライアントの `DPoP` ヘッダーの無いトークンリクエストを 400 の `invalid_dpop_proof` で拒否する（前のリリースで加えた検査）。前のリリースまでは、動的クライアント登録はこの値を理解しないメタデータとして捨てていた。
- ソフトウェアステートメントの値は、平文の値より優先する。動的クライアント登録の設定の `customClientMetadata` に `dpop_bound_access_tokens` の検証関数を置いている場合は、その関数が返した値（`undefined` を返したときはリクエストの値）を検証して登録するので、すべての動的登録クライアントを `true` にする関数などはそのまま使える。その関数が真偽値でない値を返すと、登録は 400 の `invalid_client_metadata` になる。
- 生成コードには、`features/dpop/steps/validate-dpop-client-metadata.ts`（Next.js は `_oidc-provider/features/dpop/register.ts`）の `registerDpopClientMetadata()` が加わり、登録エンドポイントの `[validate-dpop-client-metadata]` ブロックがこれを呼ぶ。このファイルは、`dynamic-client-registration` を有効にしない OP にも生成されるが、どこからも呼ばれない。

Next.js の生成物では、`(dynamic-client-registration)/register/route.ts` の処理を Hono のパイプラインと同じステップのブロックに分け、隣に `endpoint.ts` を加える（答えは変わらない）。`route.ts` に手を加えている場合は、生成し直したあと、その変更を新しいブロックへ移す。

`dpop` を有効にしない生成物では、登録への答えは変わらない。生成コードは、上の Next.js のブロックの分割のほか、Hono、Express、Fastify の `features/dynamic-client-registration/endpoints/register/pipeline.ts` と Next.js の `route.ts` に `const dpopClient = undefined;` とそれを渡す引数が加わり、コメントとステップのメタデータが変わる。サーバーが発行する nonce（§8 / §9）は後のリリースで加える。
