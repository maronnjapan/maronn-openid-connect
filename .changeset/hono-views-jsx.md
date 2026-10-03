---
'@maronn-openid-connect/cli': minor
---

Hono の生成物の画面を hono/jsx で生成する

`generate hono` / `setup hono` は、ログイン・同意・エラー（と device / CIBA / logout）の既定の画面を HTML 文字列の `views.ts` ではなく、hono/jsx のコンポーネントを並べた `views.tsx` として出力する。JSX が埋め込んだ値をすべてエスケープするため、生成コードから `escapeHtml` がなくなる。`ViewResult` は JSX 要素・HTML 文字列・`Response` を受け付け、`renderView()` が JSX 要素をシリアライズする（async コンポーネントを含む要素は解決後にストリームで返す）。ビューのパラメーター型と `Views` インターフェースは他のフレームワークと共通のまま。

移行: `tsconfig.json` に `"jsx": "react-jsx"` と `"jsxImportSource": "hono/jsx"` を追加する。以前の CLI で生成した出力を再生成すると古い `views.ts` が残り、`views.tsx` より優先して解決されるので、カスタマイズを `views.tsx` へ移してから `views.ts` を削除する（CLI は残っている `views.ts` を警告する）。Express / Fastify / Next.js の生成物は変わらない。
