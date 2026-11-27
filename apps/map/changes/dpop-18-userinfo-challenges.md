# UserInfo エンドポイントの失敗の応答に、Bearer と並べて DPoP のチャレンジを返す（DPoP の段 18）

DPoP（RFC 9449）を生成 OP に入れる段の 18 個目で、UserInfo エンドポイントの `WWW-Authenticate` を RFC 9449 §7.2 の Figure 17 / 18 / 19 の形にする。
段 17 は、DPoP スキームでトークンを提示したリクエストの失敗にだけ `DPoP algs="…"` のチャレンジを足していた。そのため、トークンの無いリクエストや Bearer のリクエストの失敗は `Bearer realm="UserInfo"` だけで答え、クライアントは DPoP を受け付けることも、受け付ける alg も知れなかった（B-1）。
この段では、`dpop` のブロックがどのリクエストでも先に DPoP のチャレンジを足す。エラーの情報は、段 5 の形のとおり、トークンを提示したスキームのチャレンジが伝えるので、トークンの無いリクエストでは `Bearer realm="UserInfo", DPoP algs="…"`、Bearer のトークンの失敗では Bearer のチャレンジにエラーが入り、DPoP のチャレンジはエラー無しで並ぶ。束縛したトークンを Bearer で提示したリクエストも、Bearer のチャレンジが `invalid_token` を伝える（B-7）。
Bearer と DPoP の両方でトークンを送ったリクエスト（`Authorization` を二つ送った、`Authorization: DPoP` にフォームのボディの `access_token` を添えた）は、どちらのスキームで認証しようとしたのか決まらないので、400 の `invalid_request` にして、両方のチャレンジにエラーを入れる（Figure 19）。段 17 では、`Bearer X, DPoP X` は Bearer のブロックが `X, DPoP X` をトークンと読んで 401 の `invalid_token` に、`DPoP X, Bearer X` は token68 でない値として DPoP のチャレンジだけの 400 になっていた。
`dpop` を有効にした OP では、DPoP を使わないリクエストの失敗にも DPoP のチャレンジが並ぶが、ステータスとボディは前と同じで、地図の実 OP のケースもすべて前と同じに答えた。`dpop` を有効にしない生成物は、`dpop` のブロックごと消えるので、`WWW-Authenticate` も前と同じである。

## readDpopUserInfoRequest <!-- hono:oidc-provider/features/dpop/steps/read-dpop-access-token.ts#readDpopUserInfoRequest nextjs:app/_oidc-provider/features/dpop/userinfo.ts#readDpopUserInfoRequest -->

DPoP のチャレンジを足す場所を、DPoP スキームかどうかを読む前に移し、両方のスキームでトークンを送ったリクエストを拒否する確認を足した。

- チャレンジを足すのは、`Authorization` を読むより前である。このステップは UserInfo の最初のステップなので、トークンの無いリクエストも、Bearer のステップや core の検証の失敗も、すべて DPoP のチャレンジを並べて答える（RFC 9449 §7.2 の 1 つ目と 2 つ目の規則）。`challenges.scheme` を DPoP にするのは、これまでどおり DPoP スキームと決まったときだけなので、Bearer の失敗のエラーは Bearer のチャレンジに入る
- `Authorization` が Bearer と DPoP の両方を名指すかを、DPoP スキームを読む前に確かめる。後にすると、`Bearer X, DPoP X` は DPoP スキームと読まれず Bearer のステップに渡り、`DPoP X, Bearer X` は token68 の誤りとして DPoP のチャレンジだけに入るためである
- `Authorization: DPoP` とフォームのボディの `access_token` の併用も、フォームのボディが Bearer の方法（RFC 6750 §2.2）なので、同じエラーにした。段 17 は DPoP のチャレンジだけにエラーを入れていた。Bearer のヘッダーとフォームのボディの併用は、どちらも Bearer の方法でスキームが決まるので、これまでどおり Bearer のステップが Bearer のチャレンジだけにエラーを入れる
- 二つの `Authorization` が一つの値で届くのは、ランタイムが Fetch の `Headers` のように値をコンマでつなぐときである（Cloudflare Workers、`@hono/node-server`）。Node.js の `http` モジュールの `IncomingMessage.headers` は二つ目の `Authorization` を捨てるので、それから `Request` を作るランタイム（生成する Express と Fastify のアダプタ）では最初のフィールドだけが届き、そのスキームのリクエストとして扱われる
- ステップのラベルを、チャレンジを並べることも言う形にした（Hono のステップのメタと、両方のフレームワークのマーカー）
- テストは、Bearer のリクエストで `challenges` に DPoP のチャレンジが足されること、トークンの無いリクエストの 401（Figure 17）、知らない Bearer のトークンの 401（Figure 18）、Bearer のヘッダーとフォームのボディの併用の 400（Bearer のチャレンジだけがエラーを伝える）、`Authorization` の二つのフィールドを両方の順で送ったときの 400（Figure 19）、`Authorization: DPoP` とフォームのボディの併用の 400（両方のチャレンジ）を、`WWW-Authenticate` の値をそのまま書いて確かめる。二つのフィールドのテストは、そのトークンの正しい DPoP proof を送るので、二つのスキームの確認だけがリクエストを拒否する。token68 でない値のテストは、Bearer を含まない値（二つの DPoP のフィールド）に変えた

## namesBearerAndDpopSchemes <!-- hono:oidc-provider/features/dpop/resource.ts#namesBearerAndDpopSchemes nextjs:app/_oidc-provider/features/dpop/resource.ts#namesBearerAndDpopSchemes -->

`Authorization` の値が Bearer と DPoP の両方の認証スキームを名指すかを返す関数を、保護されたリソースの検査を集める `resource.ts` に足した。

- 値をコンマで区切り、要素ごとに先頭の語をスキームとして読む。Bearer の b64token も DPoP の token68 もコンマを含まないので、コンマの後ろは別のフィールドの値である。スキームは大文字と小文字を区別しない（RFC 9110 §11.1）
- 同じスキームを二つ並べた値は、スキームが一つに決まるので false を返す。`DPoP X, DPoP Y` は DPoP のステップが token68 の誤りとして、`Bearer X, Bearer Y` は Bearer のステップが知らないトークンとして、これまでどおり答える。Bearer のヘッダーの読み方は基盤の振る舞いで、`dpop` を有効にしない生成物と同じにしておくためである
- テストは、両方を名指す値（順、大文字と小文字、コンマの後ろの空白の有無、トークンの無い `Bearer`）と、名指さない値（片方だけ、同じスキームを二つ、Basic との組み合わせ、`Bearer=` のようにスキームでない語）を確かめる

## ambiguousUserInfoRequestError, userInfoEndpointErrorOf <!-- hono:oidc-provider/features/dpop/error-responses.ts#ambiguousUserInfoRequestError nextjs:app/_oidc-provider/features/dpop/error-responses.ts#ambiguousUserInfoRequestError hono:oidc-provider/features/dpop/error-responses.ts#userInfoEndpointErrorOf nextjs:app/_oidc-provider/features/dpop/error-responses.ts#userInfoEndpointErrorOf -->

両方のスキームでトークンを送ったリクエストへの UserInfo エンドポイントのエラーを返す関数を足した。

- DPoP の検査の失敗（`DpopError`）は、`userInfoEndpointErrorOf()` が、トークンを提示したスキームのチャレンジにエラーを入れるエラーにする。両方のスキームのリクエストでは、段 5 の `everyScheme` でどのチャレンジにもエラーを入れたいので、`DpopError` を通さずに UserInfo エンドポイントのエラーを直接返す関数にした。`DpopError` はトークンエンドポイントとも共有するので、チャレンジの都合を持ち込まないためでもある
- 説明の文言は、Bearer の二つの方法を併用したリクエストへの JSON と同じ `Multiple access token methods are not allowed` にした。チャレンジにも `error_description` を入れるのは Figure 19 に合わせたためである。Bearer の二つの方法の併用は、`main` と同じ答えを保つため、チャレンジに `error` だけを入れる段 5 の形のままである
- `userInfoEndpointErrorOf()` は JSDoc だけを変えた。二つの方法で送ったトークンは、もう `DpopError` の `invalid_request` にならないためである。同じ理由で、`errors.ts` の `invalid_request` の説明からもその場合を除いた
- テストは、レスポンス（400 と JSON）と、Bearer と DPoP のチャレンジを並べたときの `WWW-Authenticate` の値を、そのまま書いて確かめる

## handler, userinfo <!-- hono:oidc-provider/endpoints/userinfo/pipeline.ts#handler nextjs:app/userinfo/route.ts#userinfo -->

`dpop` のブロックのマーカーのラベルと、パイプライン（Hono）とルート（Next.js）の先頭のコメントだけを変えた。`dpop` のブロックが、DPoP のチャレンジを Bearer のチャレンジと並べ、両方のスキームで送ったトークンを拒否することも書いた。

- 処理の木は変わらない。答えの変化は `readDpopUserInfoRequest` のテストが確かめる
- UserInfo エンドポイント全体のテスト（Hono の `pipeline.test.ts` と `app.test.ts`、Next.js の `route.test.ts`）は、Bearer のチャレンジの後ろに DPoP のチャレンジが並ぶ値に書き直した。テンプレートはすべての機能を有効にしているので、`dpop` のブロックもそこで動くためである。`dpop` を有効にしない生成物ではブロックが消え、Bearer のチャレンジだけになる
