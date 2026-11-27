---
'@maronn-openid-connect/cli': patch
---

Next.js の生成コードの UserInfo の Route Handler（`userinfo/route.ts`）を、目印（`// [step-id] …`）の付いたステップのブロックに分ける。署名鍵を読み込む `[load-signing-keys]` はほかの Next.js の Route Handler と共通のブロックで、`[parse-access-token]`、`[resolve-access-token]`、`[resolve-claims]`、`[build-response]`、`[respond]`、`[respond-error]` は Hono の UserInfo のパイプラインと同じステップである。あわせて、ステップを並べた `userinfo/endpoint.ts` と、応答の型（`UserInfoEndpointResponse`、`UserInfoEndpointError`）を置く `userinfo/response.ts` を生成する。

署名付きの UserInfo を作っていた `signedUserInfo()` は、JSON か署名付き JWT かを決める `buildUserInfoResponse()` に入る。トークンの読み取りは `parseBearerAccessToken()`、応答は `respondUserInfo()` と `respondUserInfoError()` が受け持つ。
`userinfo/route.ts` に手を加えている場合は、生成し直したあと、その変更を新しいブロックへ移す。

UserInfo エンドポイントの応答（ステータス、ボディ、`WWW-Authenticate`、キャッシュのヘッダー）は変わらない。
