---
name: provider-map-traceability
description: OIDC Provider の振る舞いや配線を変更するとき、エンドポイントから core への型の経路と、地図・PR 差分の到達範囲を出力データで確かめる。ミドルウェア、フック、ラッパー、コールバック、起動時初期化の追加・修正や、地図から漏れる処理の調査にも使う。
---

# Provider の配線を地図で追えるようにする

この skill はリポジトリのルートで使う。個別の関数名や以前の計測値を正解として固定せず、その作業のコードと生成した地図を根拠にする。通常の実装判断は自分で行い、選択の理由を JSDoc、設計文書かコミットメッセージに残す。

## まず読む

次を読み、その時点の根、型による辺、解析の限界、生成時に消える範囲を確認する。

- `apps/map/README.md`、`apps/map/docs/`、`apps/map/changes/README.md`
- `packages/map-analysis/src/roots.ts`、`analyze.ts`、`resolve.ts`、`tree.ts`、`impact.ts`、`model.ts`、`check.ts`。配線の一覧や検査を追加したモジュールも読む
- `packages/cli/src/extract/functions.ts`、`extract/templates.ts`、`explain/`、`flow/`、`packages/cli/extract.json`
- `.github/scripts/lint-*.mjs`、ルートと関係パッケージの `package.json`

地図の根はエンドポイントの処理本体である。関数カタログに載ること、関数の本体が読めること、エンドポイントから届くことを区別する。型付き interface メンバーの呼び出しは、実装とその実装の呼び先を介して届くことがある。Hono のコンテキストで読める型が分かっても、その値を構築した処理がエンドポイントから届くとは限らない。

`FunctionEntry.calls` は遅延した処理の参照も含む。これだけを再帰探索して「実行される」「PR の変更が届く」と結論しない。実行の辺は木の `call` ノードと `sites`、interface の橋は `FlowTree.implements` と `members`、PR の到達は `changes.frames[].reach` で確かめる。任意の関数への到達を計算するときは `impact.ts` の `CallGraph` / `reachOf` を使う。ファクトリ自体への到達と、返したメンバーの実装への到達も分ける。

## 修正前の証拠を保存する

1. 作業ツリーと比較対象を確認し、既存の変更を保つ。別ブランチの題材なら、必要な参照を取得して比較対象を明記する。
2. `pnpm install` と `pnpm run build:map` を実行する。Node / pnpm の版は `package.json` に従う。
3. 中間ファイル、JSON、ログは `work/` に置く。生成データ `apps/map/public/data/` を修正前として別ディレクトリへコピーする。生成物のハッシュ名を手で決めない。
4. `apps/map/src/types.ts` と解析の `model.ts` を読んでから、小さな Node スクリプトで索引と各フレームを読む。画面の目視だけを証拠にしない。

例えば `work/inspect-map.mjs` に次を書き、関数または本体の id を引数で渡せる。修正前後はそれぞれ保存した `map.json` と同じディレクトリのフレームを読むようにする。

```js
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const indexPath = resolve(process.argv[2]);
const id = process.argv[3];
const data = JSON.parse(readFileSync(indexPath, 'utf8'));
const entry = data.functions[id] ?? data.bodies[id];
if (!entry) throw new Error(`No frame: ${id}`);
const framePath = resolve(dirname(indexPath), entry.frame.replace(/^\.\/data\//, ''));
const frame = JSON.parse(readFileSync(framePath, 'utf8'));
function calls(nodes) {
  return nodes.flatMap((node) => [
    ...(node.kind === 'call' ? [{ id: node.id, code: node.code, target: node.target }] : []),
    ...calls(node.pre ?? []),
    ...(node.branches ?? []).flatMap((branch) => calls(branch.nodes)),
  ]);
}
console.log(JSON.stringify({
  id, rootCalls: calls(frame.tree.nodes),
  implementations: frame.tree.implements ?? [], deferred: frame.tree.deferred ?? [],
  change: data.changes?.frames.find((change) => change.id === id),
  wiring: (data.wiring ?? []).filter((item) => item.target === id),
}, null, 2));
```

`reach` が空なら、到達辺がないのか、機能が無効なのか、interface 実装の変更として数えるべきなのかをコードとグラフで区別する。分からない箇所は理由付きの未解決として残す。

## 名前によらず同じ形を探す

`apps/hono`、`apps/nextjs`、`packages/` を AST と型で走査し、対象を一覧にする。検索対象と除外対象も保存する。対象の関数名を列挙する検索だけで完了しない。

| 切れ目の種類 | 探す形と確かめること |
| --- | --- |
| 構築元が根の外 | コンテキストへの書込み・上書き、モジュール直下の初期化、middleware / hook 登録。値の型と作成元の両方が届くか |
| 呼べる契約が匿名 | 関数型引数、匿名 options の callable property、関数型の戻り値。宣言元が解決されるか、理由付き未解決になるか |
| 型の結び付きが途中で失われる | 中間 object、spread、別名、戻した method。実装と interface メンバーの対応が残るか |
| 登録と実行が違う | inline / 名前で渡す callback、イベント・Promise・hook。登録した場所で実行したことにしていないか |
| カタログから漏れる | モジュール直下の callable な `const`、関数を返す値、解析対象外の module。型で辿れる関数か、配線の未解決一覧に残るか |

一覧の各箇所に、修正後の関数・メンバー・配線の id、または解析対象外の理由を対応づける。「見つかった数」だけで網羅したことにしない。

## 設計を選ぶ

地図が計算する案と、辿れるコードにする案をそれぞれ複数比較する。

- 地図側：型付きの呼び出し・実装の橋の強化、値の構築元の解析、framework の入口を含む解析、理由付きの未解決表示。
- コード側：エンドポイントから呼ぶ型付き helper、名前のある callable 契約、型付き provider / DI、各エンドポイントへの展開。

通常は、振る舞いをエンドポイントから呼ぶ helper の配下に置き、型で解けない登録・初期化を地図が明示する形を優先する。型付きコンテキストを作っただけで構築元まで届くと扱わない。重複する配線、実際には起きない即時呼び出し、手書きの到達先宣言で埋めない。

選択は、core までの型の経路、機能のオン・オフ、owner ブロックの削除、import 境界、Hono と Next.js の対称性、生成コード、機械的検査、未解決の表示、手書き到達先の不要さで評価する。選ばなかった案と理由も残す。

## 実装と検査

- コードの形、地図の解析、規則・検査の追加の順に別コミットで進める。修正に必要な振る舞いのテストはその変更と一緒に置く。
- 関数は `function` 宣言、JSDoc の 1 行目は振る舞いを一文、pipeline のステップは marker 行とする。機能の識別子を owner ブロックの外へ出さず、base と feature と DB の import 境界を守る。
- Hono と Next.js を対応させる。`samples/` は手で直さず、CLI のビルド後に各 sample の既存の `generate` スクリプトで再生成する（`pnpm --filter "./samples/*" run generate`）。sample が持つ `db/instance.ts` などの境界を確認する。
- `apps/map/changes/` には意図と背景を書く。関数ごとの節を対応づける。何を変えたか・どこに効くかは地図に計算させる。必要なら `MAP_BASE=<比較対象> pnpm --filter @maronn-openid-connect/map changes:draft` で雛形を作る。
- 新しい規則を増やすなら `.github/scripts/lint-*.mjs` または地図の出力検査で守り、`apps/map/docs/design-change-trail-and-decision-cases.md` の「貢献者に課す規則」に理由と検査を追記する。skill の注意書きだけで保証しない。
- core の破壊的変更には changeset を付ける。

修正後も `MAP_BASE=<比較対象> pnpm run build:map` を実行し、修正前のスクリプトを同じ条件で再実行する。対象の処理が根から辿れ、同じ形の一覧がすべて解決済みか理由付き未解決になることをデータで示す。通常のビルドだけで PR の `reach` を検証したことにしない。

必要な検査を実行し、失敗した出力も保存して原因と対処を報告する。

```sh
pnpm run lint
pnpm run typecheck
pnpm --filter "./packages/*" test
pnpm --filter "./apps/*" test
pnpm --filter @maronn-openid-connect/cli test:matrix
```

解析を変更した場合は、直接呼び出し、interface 実装、callback の登録と実行、匿名の callable 契約、型が不明な context、起動時初期化を区別するテストを置く。データモデルを変えた場合は表示側と出力検査も更新する。検査が通った後は、新しい変更や未解決の懸念がない限り同じ検査を繰り返さない。

## 報告と PR

報告には、地図の根・型で辿れるもの・辿れないもの、切れ目の分類と全体の一覧、比較した案と選択理由、修正前後のデータ、失敗した検査の出力、残した未解決と理由を含める。必要な検査と生成を完了してから、依頼の範囲に従って PR を作成する。PR は最終的な問題・動作・検証が分かる記述にする。
