---
"@maronn-openid-connect/cli": minor
---

生成コードのルーティングを「画面用（`pages/`）」と「API（`routes/`）」の 2 種類に分け、UI のカスタマイズを `pages/`（と `views.ts`）だけで完結できるようにする。ブラウザに返すもの（画面の描画・リダイレクト・Cookie の付与）はすべて `pages/` が担当し、`routes/` はロジックだけを持って Response を一切作らない。

- `pages/authorize.ts` / `pages/login.ts` / `pages/consent.ts` / `pages/errors.ts` / `pages/respond.ts` を新たに生成する。ブラウザ向けのルートは GET も POST もここにあり（`GET|POST /authorize`・`GET|POST /login`・`GET|POST /consent`）、リクエストを読んで `routes/` の関数を呼び、返ってきた結果（outcome）を画面かリダイレクトに変換する。`pages/respond.ts` は Cookie を付けて Response / リダイレクトを返すヘルパ（`withCookies()` / `redirectWithCookies()`）。`--enable device-authorization-grant` / `ciba` / `rp-initiated-logout` では `pages/device.ts` / `pages/ciba.ts` / `pages/logout.ts` も生成し、各機能のブラウザ向けルートをすべて持つ
- `routes/authorize.ts` / `routes/login.ts` / `routes/consent.ts`（機能有効時: `routes/device.ts` / `routes/ciba-verification.ts` / `routes/logout.ts`）はルーターではなく関数を export するロジックモジュールになる（`processAuthorizationRequest()` / `prepareLogin()` / `submitLogin()` / `prepareConsent()` / `submitConsent()` / `submitDevice*()` / `prepareCibaDevice()` / `submitCiba*()` / `processEndSessionRequest()` / `approveLogout()`）。結果は `kind` 付きの outcome（リダイレクト先 `location`、付与する `cookies`、画面データ、またはエラー）で返し、`c.redirect()` / `c.json()` / `Set-Cookie` / `renderView()` を行わない。`views.ts` も `pages/` も import しない。transaction-binding の `rejectUnboundTransaction()` と google-login の `buildGoogleSignIn()` / `completeGoogleLogin()` もここに置く
- `token` / `userinfo` / `introspection` / `revocation` / `par` / `device_authorization` / `backchannel_authentication` / `jwks` / `discovery` の JSON エンドポイントは従来どおり `routes/` のルーターのまま
- `app.ts` / `apply.ts` はブラウザ向けパス（`/authorize` `/login` `/consent` `/device` `/ciba` `/logout`）に `pages/` のルーターだけをマウントする
- Next.js 向け生成物の契約テストで、壊れた Request Object の非リダイレクトエラーが `authorizationErrorRedirectPath` の 303 になることを期待するよう修正した（従来は HTML 400 を期待しており、生成直後から失敗していた）

HTTP 上の挙動（ステータスコード・Cookie・リダイレクト先・画面の HTML）は変わらない。生成済みコードを `--force` で再生成すると `pages/` が追加され、`routes/authorize.ts` `routes/login.ts` `routes/consent.ts` などは Response を返す handler から outcome を返す関数に置き換わる。これらを直接編集していた場合は、描画・リダイレクトに関する変更を `pages/` へ移す。
