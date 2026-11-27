---
'@maronn-openid-connect/cli': patch
---

Next.js の生成コードの UserInfo の Route Handler（`userinfo/route.ts`）を、Hono のパイプラインと同じステップのブロック（`// [load-signing-keys]`、`[parse-access-token]`、`[resolve-access-token]`、`[resolve-claims]`、`[build-response]`、`[respond]`、`[respond-error]` の目印）に分ける。あわせて、ステップを並べた `userinfo/endpoint.ts` と、応答の型（`UserInfoEndpointResponse`、`UserInfoEndpointError`）を置く `userinfo/response.ts` を生成する。

署名付きの UserInfo を作っていた `signedUserInfo()` は、JSON か署名付き JWT かを決める `buildUserInfoResponse()` に入る。トークンの読み取りは `parseBearerAccessToken()`、応答は `respondUserInfo()` と `respondUserInfoError()` が受け持つ。

UserInfo エンドポイントの応答（ステータス、ボディ、`WWW-Authenticate`、キャッシュのヘッダー）は変わらない。
