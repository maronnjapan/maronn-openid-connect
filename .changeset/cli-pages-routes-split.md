---
"@maronn-openid-connect/cli": minor
---

生成コードのルーティングを「画面用（`pages/`）」と「API（`routes/`）」の 2 種類に分け、UI のカスタマイズを `pages/`（と `views.ts`）だけで完結できるようにする。

- `pages/login.ts` / `pages/consent.ts` / `pages/errors.ts` を新たに生成する。`GET /login` `GET /consent` の描画ルートと、view のパラメータから Response を作る render ヘルパ（`renderLoginPage()` / `renderConsentPage()` / `renderErrorPage()` / `renderAuthorizationErrorPage()`）を持つ薄い層で、認証・コード発行・リダイレクト先の決定は行わない。`--enable device-authorization-grant` / `ciba` / `rp-initiated-logout` では `pages/device.ts`（`GET /device` を含む）/ `pages/ciba.ts` / `pages/logout.ts` も生成する
- `routes/*.ts` はロジック本体の API ルーティングになり、`views.ts` を import しない。`POST /login` / `POST /consent` を含め、画面を返す箇所（ログイン失敗の再表示、ロックアウトの 429、非リダイレクトの認可エラー、device / CIBA / logout の各画面）はすべて `pages/` の render ヘルパを呼ぶ。`config.authorizationErrorRedirectPath` による 303 の判断も `pages/errors.ts` へ移した
- `/login` `/consent` `/device` には画面側ルーター（GET）と API 側ルーター（POST）を同じパスにマウントする。生成される `web-router.ts` は同じプレフィックスに複数のルーターをマウントできるようになり、405 の `Allow` は両方のメソッドを合わせて返す（`PUT /login` → `Allow: GET, POST`。契約テストで固定）
- transaction-binding の束縛チェック `rejectUnboundTransaction()` は `pages/login.ts` / `pages/consent.ts` が持ち、`routes/` の POST も同じ関数を使う。google-login の `buildGoogleSignIn()`（GIS ボタン設定の組み立て）も `pages/login.ts` へ移した
- Next.js 向け生成物の契約テストで、壊れた Request Object の非リダイレクトエラーが `authorizationErrorRedirectPath` の 303 になることを期待するよう修正した（従来は HTML 400 を期待しており、生成直後から失敗していた）

HTTP 上の挙動（ステータスコード・Cookie・リダイレクト先・画面の HTML）は変わらない。生成済みコードを `--force` で再生成すると `pages/` が追加され、`routes/login.ts` `routes/consent.ts` `routes/authorize.ts` などの画面描画部分が render ヘルパ呼び出しに置き換わる。
