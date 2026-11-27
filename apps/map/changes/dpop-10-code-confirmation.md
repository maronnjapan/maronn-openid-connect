# 認可リクエストを束縛した鍵の確認を、認可コードに引き継ぐようにする（DPoP の段 10）

DPoP（RFC 9449）を生成 OP に入れる段の 10 個目で、認可リクエストを鍵に束縛したとき、その確認（`cnf`）を認可トランザクションから、そこから発行する認可コードのレコードへ引き継ぐようにする。
RFC 9449 §10 は、クライアントが認可リクエストの `dpop_jkt` で DPoP の鍵の JWK SHA-256 Thumbprint を伝えたとき、認可サーバーはトークンリクエストの DPoP proof の鍵がその値と一致することを確かめ、一致しなければ拒否しなければならない（MUST）としている。
`dpop_jkt` を受け取るのは認可エンドポイントで、認可コードを発行するのはログインと同意の画面を経たあと（同意エンドポイント）か、画面の要らないリクエスト（`prompt=none` か同意済みの SSO）の認可エンドポイントなので、束縛した鍵はトランザクションに入れ、認可コードを発行するすべての場所でそのレコードへ移す必要がある。
この段では、その移す処理と、Hono のトランザクションを作るステップが束縛を受け取る入力を足す。
`dpop_jkt` を読んでトランザクションを束縛するブロックは段 19 で、トークンエンドポイントで認可コードの `cnf` を確かめる処理は段 16 で加える。
今はどのブロックもトランザクションを束縛しないので、トランザクションと認可コードのレコードは前と変わらない。

## confirmationRecordOf <!-- hono:oidc-provider/token-binding.ts#confirmationRecordOf nextjs:app/_oidc-provider/token-binding.ts#confirmationRecordOf -->

レコードの `cnf` を、別のレコードへ展開できる形（`{ cnf }` か空のオブジェクト）で返す関数を、段 7 の `token-binding.ts` に足した（Hono と Next.js で同じ中身）。
`cnf` の形は段 9 の `confirmationOf()` で確かめる。トランザクションはストアから読み戻した値で、独自のコードが書いたものもあるので、JSON のオブジェクトでない `cnf` は引き継がない。
`cnf` の無いレコードには空のオブジェクトを返すので、認可コードのレコードに展開しても何も加わらず、束縛の無いリクエストの認可コードは前と同じメンバーのままになる。
モジュールの冒頭のコメントと `confirmationOf()` の JSDoc にも、`dpop_jkt` の鍵をトランザクションから認可コードへ引き継ぐことを書き足した。

## createAuthorizationTransaction <!-- hono:oidc-provider/endpoints/authorize/steps/create-transaction.ts#createAuthorizationTransaction -->

省略できる 4 つ目の入力 `codeConfirmation` を足し、渡されたときはそれを `cnf` としてトランザクションに入れるようにした。
ステップのメタデータでは `codeConfirmation` を省略できる入力（`optional`）にした。段 19 の dpop のステップ `validate-dpop-jkt` がこれを作り、パイプラインがこのステップに渡す。
それまでは作るステップが無く、生成器は作り手の無い省略できる入力を流れから外すので、流れのデータとサンプルの生成物の流れは変わらない。
返すトランザクションにも保存するトランザクションにも `cnf` を入れるのは、画面の要らないリクエストでは返したトランザクションから、同意の画面を経るリクエストでは保存したトランザクションから認可コードを発行するためである。

Next.js では、トランザクションを作るのは `authorize/route.ts` の `[create-transaction]` のブロックの中のコードなので、`cnf` を入れるコードは、それが読む変数を作る dpop のブロックと一緒に段 19 で加える。

## issueAuthorizationCodeResponse, issueAuthorizationResponse <!-- hono:oidc-provider/endpoints/authorize/steps/issue-authorization-code.ts#issueAuthorizationCodeResponse nextjs:app/authorize/route.ts#issueAuthorizationResponse -->

画面の要らないリクエストに認可コードを発行するとき、トランザクションの `cnf` を `confirmationRecordOf()` で認可コードのレコードに入れるようにした。
core の `createAuthorizationCode()` は、認可レスポンスのパラメータのうち決まったメンバーだけを認可コードに写すので、トランザクションに `cnf` があっても、何もしなければ認可コードには移らない。
`cnf` は保存するレコードにだけ入れ、認可レスポンスにも、返す `authCodeData` にも入れない。トークンエンドポイントが読むのは保存したレコードだからである。

- Next.js の Route Handler にはテストが無かったので、`authorize/route.test.ts` を足した。同意済みのエンドユーザーの SSO で、保存した認可コードが前と同じメンバーであることと、`cnf` を持つトランザクションの `cnf` が認可コードに入ることを確かめる
- Next.js の route.ts では、トランザクションを束縛する dpop のブロックがまだ無いので、後者のテストは、core の `createAuthTransaction()` を包み、返すトランザクションに `cnf` を足してそのブロックの代わりにした。確かめるのは、この Route Handler の認可コードの発行だけである

## issueConsentedAuthorizationCode, POST <!-- hono:oidc-provider/endpoints/consent/steps/issue-authorization-code.ts#issueConsentedAuthorizationCode nextjs:app/consent/decision/route.ts#POST -->

同意の画面で承認されたリクエストに認可コードを発行するとき、トランザクションの `cnf` を認可コードのレコードに入れるようにした。理由は画面の要らないリクエストのときと同じである。
同意エンドポイントが使うトランザクションはストアから読み戻したものなので、`cnf` はストアを通って届く。
memory、SQL、KV のストアは、型に定義されていないトランザクションと認可コードのメンバーも捨てずに保存する（SQL と KV は `payload` に入れる）。SQL と KV のストアのテストに、`cnf` を持つトランザクションと認可コード（消費したあとも含む）がそのまま読み戻せることを足した。
Next.js の `consent/decision/route.test.ts` には、`cnf` を持つトランザクションと持たないトランザクションを承認して、保存した認可コードを確かめるテストを足した。

## issueHybridTokens <!-- hono:oidc-provider/features/hybrid-flow/tokens.ts#issueHybridTokens nextjs:app/_oidc-provider/features/hybrid-flow/tokens.ts#issueHybridTokens -->

ハイブリッドフローの認可コードにも同じ `cnf` を入れられるように、入力に `codeConfirmation` を足し、渡されたときはそれを `cnf` として認可コードのレコードに入れるようにした。
この関数は完了したトランザクションではなく認可レスポンスのパラメータを受け取るので、呼び出し側がトランザクションから `confirmationOf()` で読んだ値を渡す。
認可エンドポイントが一緒に返すアクセストークンと ID トークンは、フロントチャネルで返すトークンなので束縛しない。DPoP の proof はトークンエンドポイントへのリクエストに付くもので、認可エンドポイントへのブラウザのリダイレクトには付かないためである。

## issueHybridConsentResponse, issueHybridResponse <!-- hono:oidc-provider/features/hybrid-flow/steps/issue-hybrid-response.ts#issueHybridConsentResponse nextjs:app/_oidc-provider/features/hybrid-flow/consent.ts#issueHybridConsentResponse nextjs:app/_oidc-provider/features/hybrid-flow/authorize.ts#issueHybridResponse -->

ハイブリッドフローのリクエストに認可コードを発行するとき、トランザクションの `cnf` を `issueHybridTokens()` に渡すようにした。
同意エンドポイントの `issueHybridConsentResponse()`（Hono と Next.js）と、Next.js の認可エンドポイントの `issueHybridResponse()` を変えた。
Hono の認可エンドポイントでは、`features/hybrid-flow/response-type.ts` の `hybridResponseTypeHandler` が同じ値を渡す。オブジェクトのメソッドなので関数の一覧には出ないが、`response-type.test.ts` に `cnf` を持つトランザクションと持たないトランザクションのテストを足した。
