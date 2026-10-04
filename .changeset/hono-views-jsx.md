---
'@maronn-openid-connect/cli': minor
---

Hono の生成物を TSX 前提にし、画面を hono/jsx で描画する

`generate hono` / `setup hono` は、ログイン・同意・エラー（と device / CIBA / logout）の画面を JSX で生成する。

- 既定の画面は HTML 文字列の `views.ts` ではなく、hono/jsx のコンポーネントを並べた `views.tsx` に出力する。JSX が埋め込んだ値をすべてエスケープするため、生成コードから `escapeHtml` がなくなる
- 画面を描く `pages/errors` / `pages/login` / `pages/consent`（機能有効時は `pages/device` / `pages/ciba` / `pages/logout`）も `.tsx` になり、`renderView(<views.loginPage {...params} />)` のように JSX でビューを描画する。HTML を返さない `pages/authorize.ts` と `pages/respond.ts` は `.ts` のまま
- Hono の `ViewResult` は JSX 要素（`JSX.Element`）になり、ビューは JSX 要素を返すコンポーネントとして書く。別の手段で組み立てた HTML は `hono/html` の `html` タグか `raw()` で返し、Response そのもの（ステータスやヘッダー）を変えるときは `pages/*.tsx` の `render*Page()` を書き換える。`renderView()` は async コンポーネントを含む要素を解決後にストリームで返す
- ビューのパラメーター型と `Views` インターフェースのメソッド構成は他のフレームワークと共通のまま。契約テストは JSX ビューの描画（`renderView()` のシリアライズ・ステータス・非同期描画）と、`createApp` の `views` で注入したビュー（`html` タグで組み立てたもの）の描画を固定する

移行: `tsconfig.json` に `"jsx": "react-jsx"` と `"jsxImportSource": "hono/jsx"` を追加する。HTML 文字列や `Response` を返していたカスタムビューは、JSX コンポーネント（または `html` / `raw()`）に書き換えるか、Response を組み立てる処理を `pages/*.tsx` の `render*Page()` へ移す。以前の CLI で生成した出力を `--force` で再生成すると古い `views.ts` や `pages/login.ts` などが残り、同名の `.tsx` より優先して解決されるので、カスタマイズを `.tsx` へ移してから古い `.ts` を削除する（CLI は残っているファイルを一覧して警告する）。Express / Fastify / Next.js の生成物は変わらない。
