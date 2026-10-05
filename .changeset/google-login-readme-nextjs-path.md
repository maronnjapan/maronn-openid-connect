---
---

`@maronn-openid-connect/google-login` の README で、Next.js の生成物が `GOOGLE_CLIENT_ID` / `GOOGLE_HOSTED_DOMAIN` を読む場所を `_oidc-provider/runtime.ts` から `_oidc-provider/provider.ts` に直し、Next.js の `login/google/route.ts` が失敗を OP のエラーページへのリダイレクトで表示することを追記する。README だけの変更なので、このパッケージ単独のリリースはしない（次のリリースに含まれる）。
