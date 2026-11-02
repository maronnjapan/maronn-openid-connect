# OIDC Provider Map

生成される OpenID Provider の地図。
`maronn-oidc generate` のフレームワークと機能を選ぶと、その構成のエンドポイントを一覧し、エンドポイントのステップを箱と矢印の図で描く。

## エンドポイントの図とケース

図は**ケース**に分かれる。
ケースはエンドポイントを通る道筋の一つで、分岐の矢印のラベルで名前が付く（`/token` なら `authorization_code` と `refresh_token`、画面なら `GET` と `POST › authenticated`）。
図には、チェックしたケースで通るステップと矢印だけを表示し、通らないステップは灰色の点線にする。
最初は先頭のケースだけをチェックしているので、すべての矢印が一度に出ることはない。
「エラー時」をチェックすると、表示中のステップからエラー応答のステップへの矢印が加わる。

ステップを選ぶと、図の横にそのステップの詳細を開く。
詳細はステップの振る舞いから並べる。
ステップの関数の JSDoc の 1 行目、ステップが受け取る値と次へ渡す値、失敗するときのエラー、中で呼ぶ関数（実行順、各行にコードのコメントか呼び先の JSDoc）である。
説明が場所を取って図が狭くならないよう、エンドポイントの説明は 1 段落にとどめ、関数の説明の 2 段落目以降は「詳しく」で開く。

## 関数のページ

関数を選ぶと、その関数のページを開く。
ページの中心は関数の中の処理の流れの図で、エンドポイントの図と同じ形をしている。
関数が呼ぶ関数を実行順に箱にし、`if` や `switch` の条件を矢印のラベルに、`return` と `throw` を終わりの箱にする。
resolver や store のメソッドの呼び出し（`consentResolver.recordConsent()`）も箱になり、インターフェースのメンバーの JSDoc で説明する。
ケースも同じく、条件の組み合わせごとの道筋を選べる（最初は最も長い道筋、つまり途中で `return` も `throw` もしない道筋をチェックする）。
箱を選ぶと、呼び先の関数のページへ進む。

横の「呼び出し元」には二つを並べる。
一つは、その関数に届くエンドポイントのステップで、間に挟まる関数があればその順に示す。
もう一つは、その関数を直接呼ぶ関数で、それぞれの JSDoc の 1 行目を添える。

図の色は 3 つに限る。
灰色はチェックしたケースで通らない部分、青は通る部分と選んだ箱、赤はエラー応答のステップ、`throw`、エラーの矢印である。

## データとビルド

React + Vite の静的ページで、Cloudflare Workers に静的アセットとして置く（`wrangler.jsonc`）。
データは `scripts/build-data.mjs` が `public/data/map.json` に書く。
中身は次の四つである。

- CLI の `explain --format json` を全機能オンで 4 フレームワーク分まとめたもの
- 関数カタログの全関数と、それぞれの処理の流れ（`packages/cli/src/extract/function-flow.ts`）
- 処理の流れが呼ぶ resolver と store のメソッドの JSDoc
- エンドポイントごと、ステップを足す機能の組み合わせごとの矢印（機能を切ったときも、その構成の生成物と同じ矢印を描くため）

```bash
# ルートで: CLI をビルドしてから地図をビルドする（dist/ に静的ページ）
pnpm run build:map

# このディレクトリで
pnpm run dev              # データを作って Vite の開発サーバー（http://127.0.0.1:3610）
pnpm run build            # データを作って dist/ にビルド
pnpm run deploy           # ビルドして wrangler deploy（https://maronn-oidc-map.<subdomain>.workers.dev）
pnpm run deploy:preview   # ビルドして wrangler versions upload（プレビュー URL が出る。本番は変わらない）
pnpm test                 # 純粋な部分（構成の絞り込み、ケース、図のレイアウト、呼び出し元、ハッシュ、検索）のテスト
```

`wrangler deploy` は `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID`（または `wrangler login`）を使う。Worker の名前は `wrangler.jsonc` の `name` で変える。

## PR ごとのプレビューと main のデプロイ

`.github/workflows/map-preview.yml` が、リポジトリのシークレット `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` で次を行う。

- **PR**（opened / synchronize / reopened）: その PR のコードから地図をビルドし、同じ Worker の **Worker Preview** `pr-<番号>`（`wrangler preview --name pr-<番号>`）を作る・更新する。PR ごとに固定の URL を持つ隔離されたデプロイで、push のたびに同じ URL が新しくなるので、複数の PR を同時に別々の状態で見られる。URL は PR のコメントに書く（push ごとに同じコメントを書き換える）
- **PR を閉じた**: その Preview を `wrangler preview delete --name pr-<番号>` で消す
- **main への push**: `wrangler deploy` で本番（いまは `https://maronn-oidc-map.<subdomain>.workers.dev`。独自ドメインは後で）を更新する

Worker Previews はオープンベータ（wrangler 4.135 以降）なので、`wrangler preview` が失敗したときは `.github/scripts/map-preview.mjs` が PR ごとの Worker `maronn-oidc-map-pr-<番号>` へ `wrangler deploy` して同じ隔離を保ち、閉じたときにその Worker も消す。どの場合も Actions の artifact（`oidc-provider-map`）にビルド結果が残り、ダウンロードして `dist/` を静的に配信すれば同じ地図が見られる（`data/map.json` を同じ場所から読む）。

## 構成

- `src/lib/graph.ts`: ケースの導出、チェックしたケースが使う箱と矢印、図の座標。DOM に触らない
- `src/lib/diagram.ts`: エンドポイントと関数を同じ図の形にし、箱に書く 2 行（何をするか）を決める
- `src/lib/model.ts`: 機能の絞り込み、`generate` のコマンドライン、関数に届くステップと呼び出し元、検索
- `src/lib/hash.ts`: URL のハッシュ（`#hono--token--authenticate-client`、`#hono--fn--verifyClientSecret`）
- `src/components/`: エンドポイントの画面と関数のページ、図、ケースの選択、ステップの詳細、左の一覧、検索
- `src/types.ts`: `data/map.json` の形（CLI の `explain/map.ts`、`flow/types.ts`、`extract/function-flow.ts` と同じ）
