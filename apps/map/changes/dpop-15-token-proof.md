# トークンエンドポイントが DPoP proof を検査し、アクセストークンをその鍵に束縛する（DPoP の段 15）

DPoP（RFC 9449）を生成 OP に入れる段の 15 個目で、`dpop` の機能を初めてエンドポイントにつなぐ。
トークンエンドポイントは、クライアントの認証の直後の `[verify-dpop-proof]` ブロックで `DPoP` ヘッダーの DPoP proof を検査し（段 13 の `verifyDpopRequestProof()`。`htm` は POST、`htu` は issuer の `/token`）、アクセストークンをその鍵に束縛する `tokenBinding`（段 7 の `TokenBinding`。`cnf.jkt` と `token_type` の `DPoP`）を決める。
`tokenBinding` は、段 7 と段 8 で束縛を受け取れるようにしたステップと dispatch のすべてに渡すので、認可コード、リフレッシュトークン、機能が答えるグラント（client_credentials、トークン交換、ID-JAG の引き換え、デバイス認可、CIBA）のどれでも、アクセストークンが DPoP proof の鍵に束縛される。RFC 9449 §5 が、グラントの種類によらず束縛するとしているためである。
`DPoP` ヘッダーの無いリクエストでは `tokenBinding` が `undefined` のままで、発行するトークンとレスポンスは前と同じ Bearer である。`dpop` を有効にしない生成物では、ブロックの代わりに `const tokenBinding = undefined;` が入る（サンプルもこの形になる）。
ディスカバリーは、段 14 で見送った `dpop_signing_alg_values_supported`（§5.1）をこの段から返す（`feature.ts` の `discovery` のフック）。この項目は DPoP への対応を告げるので、DPoP proof を検査するエンドポイントができたこの段で返し始める。返すのは設定の alg のうち検査が検証できるもの（`dpopSigningAlgsOf()`）で、一つも無ければ項目ごと返さない。空の配列では、使える alg の無い対応を告げることになるためである。
CLI の `--help`、`generate` と `setup` が出す拡張機能の案内、機能の一覧の説明も、この段の振る舞いに合わせて書き直した。
この段では、パブリッククライアントのリフレッシュトークンを鍵に束縛せず、束縛した認可コードとリフレッシュトークンの鍵も照らし合わせない（段 16）。UserInfo エンドポイントの DPoP（段 17、18）、`dpop_bound_access_tokens`（段 21）、サーバーが発行する nonce（段 23〜25）も後の段である。それまで、UserInfo エンドポイントは束縛したアクセストークンも Bearer として受け付ける。

## token <!-- endpoint:token nextjs:app/token/route.ts#token -->

DPoP proof を検査するブロックを、クライアントの認証の後、機能が答えるグラントの dispatch より前に置き、その `tokenBinding` をトークンを発行するすべてのステップに渡した。

- dispatch より前なのは、自分で応答まで行う dispatch にも束縛を渡すためである。dispatch はどれも、自分の答えないグラントでは何もせずに次へ進むので、どのグラントのリクエストも、標準のグラントに着くまでにすべての dispatch を通る
- 認証の後なのは、認証に失敗したリクエストの DPoP proof を検査せず、その `jti` も覚えないためである。認証の失敗（401 の `invalid_client`）は、DPoP proof の失敗より先に答える
- ID-JAG を発行するトークン交換（`[dispatch-id-jag-issuance]`）には渡さない。ID-JAG はアクセストークンではなく、RFC 9449 の束縛の対象ではないためである（段 8 と同じ判断）
- Next.js は、段 7 で手を付けずにおいたルートの中のアクセストークンの発行（ペイロード、保存するレコード、`token_type`）を、`token-binding.ts` の `accessTokenClaimsOf()`、`accessTokenRecordOf()`、`tokenTypeOf()` で `tokenBinding` に従わせた。Hono は段 7 でステップに入れてある。`tokenBinding` が無ければ三つとも何も加えず `Bearer` を返すので、ペイロードとレコードのメンバーとその順番、レスポンスは前と同じである
- Next.js のブロックは、DPoP proof を受け付けないとき、ルートが返すだけのレスポンス（`dpopRejection`）を受け取る。ルートの `catch` は core の `TokenError` だけを見分けるので、機能のエラーの型をルートに持ち込まないためである
- リフレッシュトークンの発行にも `tokenBinding` を渡すが、この段の束縛は `refreshTokenCnf` を持たないので、リフレッシュトークンは束縛しない
- テストは、RFC 9449 の Figure 5（認可コード）と Figure 7（リフレッシュトークン）のリクエストをそのまま送り、アクセストークンの `cnf.jkt` と保存したレコードが Figure 9 の値になることを確かめる。ほかに、機能が答えるグラントのどの dispatch にも束縛が渡ること（ID-JAG の発行には渡らないこと）、`DPoP` ヘッダーの無いリクエストが前と同じ Bearer のトークンを受け取ること、DPoP proof を拒否したリクエストの認可コードとリフレッシュトークンが使われずに残ること、認証に失敗したリクエストに付いた正しい DPoP proof の `jti` を覚えず、同じ proof を正しい認証で送り直せること、発行したトークンをイントロスペクションが `cnf` と `DPoP` で報告することを確かめる。`DPoP` ヘッダーを持たない地図の実 OP のケースは、すべて前と同じに答えた

## verifyDpopTokenRequest <!-- hono:oidc-provider/features/dpop/steps/verify-dpop-proof.ts#verifyDpopTokenRequest nextjs:app/_oidc-provider/features/dpop/token.ts#verifyDpopTokenRequest -->

`DPoP` ヘッダーを一つだけ読み（`readDpopProofHeader()`）、DPoP proof を検査して、その鍵の JWK Thumbprint を `cnf.jkt` にした束縛を返すようにした。

- PR #205 のこの関数は、クライアントを読み、`dpop_bound_access_tokens`（§5.2）のクライアントに DPoP proof を求め、パブリッククライアントのリフレッシュトークンも束縛していた。どちらも後の段（21 と 16）に分けたので、この段の関数はクライアントを読まず、ステップの入力も無い。Hono のステップは `after: ['authenticate-client']` で、クライアントの認証の後に置く
- リフレッシュトークンの束縛を段 16 に回したのは、束縛したリフレッシュトークンを提示されたときの照合と同じ段で入れ、束縛したのに照らし合わせない状態のリリースを作らないためである
- DPoP の検査の失敗（`DpopError`）だけを 400 の `invalid_dpop_proof` にする。設定の `dpopProofMaxAgeSeconds` か `dpopProofLeewaySeconds` が 0 以上の有限の数でないとき（段 13 の検査が投げる `Error`）はそのまま投げ、500 の `server_error` で答える。DPoP proof の不備ではなく設定の誤りなので、クライアントに proof を作り直させても直らないためである

## tokenEndpointErrorOf, tokenEndpointRejectionOf <!-- hono:oidc-provider/features/dpop/error-responses.ts#tokenEndpointErrorOf nextjs:app/_oidc-provider/features/dpop/error-responses.ts#tokenEndpointRejectionOf -->

DPoP の検査の失敗を、トークンエンドポイントの 400 の OAuth のエラーレスポンス（RFC 9449 §5、RFC 6749 §5.2）にする関数を足した。

- Hono はステップが投げる `TokenEndpointError` を返し、`respondTokenError()` がそれをキャッシュさせないレスポンスにする。Next.js は `oauthError()` でキャッシュさせないレスポンスを返す
- この段で答えるコードは `invalid_dpop_proof` だけである。後の段で足すコード（段 16 の `invalid_grant` など）も同じ関数で 400 にする
- `errors.ts` と別のファイルにしたのは、Next.js では `http.ts` を読み込むためである。`errors.ts` は機能の一覧と一緒に読み込まれ（`config.ts` が `jwk.ts` を読み、`jwk.ts` が `DpopError` を投げる）、`http.ts` は読み込まれるときに機能の一覧を読むので、`errors.ts` から `http.ts` を読むと循環する。Hono も同じ形にそろえた

## buildDpopConfirmation <!-- hono:oidc-provider/features/dpop/binding.ts#buildDpopConfirmation nextjs:app/_oidc-provider/features/dpop/binding.ts#buildDpopConfirmation -->

DPoP proof の鍵の JWK Thumbprint から、トークンの `cnf`（`{ jkt }`、RFC 9449 §6.1）を作る関数を足した。

- 束縛の規則を集める `binding.ts` に置いた。後の段で、リフレッシュトークンの束縛や、束縛した認可コードの照合の規則もここに足す
- `token_type` の `DPoP` は、段 9 で base の `token-binding.ts` に置いた `DPOP_TOKEN_TYPE` を使う（PR #205 はこのファイルにもう一つ持っていた）
- テストは、トークンエンドポイントのテストが、RFC 9449 Figure 9 の `jkt` をそのまま書いて確かめる
