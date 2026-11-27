# dpop_bound_access_tokens を登録したクライアントに、どのトークンリクエストにも DPoP proof を求める（DPoP の段 21）

DPoP（RFC 9449）を生成 OP に入れる段の 21 個目で、クライアントメタデータ `dpop_bound_access_tokens`（RFC 9449 §5.2）を入れる。
`true` で登録したクライアントは常に DPoP を使うので、そのクライアントの `DPoP` ヘッダーの無いトークンリクエストを拒否しなければならない（MUST）。段 20 までは、`dpop` を有効にしても、DPoP proof を送らないリクエストにはどのクライアントにも Bearer トークンを発行していた。
メタデータは `RegisteredClient.dpopBoundAccessTokens`（`features/dpop/config.ts` が足すメンバー）として登録する。RFC 9449 §5.2 は、動的クライアント登録を使わない OP でもクライアントのデータの形にこの値を持つことを想定している。段 11 で、SQL と KV のデータベースは列や項目の無いメタデータをクライアントの `payload` に保存するようになったので、メモリ、SQL、KV のどのデータベースに登録しても、データベースのコードを変えずにこの値が残る。
動的クライアント登録のクライアントは、登録したメタデータを `registrationMetadata` に `dpop_bound_access_tokens` の名前で持つので、その値も読む。ただし、動的クライアント登録がこの値を検証して登録するのは後の段で、この段では、`customClientMetadata` に検証関数を足した場合だけ登録したメタデータに残る。
`dpop_bound_access_tokens` を登録していないクライアントのリクエストと、`DPoP` ヘッダーのあるリクエストへの答えは前と同じで、地図の実 OP のケースもすべて前と同じに答えた。

## token <!-- endpoint:token nextjs:app/token/route.ts#token -->

コメントだけを変えた。動き（木）は同じである。

- `[verify-dpop-proof]` ブロックの目印の仕様の参照に `§5.2` を足した。このブロックの関数が `dpop_bound_access_tokens` の検査も行うようになったためである。Hono のステップのメタデータの `spec` も同じにした
- パイプライン（Hono）とルート（Next.js）の先頭の説明、`endpoint.ts` の説明、Next.js のルートの関数の 400 の説明に、`dpop_bound_access_tokens` を登録したクライアントの DPoP proof の無いリクエストを拒否することを書き足した。この説明は `dpop` を有効にしない生成物にも残るので、サンプルの差分はこれらの説明の文だけである
- `dpop` を有効にしない生成物では、これまでどおりブロックが消える。置き換えの定数は増えない

## verifyDpopTokenRequest <!-- hono:oidc-provider/features/dpop/steps/verify-dpop-proof.ts#verifyDpopTokenRequest nextjs:app/_oidc-provider/features/dpop/token.ts#verifyDpopTokenRequest -->

`DPoP` ヘッダーを読んだ直後に、`dpop_bound_access_tokens` を登録したクライアントのリクエストに DPoP proof があることを確かめるようにした。PR #205 の同じ関数と同じ位置である。

- このステップは、クライアントの認証の直後、グラントの dispatch と検証より前に実行する。ここで確かめるので、機能が答えるグラント（client_credentials、デバイス認可、CIBA、トークン交換、ID-JAG）を含むどのグラントのトークンリクエストも拒否される。RFC 9449 §5.2 はグラントを限らずに「トークンリクエスト」と言うためである。拒否したリクエストでは、認可コードを使用済みにせず、リフレッシュトークンもローテーションしない
- クライアントの認証の後に確かめるので、認証に失敗したリクエストは、これまでどおり 401 の `invalid_client` になる。どのクライアントのリクエストかは、認証してはじめて決まる
- 拒否は、DPoP proof の検査の失敗と同じく、キャッシュさせない 400 の `invalid_dpop_proof` である（下の `requireDpopProofForClient()` を参照）
- `DPoP` ヘッダーがあるときは何も変わらない。DPoP proof の検査と、トークンの鍵への束縛はこれまでどおりである
- テストは、`dpopBoundAccessTokens: true` のクライアントの認可コード、リフレッシュトークン、client_credentials の各リクエストが、DPoP proof が無ければ 400 の `invalid_dpop_proof` になり、どのグラントのステップ（ブロック）も呼ばれず、認可コードもリフレッシュトークンも使用済みにならないこと、DPoP proof があれば DPoP のアクセストークンになることを確かめる。`false` で登録したクライアントには DPoP proof が無くても Bearer トークンを発行すること、動的クライアント登録の形（`registrationMetadata`）で登録したクライアントも拒否することも確かめる。SQL と KV のデータベースは、登録したクライアントの `payload` に `{"dpopBoundAccessTokens":true}` が入ることを値をそのまま書いて確かめ、そのクライアントのリクエストを DPoP proof の有無で答え分けることを確かめる（Next.js のルートは KV のデータベースを読むので、SQL はクライアントのリゾルバを SQL のものに差し替えて確かめる）

## dpopBoundAccessTokensOf <!-- hono:oidc-provider/features/dpop/binding.ts#dpopBoundAccessTokensOf nextjs:app/_oidc-provider/features/dpop/binding.ts#dpopBoundAccessTokensOf -->

クライアントが `dpop_bound_access_tokens` を登録しているかを返す関数を `binding.ts` に足した。PR #205 はステップの中で `dpopBoundAccessTokens` だけを読んでいた。

- 静的に登録したクライアントは `dpopBoundAccessTokens` を、動的クライアント登録のクライアントは `registrationMetadata.dpop_bound_access_tokens` を読み、どちらかが `true` なら `true` を返す。動的クライアント登録は、登録したメタデータを登録レスポンスと同じ名前のまま `registrationMetadata` に入れ、`RegisteredClient` の個別のメンバーにはしないためである
- `registrationMetadata` は動的クライアント登録の機能が `RegisteredClient` に足すメンバーである。DPoP の機能はその機能を前提にしない（`requires` が空）ので、型を取り込まずに名前で読む。動的クライアント登録を有効にしない生成物では、このメンバーは無く、`false` の側に倒れる
- 真偽値の `true` だけを数える。SQL と KV の `payload` は JSON をそのまま返し、`registrationMetadata` も登録の値をそのまま持つので、文字列の `"true"` のような値が入り得る。省略したときの既定値は `false`（RFC 9449 §5.2）で、`true` でない値はすべて既定値として扱う
- テストは、二つのメンバーのそれぞれが `true` のときに `true`、省略、`false`、文字列の `"true"`、`registrationMetadata` に値が無いときに `false` を返すことを確かめる

## requireDpopProofForClient <!-- hono:oidc-provider/features/dpop/binding.ts#requireDpopProofForClient nextjs:app/_oidc-provider/features/dpop/binding.ts#requireDpopProofForClient -->

`dpop_bound_access_tokens` を登録したクライアントのリクエストに DPoP proof が無ければ、`DpopError` を投げる関数を `binding.ts` に足した。PR #205 の同じ関数をもとにした。

- エラーコードは `invalid_dpop_proof` にした。RFC 9449 §5.2 は拒否するとだけ言い、コードを決めていない。`invalid_request` も考えられるが、DPoP を常に使うと登録したクライアントに、足りないのが DPoP proof だと伝えるコードとして、DPoP proof の失敗の `invalid_dpop_proof`（RFC 9449 §5）を選んだ。PR #205 と同じ選択で、トークンエンドポイントの `tokenEndpointErrorOf()` / `tokenEndpointRejectionOf()` がそのまま 400 にする。`errors.ts` の `invalid_dpop_proof` の説明に、この使い方を書き足した（コードの一覧は変えていない）
- 説明の文言は `This client must send a DPoP proof with every token request` の固定の文言で、クライアントが送った値を含まない
- テストは、DPoP proof の無いリクエストだけを `invalid_dpop_proof` で拒否し、DPoP proof のあるリクエストと、`dpop_bound_access_tokens` を登録していないクライアントのリクエストを通すことを確かめる
