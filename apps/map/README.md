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
PR の地図の札（次の節）は、この 3 色を使わない。

## PR の地図: 変わった関数と変更メモ

PR の地図は、その PR が変えた関数を見分けて札を付け、PR が足した変更メモ（[changes/](changes/README.md)）の説明を表示する。
最初に開くのは「このPRの変更」のページ（`#<framework>--changes`）である。
変えた関数を「足した」「コードを変えた」「別のファイルへ移した」「JSDoc だけ変えた」「消した」に分けて並べ、それぞれに変更メモの説明を添える。
横には札の付くエンドポイントを、コードの変更が届くものから並べる。

札は図の 3 色を使わず、灰色の濃淡で示す。

- `追加` `変更`: その関数を足した、またはコードを変えた。関数の処理の流れでは、変えた行の箱（引数を変えたときは開始の箱）に `変更` が付く
- `中で変更`: その箱から呼ぶ関数（その先を含む）のコードを変えた。エンドポイントの図から、変えた関数までたどれる
- `説明` `移動` `メモ`: JSDoc だけ変えた、コードはそのままで別のファイルへ移した、コードは変えていないが変更メモが説明している

関数のページでは、変更の種類と変更メモの説明の下に差分（「差分を見る」）を開ける。
ステップの詳細と関数のページの横には、そこから呼ぶ関数のうちコードを変えたものを、間に挟まる関数とともに並べる。
エンドポイントの画面には、そのエンドポイントのファイル（Next.js の `route.ts`、Hono の `pipeline.ts`）でこの PR が変えた関数も並べる。
ブロックの印の無い Route Handler では、ステップがどの関数を呼ぶかを読めず、ステップに札が付かないためである。

変わった関数は、地図のビルドが作業ツリーと base の分岐点（`git merge-base <MAP_BASE> HEAD`）を比べて見つける。
変わったファイルを関数カタログと同じ読み方で読み、関数ごとに本文と JSDoc を比べるので、まわりの行がずれただけの関数は変わったことにならない。
PR では `map-preview.yml` が `MAP_BASE=origin/<base ブランチ>` を渡し、PR のコメントにも変わった関数と説明の表を載せる。

## データとビルド

React + Vite の静的ページで、Cloudflare Workers に静的アセットとして置く（`wrangler.jsonc`）。
データは `scripts/build-data.mjs` が `public/data/map.json` に書く。
中身は次の四つである。

- CLI の `explain --format json` を全機能オンで 4 フレームワーク分まとめたもの
- 関数カタログの全関数と、それぞれの処理の流れ（`packages/cli/src/extract/function-flow.ts`）
- 処理の流れが呼ぶ resolver と store のメソッドの JSDoc
- エンドポイントごと、ステップを足す機能の組み合わせごとの矢印（機能を切ったときも、その構成の生成物と同じ矢印を描くため）

`MAP_BASE`（git のリビジョン）を渡すと、その分岐点からの変更（`scripts/changes.mjs`。変わった関数、関数ごとの差分、変更メモの説明）も書く。
同じ内容を Markdown で `public/data/changes.md` に書き、PR のコメントがそれを引用する。
`MAP_PR`、`MAP_PR_TITLE`、`MAP_PR_URL` は、ページに出す PR の番号、タイトル、URL である。

```bash
# ルートで: CLI をビルドしてから地図をビルドする（dist/ に静的ページ）
pnpm run build:map

# このディレクトリで
pnpm run dev              # データを作って Vite の開発サーバー（http://127.0.0.1:3610）
MAP_BASE=origin/main pnpm run dev   # origin/main からの変更（コミットしていないものを含む）に札を付けた地図
pnpm run build            # データを作って dist/ にビルド
pnpm run deploy           # ビルドして wrangler deploy（https://maronn-oidc-map.<subdomain>.workers.dev）
pnpm run deploy:preview   # ビルドして wrangler versions upload（プレビュー URL が出る。本番は変わらない）
pnpm test                 # 純粋な部分（構成の絞り込み、ケース、図のレイアウト、呼び出し元、ハッシュ、検索、変更の札）と、変更を集める scripts/changes.mjs のテスト
```

`wrangler deploy` は `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID`（または `wrangler login`）を使う。Worker の名前は `wrangler.jsonc` の `name` で変える。

## PR ごとのプレビューと main のデプロイ

`.github/workflows/map-preview.yml` が、リポジトリのシークレット `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` で次を行う。

- **PR**（opened / synchronize / reopened）: その PR のコードから地図をビルドし、同じ Worker の **Worker Preview** `pr-<番号>`（`wrangler preview --name pr-<番号>`）を作る・更新する。PR ごとに固定の URL を持つ隔離されたデプロイで、push のたびに同じ URL が新しくなるので、複数の PR を同時に別々の状態で見られる。URL は PR のコメントに書く（push ごとに同じコメントを書き換える）。地図とコメントには、その PR が変えた関数と変更メモの説明が載る（上の「PR の地図」）
- **PR を閉じた**: その Preview を `wrangler preview delete --name pr-<番号>` で消す
- **main への push**: `wrangler deploy` で本番（いまは `https://maronn-oidc-map.<subdomain>.workers.dev`。独自ドメインは後で）を更新する

Worker Previews はオープンベータ（wrangler 4.135 以降）なので、`wrangler preview` が失敗したときは `.github/scripts/map-preview.mjs` が PR ごとの Worker `maronn-oidc-map-pr-<番号>` へ `wrangler deploy` して同じ隔離を保ち、閉じたときにその Worker も消す。どの場合も Actions の artifact（`oidc-provider-map`）にビルド結果が残り、ダウンロードして `dist/` を静的に配信すれば同じ地図が見られる（`data/map.json` を同じ場所から読む）。

## 構成

- `src/lib/graph.ts`: ケースの導出、チェックしたケースが使う箱と矢印、図の座標。DOM に触らない
- `src/lib/diagram.ts`: エンドポイントと関数を同じ図の形にし、箱に書く 2 行（何をするか）を決める
- `src/lib/model.ts`: 機能の絞り込み、`generate` のコマンドライン、関数に届くステップと呼び出し元、検索
- `src/lib/hash.ts`: URL のハッシュ（`#hono--token--authenticate-client`、`#hono--fn--verifyClientSecret`、`#hono--changes`）
- `src/lib/changes.ts`: PR の変更の札（ステップ、処理の流れの箱、エンドポイント）、そこから呼ぶ変わった関数、差分の行番号、変更メモの本文
- `src/components/`: エンドポイントの画面と関数のページ、図、ケースの選択、ステップの詳細、左の一覧、検索、このPRの変更のページ
- `scripts/changes.mjs`: 地図のビルドが PR の変更を集める（git の差分、関数ごとの比較、変更メモ）
- `changes/`: PR ごとの変更メモ（[書き方](changes/README.md)）
- `src/types.ts`: `data/map.json` の形（CLI の `explain/map.ts`、`flow/types.ts`、`extract/function-flow.ts` と同じ）
