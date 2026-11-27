# 動的クライアント登録で dpop_bound_access_tokens を登録できるようにする（DPoP の段 22）

DPoP（RFC 9449）を生成 OP に入れる段の 22 個目で、`dpop` と `dynamic-client-registration` を一緒に有効にしたときに、`POST /register` がクライアントメタデータ `dpop_bound_access_tokens`（RFC 9449 §5.2）を検証して登録し、201 のレスポンスで返すようにする。
段 21 で、トークンエンドポイントは動的に登録したクライアントの登録したメタデータ（`registrationMetadata`）からこの値を読むようになったが、動的クライアント登録はこの名前を理解しないメタデータとして黙って捨てていた（`customClientMetadata` に検証関数を足した場合だけ残った）。この段で、動的に登録したクライアントも `true` を登録すれば、DPoP proof の無いトークンリクエストを拒否されるようになる。
Next.js のクライアント登録のルートハンドラはブロックに分けていなかったので、DPoP のブロックを置くために、まず Hono のパイプラインと同じステップのブロックに分け、隣に `endpoint.ts` を置いた。この分割では答えを変えていない。
`dpop` を有効にした OP では、`dpop_bound_access_tokens` を送らない登録の 201 にも `"dpop_bound_access_tokens": false` が加わる（省略したときの既定値を、ほかの既定値と同じく登録して返すため）。それ以外の登録への答えは前と同じで、地図の実 OP のケースもすべて前と同じに答えた。`dpop` を有効にしない生成物ではブロックが消え、登録への答えは前と同じである。

## register <!-- endpoint:register -->

メタデータを検証するブロックの後、クライアントを保存するブロックの前に `[validate-dpop-client-metadata]` ブロックを足し、その結果（`dpopClient`）があれば、保存と 201 のレスポンスに検証したクライアントの代わりに渡すようにした。

- メタデータの検証の後に置いたのは、ほかのメタデータの誤り（`redirect_uris` など）を先に答えるためと、ソフトウェアステートメントを適用した後の値（RFC 7591 §3.1.1 で平文の値より優先する値）と、`customClientMetadata` の検証関数が登録した値を読むためである
- 保存の前に置いたのは、真偽値でない値の登録を何も保存せずに拒否するためである。登録数の上限の確認（429）より先に答えるので、上限に達していても、値の誤りは `invalid_client_metadata` として返る
- 拒否はブロックが作ったレスポンス（`dpopRejection`）をそのまま返す。DPoP の機能は動的クライアント登録の機能を前提にしない（`requires` が空）ので、その機能のエラーの型（`RegistrationEndpointError`、`ClientRegistrationError`）を使えないためである。形は登録のほかのエラーと同じ 400 の JSON（`no-store`、`Pragma: no-cache`）である
- `dpop` を有効にしない生成物では、ブロックが `const dpopClient = undefined;` に置き換わり、保存とレスポンスには `client` がそのまま渡る（サンプルの hono-cloudflare、express-flyio、fastify-flyio の差分は、この置き換えと、それを渡す引数、二つのステップのメタデータの `consumes` / `optional`、パイプラインの先頭と `endpoint.ts` の説明の文である）
- テストは、`true` を登録したクライアントの保存したレコードの `registrationMetadata` と 201 のボディを値をそのまま書いて確かめる。省略と `false` が `false` になること、真偽値でない値（文字列の `"true"`、数、`null`、オブジェクト）を何も保存せずに拒否すること、ほかのメタデータの誤りを先に答えること、上限に達していても値の誤りを先に答えること、ソフトウェアステートメントの値が平文の値に優先すること、拒否のレスポンスに CORS のヘッダーが残ることも確かめる。全機能を生成するアプリの登録のテストは、201 のボディに `dpop_bound_access_tokens: false` が加わった。段 21 の、`POST /register` で登録したクライアントにトークンエンドポイントが DPoP proof を求めることを確かめるテストは、`customClientMetadata` の検証関数を外し、このブロックが登録した値で確かめるようにした

## registerClient <!-- nextjs:app/(dynamic-client-registration)/register/route.ts#registerClient -->

ルートハンドラの処理を、Hono のパイプラインと同じ ID と名前のステップのブロック（`[verify-initial-access-token]`、`[parse-request]`、`[verify-software-statement]`、`[validate-metadata]`、`[store-client]`、`[respond]`、`[respond-error]`）に分け、隣の `endpoint.ts` にステップの並びと、各ステップが読む値と作る値を書いた。そのうえで、Hono と同じ位置に `[validate-dpop-client-metadata]` ブロックを足した（理由は上の `register` と同じ）。地図の要約がブロックごとに「ステップを足した」と出すのは、関数にブロックの目印が無かったためで、処理を消したわけではない。

- 答えは変えていない。`Content-Type` と `Content-Length` の確認と署名鍵の読み込みは `try` の外から `[parse-request]` ブロックの中（`try` の中）に移したが、どれも例外を投げないので、同じ答えになる。初期アクセストークンの確認は `try` の外に残したので、設定の関数が例外を投げたときの扱いも前と同じである
- 署名鍵の読み込みは、メディアタイプと宣言された長さの確認の後、ボディを読む前という元の順序のまま `[parse-request]` ブロックに置いた。Next.js のほかのルートのように最初の `[load-signing-keys]` ブロックに分けると、署名鍵を読み込めないときに、初期アクセストークンやメディアタイプの誤りへの 401 / 400 が 503 に変わるためである。そのため、`endpoint.ts` では `[parse-request]` が `keys` も作る
- `dpop` を有効にしない生成物（サンプルの nextjs-vercel）では、ブロックの目印とコメント、`endpoint.ts` が加わり、`[validate-dpop-client-metadata]` ブロックは `const dpopClient = undefined;` に置き換わる
- テストは、ブロックに分ける前のルートでも通ることを確かめたものを足した。宣言された長さが上限を超えるリクエストをボディを読まずに拒否すること、JSON のオブジェクトでないボディの 400、署名鍵を読み込めないときにメディアタイプの誤りは 400 のままで、正しいリクエストは 503 になること、ストアの失敗の 500、保存した後に上限を超えたと分かった登録を消して 429 で答えること、である。DPoP のブロックのテストは Hono と同じものを `features/dpop/register.test.ts` に置いた

## registerDpopClientMetadata <!-- hono:oidc-provider/features/dpop/steps/validate-dpop-client-metadata.ts#registerDpopClientMetadata nextjs:app/_oidc-provider/features/dpop/register.ts#registerDpopClientMetadata -->

登録するクライアントのメタデータに `dpop_bound_access_tokens` を入れるステップ（Hono）とブロックの関数（Next.js）を足した。PR #205 には動的クライアント登録の部分が無く、新しく書いた。

- 値は真偽値で、省略したときは `false` を登録して返す（RFC 9449 §5.2 の既定値）。RFC 7591 §3.2.1 は登録したメタデータをすべて返すことを求め、この OP はほかの既定値（`application_type` など）も登録して返すので、同じ扱いにした
- 真偽値でない値は、文字列の `"true"` も `null` も、400 の `invalid_client_metadata`（`dpop_bound_access_tokens must be a boolean`）で拒否する。トークンエンドポイントの `dpopBoundAccessTokensOf()` は真偽値の `true` だけを数えるので、ほかの値を登録すると、クライアントは DPoP を求められるつもりで求められなくなるためである
- 前のステップ（ブロック）が `dpop_bound_access_tokens` を登録していれば、リクエストの値の代わりにその値を検証する。そうなるのは `customClientMetadata` にこの名前の検証関数を置いたときだけで、段 21 の案内に従ってその関数を足した OP（たとえばすべての動的登録クライアントを `true` にする関数）の登録が、この段で変わらないようにするためである。その関数が `undefined` を返したときはリクエストの値を検証する
- 登録した値は `client.metadata` に入り、保存するレコードの `registrationMetadata` に写る（動的クライアント登録の `toClientRegistration()`）。`RegisteredClient.dpopBoundAccessTokens` には入れない。動的クライアント登録のコードは機能の名前を使えず、トークンエンドポイントはどちらも読むためである。`client` と `metadata` は書き換えず、新しいクライアントを返す
- 生成器は機能のディレクトリをまとめて出力するので、このファイルは `dynamic-client-registration` を有効にしない OP にも入る。登録エンドポイントがないので、どこからも呼ばれない（段 20 の PAR のファイルと同じで、関数の説明と Next.js のファイルの先頭にそう書いた）
- Hono のステップは、拒否のレスポンスをコンテキスト（`c.json()`）で作り、CORS のミドルウェアが先に付けたヘッダーを残す。Next.js の関数は `Response` を作り、ルートの `POST` が CORS のヘッダーを付ける
- テストは、上のエンドポイントを通したものに加え、`customClientMetadata` の検証関数が返した値（すべてを `true` にする関数、文字列にする関数）を検証すること、関数を直接呼んだときに渡したクライアントとメタデータを書き換えないことを確かめる
