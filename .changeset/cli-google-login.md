---
"@maronn-openid-connect/cli": minor
---

拡張機能カテゴリ（Extension features）を追加し、`--enable google-login` で Sign in with Google（Google Identity Services の redirect mode）を生成コードのログイン手段に足せるようにする。既定では無効で、無効時の生成物は従来と 1 バイトも変わらない。

有効時は `@maronn-openid-connect/google-login` を import する次の生成物が加わる。

- `config.ts`: `ProviderConfig.googleLogin?: GoogleLoginConfig`（`clientId` / 任意の `hostedDomain` / `requireVerifiedEmail`）。未設定ならボタンは描画されず `/login/google` は 404
- `views.ts`: `LoginPageParams.googleSignInHtml`。既定のログイン画面はパスワードフォームの下に `buildGoogleSignInMarkup()` の HTML を埋め込む
- `routes/login.ts`: GET `/login` で認証トランザクションに束縛した nonce を発行してボタンを描画し、`POST /login/google`（`login_uri`）で `g_csrf_token` の Double Submit Cookie 検証 → `google-auth-library` による ID トークン検証 → nonce の単回消費 → パスワードログインと同じセッション確立 → `/consent` へ進む
- `store.ts`: `googleLoginNonceStore`（インメモリ / `JsonStoreBackend` 両対応）と、Google アカウントを `google:<sub>` の subject で JIT 登録する `userStore.linkGoogleAccount()`
- `app.ts`: `googleIdTokenVerifier` / `googleAccountResolver` を差し替えるオプション（契約テストは偽の verifier を注入する）
- Hono のメソッドガードと Fastify アダプタに `POST /login/google` を登録。Next.js は `login/google/route.ts`（Node.js ランタイム）を生成し、`login/page.tsx` でボタンを描画、`runtime.ts` が `GOOGLE_CLIENT_ID` / `GOOGLE_HOSTED_DOMAIN` を読む
- `conformance.test.ts`: ボタン描画・nonce の発行と単回消費・CSRF・検証失敗・hosted domain・JIT 登録からトークン発行と UserInfo までを固定する契約テスト

`--help` と未知の機能名のエラーメッセージに「Extension features (disabled by default): google-login」を追加し、`setup` の次のステップ案内に `@maronn-openid-connect/google-login` のインストールを加える。`google-auth-library` の要件により、この機能を有効にした生成コードは Node.js 22 以上限定になる。
