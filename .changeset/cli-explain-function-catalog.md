---
'@maronn-openid-connect/cli': minor
---

`maronn-oidc explain` を足し、生成される OP を CLI のコマンドから core の関数までたどれるようにする

- `explain` は、エンドポイントの一覧、1 つのエンドポイントのステップ、ステップの関数が呼ぶ関数（`--depth` 段、core まで）とそれぞれの役割・仕様の節・投げるエラー、関数 1 つの呼び先と `--callers` で呼び元（それを使うステップ、エンドポイント、`--enable` の機能）を表示する。`--format json` は UI 向けの地図を書く。Next.js は `route.ts` のブロックが呼ぶ関数を表示する
- 関数カタログ: CLI のビルドが core / experimental / google-login と apps の関数宣言を読み、JSDoc の 1 行目、`@spec`、`@throws`、本体が呼ぶ関数、呼び元を `templates/functions.catalog.json` に焼く
- フロー文書は version 2 になる。ステップの `calls` は関数カタログの id（手書きの名前ではなく、ステップの関数のソースから読む）、`functionId` はステップの関数、`dynamicCalls` はソースに現れない呼び出し（resolver のメソッドなど）。version 1 の文書も `--flow` に渡せる
- 生成コードのステップの `meta` から手書きの `calls` を外す。残るのは `'consentResolver.recordConsent'` のような、ソースに呼び出しとして現れないものだけ
- 生成コードの関数の JSDoc から「ステップ N:」の番号を外し、仕様だけの行を `@spec` タグに移す。JSDoc の無かった補助関数（`createStoreResolvers`、`applyOidc`、db の `createProviderStores` など）に 1 行目を書く
- `explain --format json` は、リポジトリの地図ページ（`apps/map`。Cloudflare Workers に置く）の入力になる
