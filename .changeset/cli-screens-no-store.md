---
'@maronn-openid-connect/cli': patch
---

生成 OP の画面に `Cache-Control: no-store` を付け、ブラウザや中間キャッシュが画面を保存しないようにする（RFC 9111 §5.2.2.5）

ログイン画面と同意画面の URL は、どの認可リクエストでも同じ `/login`、`/consent` であり、トランザクションは Cookie だけで識別する。保存された画面が再利用されると、別のトランザクションや別のブラウザの `csrf_token`、`login_hint`、クライアントが表示される。

- Hono / Express / Fastify：`views.tsx` の `renderView()` が返すすべての画面（ログイン、同意、エラー、デバイス認可、CIBA、ログアウト）に `Cache-Control: no-store` を付ける。`form_post` の応答は従来どおり `Cache-Control: no-cache, no-store` と `Pragma: no-cache` を返す
- Next.js：Route Handler が返す画面（デバイス認可、CIBA、ログアウト、エラー）を組み立てる `_oidc-provider/html.ts` の `htmlResponse()` が `Cache-Control: no-store` を付ける。ログイン画面と同意画面は動的レンダリングの React ページなので、これまでどおり Next.js 自身が `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` を返す

`renderLoginPage()` や `renderConsentPage()` を差し替えて独自の Response を返す場合は、同じく `Cache-Control: no-store` を付ける。
