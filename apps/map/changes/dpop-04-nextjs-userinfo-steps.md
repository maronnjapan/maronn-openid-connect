# Next.js の UserInfo の Route Handler を、Hono と同じステップのブロックに分ける（DPoP の段 4）

DPoP（RFC 9449）を生成 OP に入れる段の 4 つ目で、Next.js の UserInfo の Route Handler（`userinfo/route.ts`）を、ステップの目印（`// [step-id] …`）の付いたブロックに分ける。
Hono の UserInfo はステップごとの関数に分かれているが、Next.js の Route Handler には目印が無かった。
生成器は機能のコードを目印のブロック単位でしか外せないので、後の段で DPoP の機能がここにブロックを足すには、先に本体を同じ形にそろえておく必要がある。
目印を置いた `route.ts` には、ステップを同じ順に並べた `endpoint.ts` が要る（lint が突き合わせる）ので、それも足した。
応答（ステータス、ボディ、`WWW-Authenticate`、キャッシュのヘッダー）は変えていない。
足したテスト（`userinfo/route.test.ts`）は、前の Route Handler に対しても同じように通る。

## userinfo <!-- nextjs:app/userinfo/route.ts#userinfo -->

本体を、Hono の UserInfo のパイプラインと同じステップ ID（`parse-access-token`、`resolve-access-token`、`resolve-claims`、`build-response`、`respond`、`respond-error`）と、Next.js の Route Handler に共通の `load-signing-keys` のブロックに分けた。
地図と `endpoint.ts` で、Hono と Next.js の同じステップを同じ名前で辿れるようにするためである。
core の検証関数の呼び出しは、ほかの Next.js の Route Handler と同じくブロックの中に直接残した。呼び出しを消せばその検証を外せる形を変えないためである。
トークンの読み取りを `try` の中へ移し、その失敗もほかのブロックの失敗と同じく `respond-error` のブロックで応答するようにした。前は `try` の前で直接応答していたが、応答の中身は同じである。
失敗の応答を一か所で組み立てるので、後の段で失敗の応答に付けるチャレンジを変えるときも、どのブロックの失敗にも同じように効く。

## parseBearerAccessToken <!-- nextjs:app/userinfo/route.ts#parseBearerAccessToken -->

Bearer トークンを読み取り、読み取れないときは `UserInfoEndpointError` を投げる関数にした。トークンを複数の方法で送ったとき（400 の `invalid_request`）、トークンがないとき（401、`realm` だけのチャレンジ）、ボディを読めないとき（チャレンジの付かない 400）の応答は、前の Route Handler と同じである。
Hono の `parseUserInfoRequest()` と同じ役割で、値を一つ返すので、ブロックは `const accessToken = …` の一行になる。後の段で機能のブロックがトークンを先に読むときも、この行に足すだけで済む。
読み取りそのもの（`extractAccessToken()`）は変えていない。

## buildUserInfoResponse, signedUserInfo <!-- nextjs:app/userinfo/route.ts#buildUserInfoResponse nextjs:app/userinfo/route.ts#signedUserInfo -->

前の `signedUserInfo()` と、JSON か署名付き JWT かの分岐をまとめ、HTTP のレスポンスではなく応答の内容（`UserInfoEndpointResponse`）を返す関数にした。Hono の `buildUserInfoResponse()` と同じ形で、HTTP のレスポンスにするのは `respond` のブロックに任せる。
クライアントが登録したアルゴリズムの UserInfo の鍵がないときの 500 の `server_error` も、`UserInfoEndpointError` で `respond-error` のブロックに渡す。ボディの `error_description` は前と同じである。

## respondUserInfo <!-- nextjs:app/userinfo/route.ts#respondUserInfo -->

応答の内容を、`Cache-Control: no-store` と `Pragma: no-cache` を付けた HTTP のレスポンスにする。
成功も失敗もこの関数を通るので、キャッシュさせないヘッダー（RFC 6750 §5.2、OIDC Core 1.0 §16.4）を付け忘れる応答ができない。JSON には前と同じ `noStoreJson()` を使う。

## respondUserInfoError <!-- nextjs:app/userinfo/route.ts#respondUserInfoError -->

ブロックが投げたエラーを、Hono の `respondUserInfoError()` と同じ分け方で応答にする。`UserInfoEndpointError` はブロックが決めた応答を、core の `UserInfoError` は RFC 6750 §3 の `Bearer` のチャレンジとエラーの JSON を、それ以外は 500 の `server_error` を返す。
チャレンジの文字列は前の Route Handler と同じである。次の段で、UserInfo エンドポイントが受け付ける認証スキームごとのチャレンジを、この関数で組み立てるようにする。
