---
'@maronn-openid-connect/cli': minor
---

Next.js 向けの生成コードを、App Router の機能をそのまま使う構成に作り直す。これまでは Hono 風の共通ルーター（`_oidc-provider/web-router.ts` / `app.ts` / `next.ts` / `runtime.ts`）の上で他フレームワークと同じ `pages/` / `routes/` を動かし、各 `route.ts` はそこへ委譲するだけだったため、1 つのエンドポイントの処理を追うのに何層も読む必要があった。

- エンドポイントごとの Route Handler（`authorize/route.ts`・`token/route.ts`・`userinfo/route.ts`・`introspect/route.ts`・`revoke/route.ts`・`.well-known/*/route.ts`、機能有効時の `par/route.ts`・`device_authorization/route.ts`・`backchannel_authentication/route.ts`・`logout/route.ts` など）が自分で `GET` / `POST` / `OPTIONS` を export し、検証パイプラインをそのファイルに上から順に書く
- 全エンドポイントが共有する部品は `_oidc-provider/` にまとめる。`provider.ts` は設定・クライアント・署名鍵・ストアを組み立てる場所で、環境変数 `OIDC_ISSUER` / `OIDC_CLIENTS_JSON` / `OIDC_SIGNING_KEY_ID` などを読む。`http.ts` は CORS・キャッシュ禁止の JSON 応答・パラメータ重複の検出・エラーページへのリダイレクト、`html.ts` は device / CIBA / RP-Initiated Logout の画面を HTML で返す Route Handler 用の部品
- ログイン・同意画面は従来どおりページと Server Action（`login/page.tsx` + `login/actions.ts` + `login/session.ts`、`consent/page.tsx` + `consent/actions.ts`）
- OP がブラウザを止める場面を Next.js の機能で表す。`transaction_id` に対応する認可リクエストが無ければページと Server Action が `notFound()` を呼び、`login/not-found.tsx` / `consent/not-found.tsx` を HTTP 404 で表示する。クライアントへ返してはいけないエラー（未登録の `redirect_uri`、CSRF トークンの不一致、ログイン試行回数の上限、transaction-binding の不一致、判断を含まない同意の POST、Google ログインのコールバックの失敗など）は `redirect()` で `oidc-error/page.tsx` へ送る。想定外の例外は `login/error.tsx` / `consent/error.tsx`（error boundary）が表示し、本番ではエラーメッセージを出さずサーバーログと突き合わせられる `digest` だけを出す。これらの画面は `_oidc-provider/error-view.tsx` の共通レイアウトで描く（`oidc-error/error.tsx` は廃止）。従来は、トランザクションが見つからないときや CSRF トークンが一致しないときに例外がそのまま投げられ、Next.js の既定のエラー画面（500）になっていた
- device / CIBA / RP-Initiated Logout の画面は、表示と同時に Cookie を発行し 403 や 429 などのステータスを返す必要があるため、HTML を返す Route Handler（各ディレクトリの `screens.ts`）として生成する。実験的機能の設定は、それを使うコードの隣に置く（例: `par/config.ts`、`token/token-exchange.ts` の `tokenExchangeConfig`）
- 署名鍵プロバイダを `globalThis` で共有し、同意の Server Action でも JWKS が公開する鍵で署名できるようにした。これにより `--enable jarm` では、ログイン・同意画面を経由する応答も JARM になる（従来は平文クエリに戻る制限があった）
- `--enable rp-initiated-logout` の `/logout` と `/logout/approve` を Next.js でも生成する（従来はロジックだけが生成され、Route Handler が無かった）
- 同意の Server Action が grant を記録するようにし、同意を撤回（`consentResolver.revokeConsent()`）すると、同意画面を経て発行したトークンも失効するようにした。ログインフォームは `login_hint` を初期値に使う
- 契約テスト `_oidc-provider/conformance.test.ts` を Next.js 用に書き直した。Route Handler・ページ・Server Action を Next.js と同じ形で直接呼び出し（`next/headers` の `cookies()` と `next/navigation` の `redirect()` / `notFound()` だけを差し替える）、サーバーを起動せずに `vitest run` で実行できる

hono / express / fastify の生成物は変わらない。生成済みの Next.js コードを `--force` で再生成すると、`_oidc-provider/` 配下の共通ルーター関連ファイル（`app.ts` / `web-router.ts` / `next.ts` / `runtime.ts` / `views.ts` / `pages/` / `routes/`）と `oidc-error/error.tsx` は生成されなくなるので削除する。`runtime.ts` で行っていた設定・クライアント・署名鍵の差し替えは `_oidc-provider/provider.ts` へ移す。
