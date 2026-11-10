---
name: provider-map-implementation
description: OIDC Provider の振る舞い・配線・地図解析を実装または修正するときに使う。エンドポイントから core まで型で辿れる形、Hono と Next.js の対応、CLI 生成、地図・PR の到達検査を保つ。レビューだけの依頼には provider-map-review を使う。
---

# 地図で辿れる Provider を実装する

リポジトリルートの `skills/references/provider-map-evidence.md` を最初に読み、現在のコード・規則・データの形を確認する。この skill は実装用。レビューだけを依頼された場合は `skills/provider-map-review/SKILL.md` を読む。

## 修正前の状態を確かめる

1. 作業ツリーと利用者の指示を確認し、既存の変更を保つ。背景ブランチの参照先と PR のマージ先を区別する。別指定がなければ PR は `main` 向けとする。
2. 必要なライブラリと地図をビルドし、現在の根、型で辿れる辺、辿れない境界を自分の言葉でまとめる。
3. 修正前の生成データを `work/` へ保存し、小さなスクリプトで nodes/sites・implements/member・reach・wiring を読む。画面や `FunctionEntry.calls` だけを到達の根拠にしない。
4. 共通資料の形の棚卸しをリポジトリ全体で行い、同型の箇所と、各箇所が切れる理由を記録する。対象外や型 API の失敗も残す。

## 設計を選ぶ

地図側とコード側の案を複数比較し、選択と不採用の理由を JSDoc、設計文書かコミットメッセージに残す。通常の設計判断は依頼の範囲で自分で進める。

- 地図側の候補は、型付き実装/callback の橋、値の構築元の解析、framework の入口を含む解析、理由付きの未解決表示。
- コード側の候補は、endpoint が呼ぶ型付き helper、名前のある callable 契約、型付き provider/DI、endpoint への展開。

core までの型の経路、feature のオン・オフ、owner block の削除、import 境界、Hono/Next.js の対称性、生成コード、機械的検査、未解決の明示、手書きの到達先が不要なことを比較する。

振る舞いを endpoint が呼ぶ helper 配下に置き、型で解けない登録・初期化は地図に明示する形を優先する。型付き context を作っただけで構築元まで届くと扱わない。重複する配線、根拠のない即時呼出し、手書きの到達先宣言で切れ目を埋めない。

## 実装する

- コードの形、地図の解析、規則・検査の追加の順に別コミットにする。振る舞いを検証するテストは対応する変更と一緒に置く。
- 関数は `function` 宣言、JSDoc の 1 行目は振る舞いを一文、pipeline の step は marker 行。feature の識別子は owner block 内に置き、base/feature/DB の import 境界を守る。
- テストの `expect` は必ず `it` のコールバック本体に書く。共通 helper、test-support、`describe`、`beforeEach` / `beforeAll` / `afterEach` / `afterAll` では呼ばない。helper は準備・操作・値の返却に限り、型・エラー・status・redirect 等の検証を呼び出し元へ移す。`expect.any` 等の非対称 matcher も本体内で作る。Playwright の `test` と `playwright-bdd` の登録済み `Given` / `When` / `Then` は、その runner のテスト本体として同じ規則を適用する。`.github/scripts/lint-expect-scope.mjs`（`pnpm run lint`）で helper を含めて全件確認する。
- 題材だけで終わらず、棚卸しで見つけた同じ切れ目を持つ箇所も同じ方針に揃える。追えないものは理由付きの診断に残す。
- Hono を変えたら Next.js にも対応させる。`samples/` は手で直さず、CLI をビルドして `pnpm --filter "./samples/*" run generate` で再生成する。sample 固有の DB instance 等の境界を保つ。
- `apps/map/changes/` に関数別の意図と背景を書く。何を変えたか・どこへ届くかは地図に計算させる。必要なら `MAP_BASE=<PR の base> pnpm --filter @maronn-openid-connect/map changes:draft` を使う。
- 新しい規則は lint か地図の出力検査で支え、`apps/map/docs/design-change-trail-and-decision-cases.md` の「貢献者に課す規則」に理由と検査を書く。注意書きだけで維持しない。
- core の破壊的変更は changeset に記載する。継承した feature の変更と、今回追加した修正の互換性を区別する。

## 修正後を検証する

PR の base を指定して再び `build:map` を行い、同じ読み取り方で修正前後を比べる。対象の処理への道筋、必要な feature、interface の実装の橋、同型の全候補が追えるか理由付き未解決かを実データで示す。通常ビルドだけで PR の reach を検証したことにしない。

共通資料と repository が求める lint、typecheck、package/app tests、CLI matrix を実行する。解析を変える場合は、直接呼出し・interface 実装・callback 登録と実行・匿名契約・型不明の context・初期化を区別する意味のある検査を用意する。モデルを変えたら表示と出力検査も更新する。

検査が通った後は、新しい変更や未解決の懸念がない限り同じ検査を繰り返さない。失敗・未実行・環境制限を報告から落とさない。

## 引き渡す

地図の根と境界、切れ目の分類と全件一覧、設計比較と選択理由、前後の出力、失敗した検査と対処、残る未解決と理由を示す。PR を依頼されていれば、検査・生成を完了して確認したマージ先へ作成または更新する。説明は最終的な問題・振る舞い・検証・互換性に合わせる。

レビューを別工程で行うときは `provider-map-review` を使う。実装者自身の計測や報告を、そのまま独立レビューの検証結果として扱わない。
