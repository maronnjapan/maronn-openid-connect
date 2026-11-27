# 認可リクエストの dpop_jkt で、認可コードを DPoP の鍵に束縛する（DPoP の段 19）

DPoP（RFC 9449）を生成 OP に入れる段の 19 個目で、認可エンドポイントが認可リクエストの `dpop_jkt`（DPoP の鍵の JWK Thumbprint、RFC 9449 §10）を読むようにする。
新しい `[validate-dpop-jkt]` ブロックが `dpop_jkt` を確かめ、その確認 `{ jkt }` をトランザクションの `cnf` に入れる。トランザクションから認可コードへ `cnf` を引き継ぐのは段 10 で、トークンエンドポイントで認可コードの `cnf.jkt` と DPoP proof の鍵を照らし合わせるのは段 16 なので、この段でその鍵が実際に入り、RFC 9449 §10 の MUST（鍵が一致しないトークンリクエストを拒否する）が満たされる。
`dpop_jkt` は、クエリ（`POST` ではボディ）、検証した Request Object、PAR でプッシュしたパラメータのどれから来てもよい。PAR の `DPoP` ヘッダーの鍵を `dpop_jkt` として扱うこと（RFC 9449 §10.1 のもう一つの方法）は段 20 である。
`dpop_jkt` の無い認可リクエストへの答えは前と同じで、地図の実 OP のケースもすべて前と同じに答えた。`dpop` を有効にしない生成物ではブロックが消え、トランザクションも前と同じメンバーのまま作る。

## processAuthorizationRequest, authorize <!-- hono:oidc-provider/endpoints/authorize/pipeline.ts#processAuthorizationRequest nextjs:app/authorize/route.ts#authorize -->

リクエストを検証するブロック（インプリシットフローとハイブリッドフローの検証を含む）の後、トランザクションを作るブロックの前に `[validate-dpop-jkt]` ブロックを足し、その結果（`codeConfirmation`）をトランザクションの `cnf` にした。

- 検証の後に置いたのは、`redirect_uri` と `state` がそこで確かになり、形の正しくない `dpop_jkt` を、リクエストが求めたレスポンスモードのエラーの認可レスポンス（`invalid_request`）でクライアントへ返せるためである
- トランザクションを作る前に置いたのは、ログイン画面と同意画面を通る間もトランザクションが `cnf` を持ち続け、そこから発行するすべての認可コード（SSO、同意、ハイブリッドフロー）が段 10 のとおり同じ `cnf` を引き継ぐためである
- ブロックに渡すパラメータは、ほかの機能のブロックと同じ `effectiveParams ?? params`（Next.js は `requestParams`）である。PAR の `request_uri` を展開した後の値なので、PAR のボディで送った `dpop_jkt` もここで読む
- Hono のパイプラインは、段 10 で作った `createAuthorizationTransaction()` の 4 番目の引数に `codeConfirmation` を渡す。Next.js のルートは、`createAuthTransaction()` が作るトランザクションに `confirmationRecordOf({ cnf: codeConfirmation })` を重ねる（段 10 で残した、トランザクション側の差分）
- `dpop` を有効にしない生成物では、ブロックが `const codeConfirmation = undefined;` に置き換わる。`confirmationRecordOf({ cnf: undefined })` は `{}` を返すので、トランザクションのメンバーは前と変わらない（サンプルの差分は、この置き換えと、それを渡す引数、Next.js ではトランザクションに重ねる行とそのコメントである）
- テストは、`dpop_jkt` を付けた認可リクエストのトランザクションが `cnf` を持つこと、`dpop_jkt` の無い・値の空のリクエストのトランザクションが `cnf` を持たないこと、SSO で発行した認可コードと、そのトランザクションから同意画面が発行した認可コードが `cnf` を持つこと、PAR のボディの `dpop_jkt` で束縛されること、形の正しくない `dpop_jkt` には `state` と `iss` を付けた `invalid_request` でリダイレクトし、トランザクションを保存しないことを確かめる。さらに、RFC 9449 Figure 5 のパブリッククライアント s6BhdRkqt で `dpop_jkt` に Figure 9 の JWK Thumbprint を入れた認可リクエストから認可コードを得て、DPoP proof の無い交換と別の鍵の交換が `invalid_grant` になり、Figure 5 の DPoP proof の交換だけが `token_type` `DPoP` のアクセストークンになることを、値をそのまま書いて確かめる

## validateDpopJktParameter <!-- hono:oidc-provider/features/dpop/steps/validate-dpop-jkt.ts#validateDpopJktParameter nextjs:app/_oidc-provider/features/dpop/authorize.ts#validateDpopJktParameter -->

認可リクエストの `dpop_jkt` を確かめ、認可コードを束縛する鍵の確認を返すステップ（Hono）とブロックの関数（Next.js）を足した。PR #205 の同じ関数をもとにした。

- 検証した Request Object に `dpop_jkt` のクレームがあれば、クエリの値より優先する（OIDC Core 1.0 §6.1）。core の `mergeRequestObjectParams()` が Request Object のクレームで上書きするのは決まった名前のパラメータだけで、`dpop_jkt` は含まないので、Request Object のクレーム（`requestObjectClaims`）から直接読む
- Request Object にクレームが無ければクエリの値を使う。ほかのパラメータと同じく、OIDC Core 1.0 §6.1 のクエリと Request Object を合わせる読み方に合わせた
- 形の正しくない値の `DpopError`（`invalid_request`）を、検証済みの `redirect_uri` と `state` を持つ `AuthorizationError` に変えて投げる。認可エンドポイントのエラーの扱い（`authorizationErrorOutcome()`、Next.js の `[respond-error]`）が、ほかの検証の失敗と同じくクライアントへのリダイレクトで返す
- Hono の関数は検証済みのリクエストを、Next.js の関数は `{ redirectUri, state }` を受け取る。どちらも、そのルートで `redirect_uri` と `state` を持つ値をそのまま渡すためで、確かめる中身は同じである
- `DPOP_ERROR_CODES` の `invalid_request` の説明に、認可エンドポイントがこのコードをエラーの認可レスポンスで返すことを足した（`errors.ts`。コードの一覧は変えていない）
- テストは、クエリと Request Object のどちらから読むか、どちらが優先するか、形の正しくない値と文字列でない Request Object のクレームが、`redirect_uri` と `state` を持つ `invalid_request` の `AuthorizationError` になることを確かめる。署名した Request Object の `dpop_jkt` がクエリの別の値より優先することは、認可エンドポイントを通して確かめる

## parseDpopJkt <!-- hono:oidc-provider/features/dpop/binding.ts#parseDpopJkt nextjs:app/_oidc-provider/features/dpop/binding.ts#parseDpopJkt -->

`dpop_jkt` の値を JWK Thumbprint として確かめる関数を `binding.ts` に足した。PR #205 の同じ関数から、二つの点を変えた。

- 空の値は、値の無いパラメータとして省略と同じに扱う（RFC 6749 §3.1 の MUST）。PR #205 は空の値を `invalid_request` で拒否していた。core の `acr_values` の扱いと同じにした
- JWK Thumbprint の形は、正規の base64url（段 12 の `decodeBase64Url()`）で 32 バイト（SHA-256）に戻る 43 文字とした。PR #205 は文字の種類と長さだけを見ていたので、末尾の文字の余りのビットが 0 でない値を通していた。そうした値は、トークンリクエストの DPoP proof の鍵から計算する JWK Thumbprint（正規の符号）と一致することがなく、束縛した認可コードが使えなくなるだけなので、認可エンドポイントで拒否する
- 失敗はすべて `invalid_request` の固定の説明（`dpop_jkt must be a base64url SHA-256 JWK Thumbprint`）にし、送られた値を説明に含めない
- テストは、JWK Thumbprint をそのまま返すこと、値の無い・空の値に `undefined` を返すこと、base64url でない値、長さの違う値、パディング付きの値、base64 の文字の値、正規でない末尾の文字の値、前に空白のある値、数値、`null`、オブジェクトを `invalid_request` で拒否することを確かめる
