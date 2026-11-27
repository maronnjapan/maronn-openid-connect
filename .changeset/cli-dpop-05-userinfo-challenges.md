---
'@maronn-openid-connect/cli': patch
---

生成コードの UserInfo エンドポイントが、失敗の `WWW-Authenticate` を、受け付ける認証スキームごとのチャレンジを並べて組み立てるようにする。Hono（Express、Fastify を含む）と Next.js の両方が同じ形になる。

- `userinfo/response.ts` に、チャレンジの型（`UserInfoChallenge`、`UserInfoChallenges`、`UserInfoChallengeError`）、`Bearer realm="UserInfo"` の `BEARER_CHALLENGE`、値を組み立てる `userInfoChallengeHeader()` を足す。
- パイプライン（Next.js では `userinfo()`）は、最初のステップの前でチャレンジの一覧 `challenges` を宣言し、`respondUserInfoError()` に渡す。自分のスキームを受け付ける処理は、この一覧にチャレンジを足せる。
- エラーの情報は、トークンを提示したスキームのチャレンジだけが伝える。トークンがないときはどのチャレンジも伝えず、複数の方法でトークンを送ったときはどのチャレンジも伝える（RFC 9449 §7.2）。
- `UserInfoEndpointError` は、`WWW-Authenticate` の文字列の代わりに、チャレンジにどう載せるか（`'without-error'` か、エラーの情報）を二つ目の引数で受け取る。`respondUserInfoError()` は三つ目（Next.js では二つ目）の引数に `challenges` を取る。
- ステップ `respond-error` の名前（Hono のステップの説明と Next.js の目印）は「受け付ける認証スキームのチャレンジで応答する」になる。

受け付けるのは今は `Bearer` だけなので、UserInfo エンドポイントの応答（ステータス、ボディ、`WWW-Authenticate`、キャッシュのヘッダー）は変わらない。
二つ目の引数を渡さない `UserInfoEndpointError` は、これまでどおりレスポンスのヘッダーのまま応答するので、`WWW-Authenticate` を直接書いた独自のエラーはそのまま動く。受け付けるスキームのチャレンジを並べたいときは、二つ目の引数に移す。
