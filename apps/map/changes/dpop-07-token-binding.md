# トークンを発行するステップが、トークンを鍵に束縛できるようにする（DPoP の段 7）

DPoP（RFC 9449）を生成 OP に入れる段の 7 つ目で、トークンを発行し、保存し、応答するステップに、トークンを束縛する鍵（`TokenBinding`）を省略できる入力として足す。
後の段で DPoP の機能がトークンリクエストの DPoP proof を検査し、その鍵の `TokenBinding` をこの入力に渡すと、アクセストークンに `cnf`（RFC 9449 §6.1）が入り、保存するレコードに `cnf` と `token_type` が残り、トークンレスポンスの `token_type` が `DPoP` になる（RFC 9449 §5）。
本体は DPoP を知らない形で「トークンが鍵に束縛されている」ことだけを扱い、束縛の値の組み立ては新しい本体のモジュール `token-binding.ts`（Hono と Next.js で同じ中身）にまとめた。
この段では、まだどのパイプラインも Route Handler も束縛を渡さないので、トークンエンドポイントの応答も保存するレコードも変わらない。
ステップの `tokenBinding` は `optional` の入力にしたので、それをつくるステップの無い生成（この段ではすべて）では、フローのデータから消える。
Next.js のトークンの Route Handler は、アクセストークンの発行と保存と応答を本体の中に直接書いているので、そこを束縛に対応させるのは、束縛をつくる DPoP のブロックを足す段にした。この段の Next.js は、`token-binding.ts` とリフレッシュトークンの発行だけを変える。
イントロスペクションが `cnf` を返すための関数と、認可リクエストの `cnf` を認可コードへ引き継ぐための関数は、それぞれを使う段で `token-binding.ts` に足す。

## tokenTypeOf, accessTokenClaimsOf, accessTokenRecordOf, refreshTokenRecordOf <!-- hono:oidc-provider/token-binding.ts#tokenTypeOf hono:oidc-provider/token-binding.ts#accessTokenClaimsOf hono:oidc-provider/token-binding.ts#accessTokenRecordOf hono:oidc-provider/token-binding.ts#refreshTokenRecordOf nextjs:app/_oidc-provider/token-binding.ts#tokenTypeOf nextjs:app/_oidc-provider/token-binding.ts#accessTokenClaimsOf nextjs:app/_oidc-provider/token-binding.ts#accessTokenRecordOf nextjs:app/_oidc-provider/token-binding.ts#refreshTokenRecordOf -->

束縛の有無で変わる値（`token_type`、アクセストークンのクレーム、保存するレコードのメンバー）を一か所で決める関数で、束縛が無ければ `Bearer` と空のオブジェクトを返す。
ステップは返した値をそのまま使うか展開するだけなので、束縛が無いときに組み立てる値は前と同じになる。

- `TokenBinding` は、アクセストークンの `cnf`、`tokenType`、リフレッシュトークンの `cnf`（`refreshTokenCnf`）の三つにした。DPoP なら `{ jkt }` と `DPoP` である。`cnf` を JWK Thumbprint に限らない形にしたのは、ほかの送り手の制約（mTLS の `x5t#S256`、RFC 8705）も同じ入力で渡せるようにするためである
- リフレッシュトークンを束縛するのは、束縛が `refreshTokenCnf` を持つときだけにした。RFC 9449 §5 は、パブリッククライアントに発行するリフレッシュトークンを DPoP proof の鍵に束縛し、機密クライアントのリフレッシュトークンは束縛しない（クライアント認証ですでに送り手が制約されている）と定めるので、どちらにするかを束縛をつくる機能が決められるようにした
- Next.js の `tokenTypeOf`、`accessTokenClaimsOf`、`accessTokenRecordOf` は、この段ではまだどこからも呼ばない。Route Handler の中のアクセストークンの発行とグラントの dispatch が使うのは、後の段からである

## issueAccessToken <!-- hono:oidc-provider/endpoints/token/steps/issue-access-token.ts#issueAccessToken -->

束縛があれば、署名する前のペイロードに確認のクレーム `cnf` を加える（RFC 7800 §3.1、RFC 9449 §6.1）。
JWT 形式のアクセストークンを自分で検証するリソースサーバーが、提示された DPoP proof の鍵とトークンの鍵を照らし合わせられるようにするためである。
core の `buildAccessTokenPayload()` は変えず、返したペイロードに展開して足した。core の公開 API を変えると、experimental と google-login のリリースまで要るためである。
束縛が無ければ空のオブジェクトを展開するので、ペイロードのメンバーとその順番は前と同じである。

## persistAccessToken <!-- hono:oidc-provider/endpoints/token/steps/persist-access-token.ts#persistAccessToken -->

束縛があれば、アクセストークンのレコードに `cnf` と `tokenType` を保存する。
不透明な文字列のトークンはクレームを運ばないので、イントロスペクションが `cnf` と `token_type`（RFC 9449 §6.2 は `DPoP` でなければならないとする）を返すにも、UserInfo エンドポイントがトークンの提示の仕方と照らし合わせるにも、レコードに残すほかないためである。
SQL と KV のストアは、専用の列の無い値を `payload` に入れて返すので、DB の形は変えていない（ストアのテストで、束縛が足したメンバーがそのまま戻ることを確かめた）。

## buildTokenResponse <!-- hono:oidc-provider/endpoints/token/steps/build-token-response.ts#buildTokenResponse -->

`token_type` を、束縛があればその `tokenType` に、無ければ `Bearer` にする。
RFC 9449 §5 は、鍵に束縛したアクセストークンのレスポンスに `token_type` の `DPoP` を入れなければならないとし、クライアントはそれを見て束縛されたことを知るためである。
値の型は `'Bearer'` のリテラルから文字列に広がるが、レスポンスのボディの型（`object`）は変わらない。

## issueRefreshToken <!-- hono:oidc-provider/features/refresh-token/steps/issue-refresh-token.ts#issueRefreshToken nextjs:app/_oidc-provider/features/refresh-token/token.ts#issueRefreshToken -->

束縛が `refreshTokenCnf` を持つときは、リフレッシュトークンのレコードにそれを `cnf` として保存する。
RFC 9449 §5 は、パブリッククライアントのリフレッシュトークンを DPoP proof の鍵に束縛し、次にそのリフレッシュトークンを使うときに同じ鍵の DPoP proof を求めなければならないとするので、その照合に使う鍵をレコードに残すためである。
照合するのは、束縛をつくる機能の役目である（後の段の DPoP の機能）。
ローテーションで新しく発行するリフレッシュトークンの `cnf` は、前のレコードから引き継がず、そのリクエストの束縛から決める。前のリフレッシュトークンの鍵と照らし合わせた DPoP proof の鍵がそのまま新しい束縛になるので、どの鍵を残すかも束縛をつくる機能に任せた。
