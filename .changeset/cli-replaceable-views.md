---
"@maronn-openid-connect/cli": minor
---

生成する `views.ts` を、画面の差し替えを前提にした形に整える。既定のビューはフローを動かすための最小限の画面のままで、ビューが返せる値を広げることで、テンプレート文字列、テンプレートエンジン、React や Vue のサーバー描画など、HTML を作れる方法なら何でも `views` オプションで画面を差し替えられるようにする。`views.ts` は UI フレームワークに依存しない。

- `views.ts`: `ViewResult` を `string | ReadableStream<Uint8Array> | Response` に広げ、`Views` の各メソッドの戻り値を `ViewResult | Promise<ViewResult>` にする。`renderView()` は非同期になって `Promise<Response>` を返し、HTML にならない値（描画していないコンポーネントなど）を受け取ると `TypeError` を投げる。既定のビューが使う `escapeHtml()` を export し、差し替えた画面が守るフォームの契約をコメントに書く
- `routes/device.ts` / `routes/ciba-verification.ts` / `routes/logout.ts`: Cookie を付ける前に `renderView()` の結果を `await` する
- `conformance.test.ts`: 非同期のビュー、ストリームを返すビュー、描画していない値の拒否、非同期にストリームを返すログイン画面がログインルートを通って届くことを固定する契約テストを加える

`renderView()` の戻り値が Promise になるため、生成コードを改造して `renderView()` の結果を同期的に使っている箇所（独自のルートなど）は `await` が必要になる。
