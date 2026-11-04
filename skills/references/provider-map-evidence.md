# 地図の出力を証拠として読む

実装用・レビュー用の共通資料。リポジトリルートから参照する。規則の正本は設計文書と検査であり、過去の調査結果や件数を今回の正解として固定しない。

## 読む実装

- `apps/map/README.md`、`apps/map/docs/`、`apps/map/changes/README.md`
- `packages/map-analysis/src/roots.ts`、`analyze.ts`、`resolve.ts`、`tree.ts`、`impact.ts`、`model.ts`、`check.ts`、`wiring.ts`
- `packages/cli/extract.json`、`packages/cli/src/extract/functions.ts`、`extract/templates.ts`、`explain/`、`flow/`
- `.github/scripts/lint-*.mjs`、関係する `package.json`

カタログに載ること、本体の木があること、エンドポイントから実行・変更が届くことを区別する。地図の根はエンドポイント本体で、context/provider の初期化は自動では根にならない。CLI の step/meta/marker がどこから来るかもコードで確かめる。

| 証拠 | 確認するもの |
| --- | --- |
| `map.json.flows[].endpoints[].root` | エンドポイントの実際の根 |
| frame の `tree.nodes` / entry の `sites` | 実行の呼び出しと型で解決した target |
| `tree.implements` / `members` | interface の実装と、その実装が呼ぶもの |
| `changes.frames[].reach` | 実際の PR 比較で届く endpoint・道筋・必要な feature |
| `map.json.wiring` / untraceable target | 追えない配線の場所と理由 |

`FunctionEntry.calls` は deferred を含む。それだけの再帰探索では実行・到達を証明できない。factory 自身の実行と返したメンバーの実行、callback の登録と呼出し、interface 単位の接続と値の構築元をそれぞれ区別する。型が同じだからといって instance や middleware の適用順まで確定しない。

## 比較対象とコマンド

Node / pnpm の版はルートと関係 package の `package.json`（`engines` / `packageManager`）で確認する。

PR のマージ先は、利用者が別途指定していなければ `main`。実際の PR の base とローカル参照を確認する。背景ブランチ・調査用 checkpoint と PR の base を混同しない。生成時の SHA、dirty 状態、比較先とコマンドの終了結果を記録する。

```sh
pnpm install
pnpm run build
MAP_BASE=origin/main pnpm run build:map
node scripts/audit-wiring.mjs --output work/wiring-inventory.json
node scripts/check-wiring-audit.mjs work/wiring-inventory.json apps/map/public/data/map.json work/wiring-coverage.json
node scripts/inspect-map-wiring.mjs apps/map/public/data work/map-evidence.json '<対象の id の正規表現>'
```

比較先が異なる場合は、確認した base を `MAP_BASE` に使う。`build:map` は出力検査と全候補照合も実行する。最後の正規表現は表示の絞込みであり、リポジトリ全体の形の探索の代用ではない。索引・frame の形は `apps/map/src/types.ts` と `packages/map-analysis/src/model.ts` で確認する。

生成データは `apps/map/public/data/`、scratch・ログ・比較前のコピーは `work/` に置く。レビューで必要なビルドや一時ファイル作成は許容し、作業ツリーに既存の変更があれば必要に応じて独立した worktree を使う。

## 横断して探す形

`apps/hono`、`apps/nextjs`、`packages/` を対象に、context の書込み・上書き、middleware/hook 登録、module initializer、callable な変数・引数・戻り値、匿名 options、中間 object・spread・別名、返される method を探す。題材の名前の検索だけで全件としない。

各候補に実際の call/実装の橋/配線診断を対応づける。対象外なら範囲と理由を示す。`uncovered` や型 API の失敗を黙って除外しない。理由付きの未解決は、直ちに不具合を意味するものではない。

## 検査と報告の境界

```sh
pnpm run lint
pnpm run typecheck
pnpm --filter "./packages/*" test
pnpm --filter "./apps/*" test
pnpm --filter @maronn-openid-connect/cli test:matrix
```

必要な検査は変更範囲と repository の規則から決める。ソースを変えた検査を、その変更前の成功だけで代用しない。成功・失敗・未実行・環境で実行不可を分け、失敗した出力と原因を残す。ローカルの成功を GitHub Actions の成功や、ブラウザ E2E・外部 OIDF 実環境テストの成功として報告しない。
