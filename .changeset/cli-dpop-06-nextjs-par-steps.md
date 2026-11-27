---
'@maronn-openid-connect/cli': patch
---

Next.js の生成コードの PAR の Route Handler（`--enable par` のときの `(par)/par/route.ts`）を、目印（`// [step-id] …`）の付いたステップのブロックに分ける。ブロックは Hono の PAR のパイプラインと同じステップ（`[parse-request]`、`[authenticate-client]`、`[validate-request]`、`[store-request]`、`[respond]`、`[respond-error]`）で、ステップを並べた `(par)/par/endpoint.ts` もあわせて生成する。`[respond]` のブロックが読む値の名前は `response` から `parResponse` に変わる。
`(par)/par/route.ts` に手を加えている場合は、生成し直したあと、その変更を新しいブロックへ移す。

PAR エンドポイントの応答（ステータス、ボディ、`WWW-Authenticate`、キャッシュのヘッダー）と保存するパラメータは変わらない。
