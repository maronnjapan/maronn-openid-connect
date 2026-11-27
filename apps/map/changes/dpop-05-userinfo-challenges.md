# UserInfo エンドポイントの失敗に、受け付ける認証スキームごとのチャレンジを並べて応答する（DPoP の段 5）

DPoP（RFC 9449）を生成 OP に入れる段の 5 つ目で、UserInfo エンドポイントの失敗の `WWW-Authenticate` を、受け付ける認証スキームごとのチャレンジを並べて組み立てる形にする。
後の段で DPoP の機能が `DPoP` スキームを受け付けると、失敗の応答には `Bearer` と `DPoP` の二つのチャレンジが並ぶ。
どちらのチャレンジがエラーを伝えるかは RFC 9449 §7.2 が決めている。認証情報がなければどれも伝えず、トークンを提示したスキームが分かればそのチャレンジだけが伝え、どのスキームで提示したのか決められないとき（二つのスキームでトークンを送ったときなど）はどれも伝える。
これまでは、エラーを出すところごとに `Bearer realm="UserInfo"…` の文字列を書いていたので、スキームが増えると、その規則をすべての箇所で守らせることになる。
そこで、チャレンジの一覧とトークンを提示したスキームを最初のステップの前で宣言し、エラーを出すところは「どのチャレンジがエラーを伝えるか」だけを示して、文字列はエラーのステップが一か所で組み立てるようにした。
この段で受け付けるのは `Bearer` だけなので、どの失敗のステータス、ボディ、`WWW-Authenticate` もこれまでとバイト単位で同じである。
足したエンドポイントのテストは、前の実装に対しても同じように通る。

## handler, userinfo <!-- hono:oidc-provider/endpoints/userinfo/pipeline.ts#handler nextjs:app/userinfo/route.ts#userinfo -->

チャレンジの一覧（`challenges`）を、Hono はパイプラインの `try` の前で、Next.js は最初のブロック（`load-signing-keys`）の前で宣言し、エラーのステップに渡すようにした。
どのステップが失敗してもエラーのステップが読めるように、`try` の外に置いた。認可エンドポイントの `responseMode` と同じ置き方である。
最初は `Bearer realm="UserInfo"` のチャレンジ一つで、トークンを提示したスキームは `Bearer` である。自分のスキームを受け付ける機能のブロックが、ここにチャレンジを足し、スキームを書き換える。
`challenges` を作るステップは無いので、Hono のエンドポイントの説明では `initial` に挙げた。`--flow` でステップを並べ替えても、エラーのステップが読む値がそろっていると確かめられる。

## userInfoChallengeHeader <!-- hono:oidc-provider/endpoints/userinfo/response.ts#userInfoChallengeHeader nextjs:app/userinfo/response.ts#userInfoChallengeHeader -->

チャレンジの一覧から `WWW-Authenticate` の値を組み立てる関数を、Hono と Next.js の `response.ts` に足した。
エラーの情報は、トークンを提示したスキームのチャレンジだけに入れ、`everyScheme` のときはどのチャレンジにも入れ、`'without-error'` のときはどれにも入れない。RFC 9449 §7.2 の Figure 17〜19 の三つの場合である。
チャレンジは、RFC 9449 の例と同じく、コンマで区切って一つの `WWW-Authenticate` に並べる（RFC 9110 §11.6.1）。
`challenges.scheme` は大文字と小文字を区別して `offered` のチャレンジの `scheme` と比べるので、機能は自分が足したチャレンジの名前をそのまま書く。エラーの値は引用符の中にそのまま入れるので、RFC 6749 §5.2 で使える文字だけにする（core の `UserInfoError` の説明はそうなっている）。どちらも型の説明に書いた。
Next.js の Route Handler の中の関数はテストから呼べないので、Next.js でも `response.ts` に置いて、Figure 17〜19 の形を `response.test.ts` で確かめている。

## parseUserInfoRequest, parseBearerAccessToken <!-- hono:oidc-provider/endpoints/userinfo/steps/parse-access-token.ts#parseUserInfoRequest nextjs:app/userinfo/route.ts#parseBearerAccessToken -->

トークンがないときと、二つの方法でトークンを送ったときのエラーが、`WWW-Authenticate` の文字列の代わりに、チャレンジにどう載せるかを `UserInfoEndpointError` の二つ目の引数で示すようにした。
トークンがないときは `'without-error'` で、どのチャレンジもエラーを伝えない（RFC 6750 §3.1）。
ヘッダーとフォームのボディの二つの方法で送ったときは、どちらも Bearer の方法（RFC 6750 §2.1 / §2.2）なので、認証しようとしたスキームは `Bearer` に決まる。そこで `Bearer` のチャレンジだけに `invalid_request` を入れる（RFC 9449 §7.2 Figure 18 の規則）。ほかのスキームのチャレンジが並んでも、そこにはエラーを入れない。
どのチャレンジにもエラーを入れる `everyScheme` は、二つのスキームでトークンを送ったとき（Figure 19）のためのもので、この段の Bearer の読み取りは使わない。Hono のステップのテストで、ほかのスキームのチャレンジにエラーが入らないことを確かめている。
これまでの二つ目のチャレンジに `error_description` が無かったのに合わせて、チャレンジのエラーにも説明を付けていない。ボディの `error_description` はこれまでと同じである。
ボディを読めないときは、これまでどおりチャレンジを付けない。

## respondUserInfoError <!-- hono:oidc-provider/endpoints/userinfo/steps/respond-error.ts#respondUserInfoError nextjs:app/userinfo/route.ts#respondUserInfoError -->

チャレンジの一覧を受け取り、`WWW-Authenticate` を `userInfoChallengeHeader()` で組み立てるようにした。
`UserInfoEndpointError` は、チャレンジを求めたときだけ一覧のチャレンジを付け、レスポンスのほかのヘッダーはそのまま残す。後の段で `DPoP-Nonce` を付けるエラーも、この形で応答できる。
core の `UserInfoError`（登録されていない、期限切れ、スコープが足りないトークン）は、トークンを提示したスキームのチャレンジにエラーを入れる。フォームのボディのトークンも Bearer トークン（RFC 6750 §2.2）なので、`Bearer` のチャレンジが伝える。
ステップの名前を「受け付ける認証スキームのチャレンジで応答する」に変えた。`Bearer` のチャレンジだけを返すステップではなくなったからである。
