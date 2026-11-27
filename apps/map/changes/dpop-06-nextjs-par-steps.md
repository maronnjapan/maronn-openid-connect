# Next.js の PAR の Route Handler を、Hono と同じステップのブロックに分ける（DPoP の段 6）

DPoP（RFC 9449）を生成 OP に入れる段の 6 つ目で、Next.js の PAR の Route Handler（`(par)/par/route.ts`）を、ステップの目印（`// [step-id] …`）の付いたブロックに分ける。
Hono の PAR はステップごとの関数に分かれているが、Next.js の Route Handler には目印が無かった。
生成器は機能のコードを目印のブロック単位でしか外せないので、後の段で DPoP の機能がここにブロックを足すには（RFC 9449 §10.1 の `DPoP` ヘッダーで、プッシュした認可リクエストを鍵に束縛する）、先に本体を同じ形にそろえておく必要がある。
目印を置いた `route.ts` には、ステップを同じ順に並べた `endpoint.ts` が要る（lint が突き合わせる）ので、それも足した。
応答（ステータス、ボディ、`WWW-Authenticate`、キャッシュのヘッダー）と保存するパラメータは変えていない。
Next.js の PAR の Route Handler は e2e のテスト（`pushed-authorization-requests.spec.ts` など）でしか確かめていなかったので、vitest のテスト `(par)/par/route.test.ts` を足した。前の Route Handler に対しても同じように通る。

## pushAuthorizationRequest <!-- nextjs:app/(par)/par/route.ts#pushAuthorizationRequest -->

本体を、Hono の PAR のパイプラインと同じステップ ID とラベル（`parse-request`、`authenticate-client`、`validate-request`、`store-request`、`respond`、`respond-error`）のブロックに分けた。
地図と `endpoint.ts` で、Hono と Next.js の同じステップを同じ名前で辿れるようにするためである。
`experimental/par` の関数の呼び出しは、ほかの Next.js の Route Handler と同じくブロックの中に直接残した。呼び出しを消せばその検証を外せる形を変えないためである。
地図の要約は、関数の呼び出し、例外の捕捉、代入、`return`、条件を消したと出すが、どれも同じコードが新しいブロックの中へ入っただけで、前と同じ順に残っている。
`[respond]` のブロックが読む値の名前を `response` から `parResponse` に変えた。`endpoint.ts` の `produces` の名前を Hono の `store-request` のステップがつくる値とそろえ、後の段で生成器がブロックを外したときに残す `const <name> = undefined;` の名前を、HTTP のレスポンスと取り違えないようにするためである。
