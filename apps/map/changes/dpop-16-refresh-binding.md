# パブリッククライアントのリフレッシュトークンを DPoP proof の鍵に束縛し、束縛した認可コードとリフレッシュトークンに同じ鍵を求める（DPoP の段 16）

DPoP（RFC 9449）を生成 OP に入れる段の 16 個目で、段 15 が見送ったリフレッシュトークンの束縛を入れる。
パブリッククライアントが DPoP proof を送ったトークンリクエストでは、発行するリフレッシュトークンもその鍵に束縛する（`tokenBinding.refreshTokenCnf`。段 7 と段 8 のステップと dispatch が `cnf` として保存する）。RFC 9449 §5 の MUST である。
コンフィデンシャルクライアントのリフレッシュトークンは、段 15 と同じく束縛しない。クライアント認証で送り手がすでに限られているので、RFC 9449 §5 が束縛しないとしているためである。
束縛したリフレッシュトークンを提示するリクエストには、同じ鍵の DPoP proof を求める（§5 の MUST）。新しい `[validate-dpop-grant-binding]` ブロックが、DPoP proof の検査の直後に、提示された認可コードかリフレッシュトークンのレコードの `cnf.jkt` を DPoP proof の鍵と照らし合わせ、DPoP proof が無いか別の鍵なら 400 の `invalid_grant` で拒否する。
認可コードも同じブロックで照らし合わせる。段 10 で、認可リクエストの確認（`cnf`）を認可コードのレコードへ引き継ぐようにしたので、その鍵を確かめる口をこの段で作る（RFC 9449 §10）。認可リクエストの `dpop_jkt` を読んで確認を作るのは段 19 なので、この段の生成 OP 自身はまだ認可コードを束縛しない。
束縛の無いコードとリフレッシュトークン、`DPoP` ヘッダーの無いリクエストへの答えは前と同じで、地図の実 OP のケースもすべて前と同じに答えた。UserInfo エンドポイントの DPoP（段 17、18）は後の段である。

## token <!-- endpoint:token nextjs:app/token/route.ts#token -->

DPoP proof を検査するブロックにクライアントを渡し、その直後に、束縛した認可コードとリフレッシュトークンの鍵を確かめるブロックを足した。

- 新しいブロックを、グラントの dispatch と検証より前に置いたのは、拒否するリクエストで認可コードを使用済みにせず、トークンも発行しないためである。認可コードはグラントの検証が使用済みにし、リフレッシュトークンはトークンを発行した後のローテーションが使用済みにする
- DPoP proof の検査の後に置いたのは、照らし合わせる鍵（`dpopJkt`）がそこで決まるためである。DPoP proof が不正なリクエストは、段 15 のとおり `invalid_dpop_proof` で先に拒否する
- Next.js のブロックは、段 15 と同じく、拒否するときにルートが返すだけのレスポンス（`dpopGrantRejection`）を受け取る。早期の return が二つになるので、受け取る名前を `dpopRejection` と分けた
- `dpop` を有効にしない生成物では、二つのブロックがどちらも消える。新しいブロックの入力の `dpopJkt` は `dpop` のブロックしか読まないので、`const tokenBinding = undefined;` のほかに置き換えの定数は増えない（サンプルの差分はコメントだけである）

## verifyDpopTokenRequest <!-- hono:oidc-provider/features/dpop/steps/verify-dpop-proof.ts#verifyDpopTokenRequest nextjs:app/_oidc-provider/features/dpop/token.ts#verifyDpopTokenRequest -->

認証したクライアント（`tokenClient`）を受け取り、パブリッククライアントには `refreshTokenCnf` を持つ束縛を返すようにした。DPoP proof の鍵の JWK Thumbprint も `dpopJkt` として返す。

- パブリッククライアントかどうかは、core の `isPublicTokenClient()`（登録した認証方式が `none`）で決める。core は `none` とほかの方式を一緒に登録させないので、認証に通ったクライアントでは迷わない
- `dpopJkt` を束縛と別に返すのは、次のブロックが、束縛を作らない `DPoP` ヘッダーの無いリクエスト（`undefined`）と区別して鍵を照らし合わせるためである
- ローテーションで発行し直すリフレッシュトークンの `cnf` は、古いレコードからではなく、このリクエストの束縛から作る（段 7 の決め方）。束縛したリフレッシュトークンでは、次のブロックが鍵の一致を確かめてから発行するので、同じ鍵に束縛し続ける
- 束縛していないリフレッシュトークンを、パブリッククライアントが DPoP proof を付けてリフレッシュしたときは、新しいリフレッシュトークンをその鍵に束縛する。§5 は、DPoP proof を送ったパブリッククライアントに発行するリフレッシュトークンを束縛するとしており、提示したトークンが束縛されていたかを問わないためである
- テストは、RFC 9449 の Figure 5（認可コード）と Figure 7（リフレッシュ）のパブリッククライアント s6BhdRkqt のリクエストで、発行したリフレッシュトークンのレコードの `cnf.jkt` が Figure 9 の値になることを、値をそのまま書いて確かめる。Figure 5 の認可コードは、Figure 6 のレスポンスと同じくリフレッシュトークンを返すよう `offline_access` を許可したものにし、Figure 7 のリフレッシュトークンは、Figure 6 で発行されたものとして同じ鍵に束縛したものにした。ほかに、デバイス認可と CIBA の dispatch にも `refreshTokenCnf` を持つ束縛が渡ること、コンフィデンシャルクライアントのリフレッシュトークンが束縛されないことを確かめる

## validateDpopGrantBinding, boundGrantRecordOf <!-- hono:oidc-provider/features/dpop/steps/validate-dpop-grant-binding.ts#validateDpopGrantBinding hono:oidc-provider/features/dpop/steps/validate-dpop-grant-binding.ts#boundGrantRecordOf nextjs:app/_oidc-provider/features/dpop/token.ts#validateDpopGrantBinding nextjs:app/_oidc-provider/features/dpop/token.ts#boundGrantRecordOf -->

提示された認可コードかリフレッシュトークンのレコードを読み、`cnf.jkt` があれば、DPoP proof が同じ鍵のものであることを確かめるステップ（Hono）とブロックの関数（Next.js）を足した。

- レコードは、リゾルバではなくストア（`authCodeStore`、`refreshTokenStore`）から読む。束縛の `cnf` はレコードに足したメンバーで、core の型（`AuthorizationCodeInfo`、`RefreshTokenInfo`）には無いので、ストアが返すレコードをそのまま見る
- 使用済みのもの、別のクライアントのもの、見つからないものは確かめず、後のグラントの検証に任せる。使用済みのコードやリフレッシュトークンの再提示では、グラントの検証がそのグラントのトークンを失効させる（OAuth 2.1 §4.1.2 / §4.3.1）ので、ここで `invalid_grant` を先に返すと、その失効が起きなくなるためである
- 拒否は 400 の `invalid_grant` にした。RFC 9449 §5 と §10 は束縛を確かめて拒否するとだけ言い、エラーコードを決めていない。DPoP proof そのものは正しく、提示したグラントがこのリクエストに使えないので、RFC 6749 §5.2 の `invalid_grant` に当たる
- `grant_type` が `authorization_code` と `refresh_token` 以外のリクエストではストアを読まない。デバイス認可や CIBA が発行するリフレッシュトークンも `refreshTokenStore` に入るので、それを提示するリフレッシュのリクエストは同じように確かめる
- テストは、束縛したコードとリフレッシュトークンを、同じ鍵の DPoP proof で使えること、DPoP proof が無い・別の鍵のときに `invalid_grant` で拒否し、コードもリフレッシュトークンも使用済みにしないこと、使用済みのものの再提示と、別のクライアントのコードとリフレッシュトークンは core の `invalid_grant`（説明の文言もそのまま書く）になること、ほかのグラントのリクエストは、束縛したコードやリフレッシュトークンを送っても確かめないこと、束縛の無いものは前と同じに使えることを確かめる

## readDpopJkt, validateDpopBoundGrant, selectDpopRefreshTokenJkt <!-- hono:oidc-provider/features/dpop/binding.ts#readDpopJkt hono:oidc-provider/features/dpop/binding.ts#validateDpopBoundGrant hono:oidc-provider/features/dpop/binding.ts#selectDpopRefreshTokenJkt nextjs:app/_oidc-provider/features/dpop/binding.ts#readDpopJkt nextjs:app/_oidc-provider/features/dpop/binding.ts#validateDpopBoundGrant nextjs:app/_oidc-provider/features/dpop/binding.ts#selectDpopRefreshTokenJkt -->

束縛の規則を集める `binding.ts` に、レコードの `cnf.jkt` を読む関数、束縛した鍵と DPoP proof の鍵を照らし合わせる関数、リフレッシュトークンを束縛する鍵を選ぶ関数を足した。

- `readDpopJkt()` は、`cnf` が無いか、`cnf.jkt` が文字列でないレコードを束縛していないものとして読む。`x5t#S256`（mTLS）など、ほかの方法の確認だけを持つレコードも、DPoP の鍵には束縛していない
- `validateDpopBoundGrant()` の失敗は `DpopError` の `invalid_grant` で、`errors.ts` のエラーコードの一覧に `invalid_grant` を足し、トークンエンドポイントだけが返すコードで、保護されたリソースのチャレンジには載せないことも書いた。`tokenEndpointErrorOf()` と `tokenEndpointRejectionOf()` は、コードによらず DPoP の失敗を 400 にするので、手を加えていない（JSDoc に `invalid_grant` を書き足しただけである）
- 説明の文言は、DPoP proof が無いときと別の鍵のときで分けた。どちらもクライアントが送った値を含まない固定の文言である
- テストは、PR #205 のテストに、`cnf` が `null` のとき、`cnf.jkt` が文字列でないときを足した
