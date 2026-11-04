# 配線の地図化: 調査・設計・検証報告

棚卸しと配線の修正前後比較の調査基準は `claude/upbeat-faraday-64u0g7` の `ef250f1`。PR のマージ先は `main` であり、main に未反映の背景ブランチの `jwks_uri` / `request_object_signing_alg` 対応も含む。コミットは、コードの形（`71627ac`）、解析・画面（`ecf04a2`）、規則・検査・skill・記録の順に分けた。

## 地図が根にするもの、型で辿るもの、辿らないもの

CLI のカタログは extract.json が定める core・experimental・google-login・Hono・Next.js のトップレベル function 宣言を読む。explain は endpoint の step 関数とその calls を根にする。flow の endpoint/step は meta と feature contribution、Next.js の block calls は marker block が出どころである。

apps/map の実行トレースの根は Hono の handler/pipeline と Next.js の Route Handler/Server Action。TypeScript の symbol、import/re-export/alias、receiver の interface、contextual object の実装を辿る。Hono の any context は c.set の値の型で補う。影響範囲は実際の call node と interface 実装の呼び先から計算し、アプリの実装は同じ source に限る。

値を構築した factory、middleware の実行順・mount、動的な context key、module initializer、外部 callback の実際の実装は、この型グラフだけでは証明できない。`FunctionEntry.calls` に含まれる deferred を実行の辺と誤読してはいけない。今回のスクリプトは frame の nodes、implements、member と CallGraph / reachOf を読む。

読んだ実装と設計比較の詳細は [design-traceable-wiring.md](../design-traceable-wiring.md)。データの定義は model.ts、apps/map/src/types.ts はその再輸出で確認した。

## 題材の切れ目と分類

1. context/provider の構築元が endpoint の根の外にある。
2. callback options の匿名型に、interface メンバーとして辿れる名前がない。
3. 中間 object と spread/defaulted options で contextual type の結び付きが失われる。
4. 関数引数、indexed callable alias、名前で渡す callback が普通の呼び出し先にならず消える。
5. callback 登録を即時実行と見なすと、根拠のない経路を作ってしまう。

`pnpm install` と `pnpm run build:map` の後に before を保存し、[inspect-map-wiring.mjs](../../../../scripts/inspect-map-wiring.mjs) で読み取った。画面の目視や関数名の検索だけで到達を判定していない。

## 同じ形の全件一覧

全候補は [before.json](before.json) と [after.json](after.json)。各項目に種類、ファイル、開始・終了行、判定と実際の出力上の根拠を持つ。題材の名前ではなく、AST と callable の型で探した。スキャン対象は apps/hono/src、apps/nextjs/src と packages の本番用 TypeScript（テスト・fixture・生成物を除く）。

| 形 | 修正前 | 修正後 |
| --- | ---: | ---: |
| literal key の any-context 書込み | 27 | 26 |
| 動的 key の any receiver .set | 18 | 18 |
| モジュール直下の初期化呼び出し | 222 | 221 |
| モジュール直下の関数値 | 9 | 3 |
| メソッドを含む戻り値 object | 42 | 42 |
| 関数値を持つ property | 139 | 141 |
| 関数値を渡す引数 | 897 | 915 |
| middleware / route / hook の登録 | 11 | 11 |

修正前は 546 ファイル、1,365 候補。生成 OP の範囲内は 734 箇所で、284 箇所に追跡根拠があり、450 箇所は無表示だった。範囲外の 631 箇所は CLI・解析器自身・外側のアプリの設定や起動などで、除外理由を明示している。

修正後は 548 ファイル、1,377 候補。生成 OP の範囲内 726 箇所は **307 箇所が追跡可能、419 箇所が理由付きの未解決、無表示 0 箇所**。残る 651 箇所は範囲外で、すべて理由付き。型 API の失敗は両スキャンとも 0 件。ソースとツール自身の増減も含むため、前後の総数は同じではない。

同じ修正を行ったのは、既定のパスワード認証、ID Token 検証鍵の供給、同意と関連トークンの失効、ID-JAG/ACR/offline_access の公開関数値、DCR の匿名 resolver 制約である。すでに型で結び付く store/resolver は維持し、残る middleware・feature hook・初期化を無理に endpoint の呼び出しへ変換していない。

## 選択した設計

**(b1) endpoint が呼ぶ型付き helper + (a3) 型付き callback の橋と明示的な未解決診断**を選んだ。

値の provenance を全追跡する案、framework ごとに middleware/初期化を根へ合成する案、context 全体の DI 化、wrapper を各 endpoint へ展開する案とも比較した。前二者は instance・mutation・route filter の意味を新しく解析する規模が大きい。DI だけでは値の構築元が隠れたまま。各 endpoint への展開は重複と owner 管理を増やす。

選択案は Hono と Next.js の両方で同じ形にでき、feature owner block と import 境界を保つ。型で core へ辿り、動的な境界には理由を出し、到達先を手書きする注釈を増やさない。既存 function 宣言規則は AST lint で機械的に検査する。生成・機能削除は 112 構成の matrix で確認した。

比較の全基準と不採用理由は [設計表](../design-traceable-wiring.md#比較して選んだ案) に記した。

## 修正前後の地図の出力

[map-before.json](map-before.json) と [map-after.json](map-after.json) は、実際の木と型の辺を読んだ出力。factory 自身と、それが返したメンバーの実装への到達を分けている。

| 観測対象 | 修正前 | 修正後 |
| --- | --- | --- |
| Hono withRegisteredClientJwksUri | 到達 0 | Hono/Express/Fastify の authorize、resolve-request-object から到達 |
| Next.js withRegisteredClientJwksUri | 到達 0 | Next.js authorize から到達 |
| 両アプリの hostOf と読込設定 helper | 到達 0 | それぞれの authorize から到達 |
| ClientJwksUriCache.load の実装 | 到達 0 | Hono と Next.js の authorize、request-object が必要 |
| createClientJwksUriCache の構築自体 | 到達 0 | 到達 0。モジュール初期化として診断に残す |
| 関数 / endpoint 本体 / member | 1059 / 19 / 146 | 1070 / 18 / 200 |
| 未解決の call node | 14 | 35。以前は消えていた callable を理由付きで表示 |
| 配線の診断 | なし | 1014 箇所。型の実装の辺とは別に保守的に列挙 |

cache までの型の橋は、ParseRequestObjectOptions.loadJwks → ResolveRequestObjectOptions.loadJwks → ClientKeyResolver.findClientKeys → ClientJwksUriKeyOptions.load → ClientJwksUriCache.load。defaulted optional options、spread での受渡し、NonNullable の indexed callable を含む。repository test が実際の両アプリの経路と必要 feature を検査する。

配線変更だけの比較（MAP_BASE=origin/claude/upbeat-faraday-64u0g7）では、getClientKeyResolver、callback contract の変更に到達先があり、変更 30 フレーム、説明不足 0、変えた行のノード外 0 を確認した。PR に手書きの到達先は加えていない。

マージ先 main 基準でも `MAP_BASE=origin/main pnpm run build:map` を実行した。変更 87 フレーム、説明不足・変更行のノード外・無効な診断は 0、全候補照合も通過した。unknown / ambiguous な変更メモも 0。[main 基準の出力要約](main-base-check.json) に比較対象と件数を保存した。

## 検証結果

| 検査 | 結果 |
| --- | --- |
| pnpm install（10.17.0） / root build | 通過 |
| PR 差分付き build:map / 地図出力検査 / 全件照合 | 通過。1088 フレーム、4127 選択、名前なし・重複・行の欠落・説明不足・無効な診断 0 |
| lint / 全 workspace typecheck | 通過（packages・apps・samples・tests） |
| core / experimental / google-login / CLI / map-analysis | 1536 / 796 / 130 / 265 / 135 テスト通過 |
| Hono / Next.js / map | 1699 / 715 / 237 テスト通過 |
| CLI test:matrix | 112 構成すべてコンパイル |
| .github scripts / conformance の設定スクリプト | 271 / 24 テスト通過 |
| samples | 4 framework すべて既存 generate コマンドで再生成、typecheck 通過 |

途中の失敗出力、原因、修正と再実行は [failures.md](failures.md) に記した。主なものは旧 fixture の配線前提、古い dist、async 型、localhost の待受け権限、scanner の shorthand、診断順だけに依存したテスト、環境の同期子プロセス制限である。失敗を成功扱いしたり、検査を外したりはしていない。

## 継続用 skill と行わなかったこと

[実装用・レビュー用 skills](../../../../skills/README.md) を追加し、Codex の `.agents/skills` と Claude Code の `.claude/skills` にそれぞれ同じ正本へのシンボリックリンクを置いた。各 skill の本文とメタデータは一つのファイルだけを編集すれば両方に反映される。修正前出力の保存、形による全件探索、設計選択、別コミット、両アプリと生成器の検査、PR の reach と未解決の証拠まで手順化している。既存 function 宣言規則の lint、map 出力の理由・場所検査、build:map の全候補照合が継続を機械的に支える。

配布 CLI に TypeScript 解析器を同梱する変更は行っていない。厳密な型の解決は従来どおり地図ビルド側で行う。

instance 単位の値の provenance、middleware の正確な route/mount 順序、外部コード・動的 key・任意 callback の実装推定は行っていない。interface 単位の保守的な結び付けを保ち、不確実なところは診断とする。生成 OP の入力外のアプリ入口や CLI/解析ツール自身を OP の endpoint と混同していない。

配線修正の追加分では core の実行時 API と公開 callback の戻り値型を保ち、core/CLI の patch changeset を追加した。main との差分全体には、背景ブランチから継承した `jwks` オプションと `DEFAULT_REQUEST_OBJECT_SIGNING_ALGS` の削除などの破壊的変更も含む。移行方法は既存の core minor changeset と `client-jwks-uri.md` に記載済みであり、追加の patch だけで PR 全体のバージョン変更を表していない。Hono 内部 context の旧既定 callback を直接差し替える利用と、Next.js の素の clientKeyResolver の利用は新しい helper を通す形へ移る。ブラウザ E2E と外部 OIDF 実環境テストは今回指定されたパッケージ検査とは別であり実行していない。公開・デプロイ・マージは行っていない。
