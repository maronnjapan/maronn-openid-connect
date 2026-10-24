---
'@maronn-openid-connect/cli': patch
---

生成 OP の画面を既定で `Cache-Control: no-store` で返し、ブラウザや中間キャッシュに保存させないようにする（RFC 9111 §5.2.2.5）

ログイン画面と同意画面の URL は、どの認可リクエストでも同じ `/login`、`/consent` であり、トランザクションは Cookie だけで識別する。保存された画面が再利用されると、別のトランザクションや別のブラウザの `csrf_token`、`login_hint`、クライアントが表示される。

- Hono / Express / Fastify：`views.tsx` の `renderView()` が、すべての画面（ログイン、同意、エラー、デバイス認可、CIBA、ログアウト）に `Cache-Control: no-store` を付ける。`RenderViewInit` に `headers` を加え、`renderView(view, { headers: { 'Cache-Control': '...' } })` で既定のヘッダーを上書きできる。`form_post` の応答は、この `headers` で従来どおり `Cache-Control: no-cache, no-store` と `Pragma: no-cache` を返す
- Next.js：Route Handler が返す画面（デバイス認可、CIBA、ログアウト、エラー）を組み立てる `_oidc-provider/html.ts` の `htmlResponse()` が `Cache-Control: no-store` を付ける。`headers` を渡せば上書きできる
- Next.js のログイン、同意、`oidc-error` の各ページは、ページからレスポンスヘッダーを設定できない。生成物のままでも、動的レンダリングのページには Next.js が `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` を付ける。ほかの画面と同じ `no-store` を明示するには、プロジェクトの `next.config.mjs` の `headers()` で指定する（設定例は README の Next.js の節を参照）

`renderLoginPage()` や `renderConsentPage()` を差し替えて独自の Response を返す場合も、`Cache-Control: no-store` を付ける。
