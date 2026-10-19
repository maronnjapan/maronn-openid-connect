---
'@maronn-openid-connect/cli': minor
---

`response_mode=form_post`（OAuth 2.0 Form Post Response Mode）に対応する安定機能 `form-post-response-mode` を追加する

既定で生成され、`--disable form-post-response-mode` で外せる。

- `response_mode=form_post` の認可リクエストには、認可エンドポイントと同意画面が、リダイレクト URI を `action` とする HTML フォームで認可レスポンスを返し、ブラウザがそれを POST する（Form Post Response Mode §2）。認可コードの応答も、リダイレクト可能なエラー（`access_denied`、`login_required` など）も同じ形で返し、`iss`（RFC 9207 §2）もフィールドに含める。応答には `Cache-Control: no-cache, no-store` と `Pragma: no-cache` を付ける
- `response_mode` は Request Object の中にあっても読む。`form_post` 以外の値は今まで通り無視し、クエリで返す（JARM の `query.jwt` / `jwt` は JARM が受け持つ）
- discovery の `response_modes_supported` は `["query", "form_post"]` になる（JARM を有効にすると `["query", "form_post", "query.jwt", "jwt"]`）
- フォームの画面は hono / express / fastify では `views.tsx` の `formPostPage`（`views` オプションで差し替えられる）、Next.js では `_oidc-provider/html.ts` の `formPostPage()` が描く

## 破壊的変更

- **既定の挙動**：`response_mode=form_post` を送るクライアントへの応答が、クエリ付きのリダイレクトから、フォームの POST に変わる。以前の挙動のままにするには `--disable form-post-response-mode` で生成する
- **認可レスポンスの型**：`endpoints/authorize/response-mode.ts`（Next.js は `authorize/response-mode.ts`）の `AuthorizationResponseMode` は、リダイレクト URL を返す `redirect()` の代わりに、リダイレクトかフォームの POST かを表す `AuthorizationResponse` を返す `respond()` を持つ。認可エンドポイントの結果（`AuthorizationOutcome`）と同意の結果（`ConsentOutcome`）の `authorization_response` は、`location` の代わりに `response` を持つ。`outcome.ts` の `buildErrorRedirect()` / `buildSuccessRedirect()` は `buildErrorResponse()` / `buildSuccessResponse()` になり、Next.js の `authorizationResponseUrl()` は `authorizationResponseOf()` になった。自前の応答モードを書いている場合は、`respond()` から `{ method: 'redirect', location }` を返すように直す
- **`Views`**：`views.tsx` の `Views` に `formPostPage` が加わった。`views` オプションは既定の画面と合わせて使うので、渡しているオブジェクトはそのままでよい
- **Next.js の同意の判断**：`consent/actions.ts`（Server Action）は無くなり、同意画面のフォームは Route Handler の `consent/decision/route.ts`（`POST /consent/decision`）へ送る。`form_post` の認可レスポンスは HTML のページで、Server Action はリダイレクトしか返せないためである。トランザクションが見つからない同意の POST は、`not-found.tsx` の 404 ではなく、`oidc-error` のページへの 303 で終わる。以前の出力に `--force` で生成し直しても `consent/actions.ts` は残るので、消してから生成し直す
