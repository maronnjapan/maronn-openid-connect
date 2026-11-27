# UserInfo エンドポイントが DPoP スキームのアクセストークンを受け付け、束縛したトークンを Bearer として受け付けない（DPoP の段 17）

DPoP（RFC 9449）を生成 OP に入れる段の 17 個目で、保護されたリソースとしての UserInfo エンドポイントに DPoP を入れる。
段 15 と段 16 で、トークンエンドポイントはアクセストークンを DPoP proof の鍵に束縛するようになったが、UserInfo エンドポイントはその束縛を見ずに Bearer として受け付けていた。RFC 9449 §7.2 は、Bearer と DPoP の両方を受け付ける保護されたリソースに、束縛したアクセストークンを Bearer として受け付けないことを MUST で求めるので、この段で拒否する。
同時に、束縛したアクセストークンを正しく使う道として、`Authorization: DPoP <token>` と `ath` 入りの DPoP proof を受け付ける（RFC 9449 §7.1）。
失敗の応答は段 5 のチャレンジの形に乗せた。DPoP スキームのリクエストでは、`dpop` のブロックが `challenges` に `DPoP algs="…"` を足して、トークンを提示したスキームを DPoP にするので、エラーの情報は DPoP のチャレンジに入る。Bearer のリクエストには DPoP のチャレンジを足さないので、`WWW-Authenticate` は前と同じである。認証情報の無いリクエストと Bearer の失敗にも DPoP のチャレンジを並べる（RFC 9449 §7.2 の Figure 17 / 18）のは段 18 である。
`Authorization: DPoP` の値が一つの token68 であることも確かめる（RFC 9449 Figure 12）。PR #205 は空でない値なら何でもトークンとして読んでいた（B-2）。
`Authorization: DPoP` を送らないリクエストへの答えは、DPoP の鍵に束縛したアクセストークンを Bearer で提示したもの（期限、`openid` スコープ、`aud` の検査を通れば 401 の `invalid_token` になる）のほかは前と同じで、地図の実 OP のケースもすべて前と同じに答えた。

## handler, userinfo <!-- hono:oidc-provider/endpoints/userinfo/pipeline.ts#handler nextjs:app/userinfo/route.ts#userinfo -->

Bearer のトークンを読むブロックの前に、DPoP スキームのトークンを読む `dpop` のブロックを、トークンを取得して検証するブロックの後に、トークンを束縛した鍵と提示の仕方を照らし合わせる `dpop` のブロックを足した。

- DPoP のブロックを Bearer のブロックより前に置いたのは、`Authorization: DPoP` のリクエストでは Bearer のブロックがトークンを読まず（Bearer 以外のスキームはトークン無しと読む）、認証情報の無い 401 にしてしまうためである。Bearer のブロックは、DPoP のブロックが読んだトークン（`dpopAccessToken`）があればそれを使い、ボディを読み直さない。Next.js ではリクエストのボディを一度しか読めないためでもある
- 鍵の照らし合わせをトークンの取得の後に置いたのは、束縛した鍵（`cnf.jkt`）が保存したトークンのレコードにあるためである。期限切れや `aud` の違うトークンは、照らし合わせの前に core の検証が `invalid_token` で拒否する
- DPoP のブロックには、`try` の前で宣言した `challenges` を渡す。DPoP proof の検査より先にチャレンジを足すので、DPoP のブロック自身の失敗も、後のブロックの失敗も、DPoP のチャレンジがエラーを伝える。Hono の機能のブロックは基盤の import を使えないが、`challenges` はパイプラインのローカルなので渡せる
- `dpop` を有効にしない生成物では、二つのブロックが消え、`const dpopAccessToken = undefined;` が入る。アクセストークンは `dpopAccessToken ?? (await parseUserInfoRequest(c))`（Next.js は `parseBearerAccessToken(request)`）で決まるので、答えは前と同じである。`dpopJkt` は照らし合わせのブロックしか読まないので、置き換えの定数は増えない
- Next.js の `GET` と `userinfo()` の JSDoc は、エラーが `Bearer` のものだけではなくなったので書き直した

## readDpopUserInfoRequest, formBodyHasAccessToken <!-- hono:oidc-provider/features/dpop/steps/read-dpop-access-token.ts#readDpopUserInfoRequest hono:oidc-provider/features/dpop/steps/read-dpop-access-token.ts#formBodyHasAccessToken nextjs:app/_oidc-provider/features/dpop/userinfo.ts#readDpopUserInfoRequest nextjs:app/_oidc-provider/features/dpop/userinfo.ts#formBodyHasAccessToken -->

`Authorization: DPoP` のトークンを読み、一緒に送られた DPoP proof を検査して、トークンとその鍵の JWK Thumbprint を返すステップ（Hono）とブロックの関数（Next.js）を足した。PR #205 の S16 をもとに、段 5 のチャレンジの形に合わせた。

- PR #205 は、DPoP のチャレンジだけの `WWW-Authenticate` を自分で作り、基盤の Bearer のチャレンジを置き換えていた。この段では、`challenges` に DPoP のチャレンジを足し、`scheme` を DPoP にするだけにした。チャレンジを並べてエラーを入れるのは段 5 の `userInfoChallengeHeader()` で、段 18 は DPoP のチャレンジを足す場所を変えるだけで済む
- DPoP スキームと決まったら、検査より先にチャレンジを足す。token68 でない値や DPoP proof の無いリクエストのように、このステップ自身が拒否するときも、DPoP スキームで提示しようとしたことは決まっているので、DPoP のチャレンジがエラーを伝える（RFC 9449 §7.2 の 2 つ目の規則）
- DPoP の検査の順は、token68、フォームのボディ、`DPoP` ヘッダーの数、DPoP proof である。DPoP proof を検査すると `jti` を使用済みにするので、形の誤りで拒否するリクエストの `jti` は覚えない
- フォームのボディの `access_token` は、空でないときだけ二つ目のトークンと数える。Bearer のブロックの数え方（`extractAccessToken()` と `parseUserInfoRequest()`）と同じにするためである。パラメータを繰り返したボディは、値のどれかが空でなければ二つ目のトークンと数える。Bearer のブロックは値を一つだけ読む（Hono は最後の値、Next.js は最初の値）ので、`access_token=&access_token=X` のように最初の値だけが空のボディを見逃さないためである（繰り返したパラメータも RFC 6750 §3.1 の `invalid_request` である）。ボディを読めないときは、Bearer のブロックと同じく、チャレンジの付かない 400 の `invalid_request` にする。PR #205 では 500 になっていた
- DPoP proof の `htu` は issuer の `/userinfo`、`htm` はリクエストのメソッドで、`ath` はトークンのハッシュでなければならない（RFC 9449 §4.3 / §7）。DPoP proof の検査は段 13 の `verifyDpopRequestProof()` で、トークンエンドポイントと同じ `jti` のストアを使う
- テストは、束縛したトークンを DPoP スキームで GET と POST に使えること、スキームの大文字と小文字を区別しないこと、DPoP proof が無い・`ath` が違う・`ath` が無い・`htu` と `htm` が違う・再送・`DPoP` ヘッダーが二つのときの 401 の `invalid_dpop_proof`、フォームのボディのトークンとの併用（`access_token` を繰り返し、最初の値だけが空のボディを含む）、`DPoP` だけの値、token68 でない値の 400 の `invalid_request`、読めないボディの 400、`openid` スコープの無いトークンの 403 を確かめる。失敗の `WWW-Authenticate` は値をそのまま書いて確かめる。token68 でない値のテストは、その値の `ath` を入れた正しい DPoP proof を送るので、token68 の確認だけがリクエストを拒否する。`algs` には、設定の alg のうち検査できるものだけが並ぶことも確かめる

## verifyDpopUserInfoAccess <!-- hono:oidc-provider/features/dpop/steps/verify-dpop-access-token.ts#verifyDpopUserInfoAccess nextjs:app/_oidc-provider/features/dpop/userinfo.ts#verifyDpopUserInfoAccess -->

取得したトークンのレコードの `cnf.jkt` と、トークンの提示の仕方を照らし合わせるステップ（Hono）とブロックの関数（Next.js）を足した。

- DPoP スキームで提示したトークンは、DPoP proof の鍵に束縛されていなければならない（RFC 9449 §7.1）。Bearer で提示したトークンは、DPoP の鍵に束縛されていてはならない（RFC 9449 §7.2 の MUST）。フォームのボディの `access_token` も Bearer の方法（RFC 6750 §2.2）なので、同じく拒否する
- Bearer で提示した束縛したトークンの失敗は、Bearer のチャレンジがエラーを伝える。PR #205 は DPoP のチャレンジに入れていたが、RFC 9449 §7.2 の 2 つ目の規則（使ったスキームが決まるなら、そのスキームのチャレンジがエラーを伝える）に合わない（B-7）。この段では Bearer のリクエストに DPoP のチャレンジを足さないので、`WWW-Authenticate` は Bearer のチャレンジだけになる
- PR #205 のステップは設定から `algs` を読むために `c` を受け取っていたが、チャレンジは `challenges` が持つので、トークンと鍵だけを受け取る形にした
- テストは、束縛したトークンを Bearer のヘッダーとフォームのボディで提示したときの 401 の `invalid_token`（Bearer のチャレンジ）、別の鍵の DPoP proof と束縛の無いトークンを DPoP スキームで提示したときの 401 の `invalid_token`（DPoP のチャレンジ）、束縛の無いトークンを Bearer で提示したときの 200 を確かめる。トークンエンドポイントが DPoP proof で束縛して発行したアクセストークンを、DPoP スキームでは受け付け、Bearer では拒否することも、発行から通して確かめる

## readDpopAuthorization, validateDpopCredentials <!-- hono:oidc-provider/features/dpop/resource.ts#readDpopAuthorization hono:oidc-provider/features/dpop/resource.ts#validateDpopCredentials nextjs:app/_oidc-provider/features/dpop/resource.ts#readDpopAuthorization nextjs:app/_oidc-provider/features/dpop/resource.ts#validateDpopCredentials -->

`Authorization` の値から DPoP スキームの credentials を読む関数と、credentials が一つの token68 であることを確かめる関数を、保護されたリソースの検査を集める `resource.ts` に足した。

- PR #205 の `readDpopAuthorization()` は、スキームを読むことと、トークンが空でないことの確認を一度にしていた。この段で二つに分けたのは、DPoP スキームだと決まった後で、形の誤りを拒否する前にチャレンジを足せるようにするためである
- token68（RFC 9449 Figure 12、RFC 9110 §11.2）でない値は 400 の `invalid_request` にした。PR #205 は空でなければ何でもトークンとして読んだので、`DPoP X, Bearer X` のように二つのスキームを並べた値（Fetch は二つの `Authorization` をコンマでつなぐ）が、`ath` の不一致という分かりにくい理由で拒否されていた（B-2）。二つのスキームを並べた値への Figure 19 の答え（どちらのチャレンジにもエラーを入れる）は段 18 である
- スキームは大文字と小文字を区別しない（RFC 9110 §11.1）。`DPoPX` のようにスキームの後ろに空白の無い値は DPoP スキームではないので、Bearer のブロックに任せる（トークン無しの 401 になる）
- テストは、RFC 9449 Figure 13 のアクセストークン（`~` と `.` を含む）を token68 として受け付けることと、空白・コンマ・途中の `=`・引用符を含む値を拒否することを確かめる

## validateDpopAccessTokenBinding <!-- hono:oidc-provider/features/dpop/resource.ts#validateDpopAccessTokenBinding nextjs:app/_oidc-provider/features/dpop/resource.ts#validateDpopAccessTokenBinding -->

トークンを束縛した鍵と DPoP proof の鍵（Bearer で提示したなら無し）を照らし合わせる規則を、`resource.ts` に足した。PR #205 の関数のままである。

- 束縛の無いトークンを DPoP スキームで提示したときも拒否する。RFC 9449 §7.1 は束縛したトークンの検査だけを決めているが、束縛の無いトークンに DPoP proof を付けても守るものが無く、クライアントの誤りなので、`invalid_token` で知らせる
- 説明の文言は、Bearer で提示した、束縛が無い、別の鍵の三つで分けた。どれもクライアントが送った値を含まない固定の文言である

## dpopChallengeOf <!-- hono:oidc-provider/features/dpop/resource.ts#dpopChallengeOf nextjs:app/_oidc-provider/features/dpop/resource.ts#dpopChallengeOf -->

受け付ける alg を `algs` パラメータに並べた DPoP のチャレンジ（段 5 の `UserInfoChallenge`）を返す関数を足した。PR #205 の `buildDpopChallenge()` の代わりである。

- エラーの情報はこの関数では入れず、段 5 の `userInfoChallengeHeader()` が、使ったスキームのチャレンジの後ろに足す。PR #205 は `error` を `algs` の前に置いていたが、クライアントは auth-param を名前で読むので、後ろに足しても意味は変わらない
- `algs` は `dpopSigningAlgsOf()` の alg（設定のうち検査できるもの）で、Discovery の `dpop_signing_alg_values_supported` と同じである。一つも無ければ `algs` を付けない。Discovery が、検査できる alg が無いときに `dpop_signing_alg_values_supported` を載せない（段 15）のと同じく、使える alg の無い空の一覧を伝えないためである
- `realm` は付けない。RFC 9449 §7.1 は MAY としており、Figure 15 から 19 の DPoP のチャレンジも `realm` を持たない

## userInfoEndpointErrorOf <!-- hono:oidc-provider/features/dpop/error-responses.ts#userInfoEndpointErrorOf nextjs:app/_oidc-provider/features/dpop/error-responses.ts#userInfoEndpointErrorOf -->

DPoP の検査の失敗（`DpopError`）を UserInfo エンドポイントのエラー（段 5 の `UserInfoEndpointError`）にする関数を足した。

- `invalid_dpop_proof` と `invalid_token` は 401、`invalid_request` は 400 にした（RFC 6750 §3.1、RFC 9449 §7.1）。エラーの情報は、レスポンスの JSON と、使ったスキームのチャレンジに入れる。PR #205 はここで DPoP のチャレンジの文字列を作っていたが、チャレンジを並べるのは段 5 の `respondUserInfoError()` に任せた
- `invalid_grant` は UserInfo エンドポイントのエラーにせず、そのまま返す（500 の `server_error` になる）。トークンエンドポイントだけが返すコード（RFC 6749 §5.2）で、保護されたリソースのチャレンジには載せないと、段 16 で `errors.ts` に書いたためである。UserInfo の検査が `invalid_grant` を投げることは無いが、投げても `WWW-Authenticate` に入らないようにした
- `errors.ts` のエラーコードの一覧に `invalid_token` と `invalid_request` を足し、`invalid_token` は保護されたリソースだけが 401 で返すこと、`invalid_request` はトークンエンドポイントも保護されたリソースも 400 で応答することを書いた。`invalid_dpop_proof` の項にも、トークンエンドポイントは 400、保護されたリソースは 401 で応答することを書き足した
- DPoP の失敗でないエラー（core の `UserInfoError`、設定の誤りの `Error`）はそのまま返す。前者は段 5 のとおり使ったスキームのチャレンジで、後者は 500 の `server_error` で応答する

## tokenEndpointErrorOf, tokenEndpointRejectionOf <!-- hono:oidc-provider/features/dpop/error-responses.ts#tokenEndpointErrorOf nextjs:app/_oidc-provider/features/dpop/error-responses.ts#tokenEndpointRejectionOf -->

トークンエンドポイントでの DPoP の検査の失敗を 400 のエラーレスポンスにする関数（段 15）が、`invalid_token` をトークンエンドポイントのエラーにしないようにした。

- この段で `DpopErrorCode` に足した `invalid_token` は、保護されたリソースだけが返すコード（RFC 6750 §3.1）で、RFC 6749 §5.2 のトークンエンドポイントのエラーコードではない。`userInfoEndpointErrorOf()` が `invalid_grant` をそのまま返すのと同じく、そのまま返す（Hono は呼び出し側がそのまま投げ、Next.js は `undefined` を返して呼び出し側が投げ直すので、どちらも 500 の `server_error` になる）。トークンエンドポイントの検査が `invalid_token` を投げることは無いが、`errors.ts` に書いた「保護されたリソースだけが返す」をコードでも守るためである
- `invalid_request` は RFC 6749 §5.2 のコードでもあるので、これまでどおり 400 にする。JSDoc に、`invalid_request` と `invalid_token` の扱いを書き足した
- テストは、`invalid_token` をそのまま返すこと（Next.js は `undefined` を返すこと）と、`invalid_request` を 400 にすることを確かめる
