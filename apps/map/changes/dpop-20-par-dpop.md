# PAR のリクエストの DPoP proof の鍵で、認可コードを束縛する（DPoP の段 20）

DPoP（RFC 9449）を生成 OP に入れる段の 20 個目で、`par` と一緒に有効にしたときに、PAR エンドポイントがリクエストの `DPoP` ヘッダーの DPoP proof を検査し、その鍵の JWK Thumbprint をプッシュした認可リクエストの `dpop_jkt` にするようにする（RFC 9449 §10.1）。
段 19 で、プッシュしたパラメータの `dpop_jkt` が認可コードを束縛するようになったので、この段は `DPoP` ヘッダーの鍵をその `dpop_jkt` として保存するだけで、`/authorize` での束縛とトークンエンドポイントでの照らし合わせ（段 16）がそのまま働く。§10.1 の二つの方法（ボディの `dpop_jkt` と `DPoP` ヘッダー）を両方受け付け、両方があって鍵が違うリクエストを拒否する MUST がこれで満たされる。
あわせて、プッシュした `dpop_jkt` の形を PAR エンドポイントで確かめる（段 19 までは、形の正しくない値を 201 で受け付け、`/authorize` で `invalid_request` になっていた。RFC 9126 §2.1 は、プッシュしたリクエストを認可エンドポイントと同じに検証することを求める）。
`DPoP` ヘッダーも `dpop_jkt` も無い PAR のリクエストへの答えは前と同じで、地図の実 OP のケースもすべて前と同じに答えた。`dpop` を有効にしない生成物ではブロックが消え、プッシュしたパラメータをそのまま検証して保存する。

## par, pushAuthorizationRequest <!-- endpoint:par nextjs:app/(par)/par/route.ts#pushAuthorizationRequest -->

クライアントを認証するブロックの後、リクエストを検証するブロックの前に `[bind-pushed-dpop-key]` ブロックを足し、その結果（`dpopBoundParams`）があれば、検証と保存にプッシュしたパラメータの代わりに渡すようにした。

- クライアントの認証の後に置いたのは、トークンエンドポイント（段 15）と同じく、認証に失敗したリクエストの DPoP proof を検査せず、その `jti` を覚えないためである。正しい DPoP proof を付けて認証に失敗したリクエストの後でも、同じ DPoP proof で送り直せる
- 検証と保存の前に置いたのは、`dpop_jkt` を入れたパラメータを、ほかのパラメータと同じ規則で検証し、そのまま `request_uri` の下に保存するためである。`/authorize` がそのリクエストを展開すると、段 19 の `[validate-dpop-jkt]` がその `dpop_jkt` で認可コードを束縛する
- 拒否はブロックが作ったレスポンス（`dpopRejection`）をそのまま返す。DPoP の機能は PAR の機能を前提にしない（`requires` が空）ので、PAR のエラーの型（`ParEndpointError`、`ParError`）を使えないためである。形は PAR のほかのエラーと同じ 400 の JSON（`no-cache, no-store`）である
- `dpop` を有効にしない生成物では、ブロックが `const dpopBoundParams = undefined;` に置き換わり、検証と保存には `pushedParams` がそのまま渡る（サンプルの hono-cloudflare の差分は、この置き換えと、それを渡す引数、二つのステップのメタデータの `consumes` / `optional`、パイプラインの先頭と `endpoint.ts` の説明の文である）
- テストは、`DPoP` ヘッダーの鍵が保存したパラメータの `dpop_jkt` になること、その `request_uri` から SSO で発行した認可コードが DPoP proof の無い交換と別の鍵の交換で `invalid_grant` になり、同じ鍵の DPoP proof の交換だけが `cnf.jkt` を持つ DPoP のアクセストークンになることを、固定した鍵とその JWK Thumbprint（コードとは別に計算した値）をそのまま書いて確かめる。認証に失敗したリクエストの DPoP proof の `jti` を覚えないこと、拒否したリクエストを保存しないこと、`DPoP` ヘッダーの無いリクエストを `dpop_jkt` ごとそのまま保存することも確かめる

## bindPushedDpopKey <!-- hono:oidc-provider/features/dpop/steps/bind-pushed-dpop-key.ts#bindPushedDpopKey nextjs:app/_oidc-provider/features/dpop/par.ts#bindPushedDpopKey -->

PAR のリクエストの `DPoP` ヘッダーの DPoP proof を検査し、その鍵を `dpop_jkt` にしたパラメータを返すステップ（Hono）とブロックの関数（Next.js）を足した。PR #205 の同じ関数をもとにした。

- DPoP proof は、トークンエンドポイントと同じ `verifyDpopRequestProof()` で、`htm` をリクエストのメソッド、`htu` を issuer の `/par` にして検査する（RFC 9449 §4.3）。`DPoP` ヘッダーが二つあるリクエスト、使い終えた `jti` の DPoP proof も、ほかのエンドポイントと同じく拒否する
- プッシュした `dpop_jkt` の形は、`DPoP` ヘッダーの有無にかかわらず、段 19 の `parseDpopJkt()` で DPoP proof の前に確かめる。形の正しくない値は、DPoP proof を検査せず（`jti` も覚えず）に 400 の `invalid_request` で拒否する。空の値は省略と同じに扱うので、`DPoP` ヘッダーがあればその鍵で置き換わる
- Hono のステップは、拒否のレスポンスをコンテキスト（`c.json()`）で作る。CORS のミドルウェアが先に付けたヘッダーを残すためで、`Response` を直接作ると消える。Next.js の関数は `Response` を作り、ルートの `POST` が CORS のヘッダーを付ける
- 拒否に使うのは、DPoP proof の不備と鍵の不一致の `invalid_dpop_proof` と、`dpop_jkt` の形の誤りの `invalid_request` だけである。`invalid_grant`（トークンエンドポイントのコード）と `invalid_token`（保護されたリソースのコード）は、PAR エンドポイントの検査が投げることはないが、投げられても PAR のエラーにせず、500 の `server_error` にする。PR #205 は `DpopError` をすべて 400 にしていた。段 17 でトークンエンドポイントに `invalid_token` を通さないようにしたのと同じ考えである
- `DPOP_ERROR_CODES` の `invalid_dpop_proof` と `invalid_request` の説明に、PAR エンドポイントが 400 で返すことを足した（`errors.ts`。コードの一覧は変えていない）
- テストは、上の PAR エンドポイントを通したものに加え、`htu` が別のエンドポイントの DPoP proof、`DPoP` ヘッダーが二つのリクエスト、使い終えた DPoP proof、設定の誤り（`dpopProofMaxAgeSeconds` が数でない）の 500、`invalid_grant` と `invalid_token` の 500、拒否のレスポンスに CORS のヘッダーが残ること、関数を直接呼んだときの戻り値を確かめる

## resolvePushedDpopJkt <!-- hono:oidc-provider/features/dpop/binding.ts#resolvePushedDpopJkt nextjs:app/_oidc-provider/features/dpop/binding.ts#resolvePushedDpopJkt -->

PAR のリクエストの DPoP proof の鍵を、プッシュした認可リクエストの認可コードを束縛する鍵として返す関数を `binding.ts` に足した。

- プッシュした `dpop_jkt` もあるときは、DPoP proof の鍵と同じでなければ `invalid_dpop_proof`（`dpop_jkt does not match the key of the DPoP proof`）で拒否する（RFC 9449 §10.1 の MUST。エラーコードは RFC が決めていないので、PR #205 と同じく DPoP proof の失敗として返す）
- PR #205 の同じ関数は、DPoP proof が無いときも受け取り、`dpop_jkt` を返していた。呼ぶのは DPoP proof があるときだけなので、DPoP proof の鍵を必ず受け取る形にし、通らない分かれ道を除いた
- テストは、`dpop_jkt` が無いときと同じ鍵のときに DPoP proof の鍵を返すこと、別の鍵のときに `invalid_dpop_proof` を投げることを確かめる
