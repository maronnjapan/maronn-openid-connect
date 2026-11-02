# OIDC Provider Map

生成される OpenID Provider の地図。`maronn-oidc generate` のフレームワークと機能から、エンドポイント、その中のステップ（`maronn-oidc graph` の箱）、ステップの関数が呼ぶ関数、と core の関数までたどれる。関数ごとに役割（JSDoc の 1 行目）、仕様の節、投げるエラー、呼び元（どのステップ・エンドポイント・`--enable` から使われるか）を表示する。

React + Vite の静的ページで、Cloudflare Workers に静的アセットとして置く（`wrangler.jsonc`）。データは CLI の `explain --format json` を全機能オンで 4 フレームワーク分まとめたもので、`scripts/build-data.mjs` が `public/data/map.json` に書く。

```bash
# ルートで: CLI をビルドしてから地図をビルドする（dist/ に静的ページ）
pnpm run build:map

# このディレクトリで
pnpm run dev              # データを作って Vite の開発サーバー（http://127.0.0.1:3610）
pnpm run build            # データを作って dist/ にビルド
pnpm run deploy           # ビルドして wrangler deploy（https://maronn-oidc-map.<subdomain>.workers.dev）
pnpm run deploy:preview   # ビルドして wrangler versions upload（プレビュー URL が出る。本番は変わらない）
pnpm test                 # 純粋な部分（構成の絞り込み、コマンドライン、図のレイアウト、ハッシュ、検索）のテスト
```

`wrangler deploy` は `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID`（または `wrangler login`）を使う。Worker の名前は `wrangler.jsonc` の `name` で変える。

## PR ごとのプレビュー

`.github/workflows/map-preview.yml` が、PR ごとにその PR のコードから地図をビルドして Actions の artifact（`oidc-provider-map`）に残す。リポジトリのシークレットに `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` があれば、`wrangler versions upload` でプレビュー URL を作って PR にコメントし、main への push では `wrangler deploy` で本番の URL を更新する。シークレットが無くても artifact はダウンロードできる（`dist/` をそのまま静的に配信すればよい。`data/map.json` を同じ場所から読む）。

## 構成

- `src/lib/model.ts`: DOM に触らない部分。機能の絞り込み、`generate` のコマンドライン、関数を使うステップ、ステップの図の座標、検索
- `src/lib/hash.ts`: URL のハッシュ（`#hono--token--authenticate-client`、`#fn--verifyClientSecret`）
- `src/components/`: 左の設定（フレームワーク、機能、エンドポイント）、中央のステップの図（SVG）、右の詳細（ステップ、関数、呼び出しの木、呼び元）
- `src/types.ts`: `data/map.json` の形（CLI の `explain/map.ts` と `flow/types.ts` と同じ）
