# エンドポイントから読める処理と、追えない配線

## 調べた地図の境界

この設計は `claude/upbeat-faraday-64u0g7` の `ef250f1` を基準に、実際の `build:map` の出力を読んで選んだ。題材はクライアントの `jwks_uri` だが、規則と解析はその名前を条件にしない。

CLI の `extract.json` は core・experimental・google-login・hono・nextjs の範囲を定める。関数カタログはその範囲のトップレベルの `function` 宣言を読む。CLI の explain は endpoint の step 関数とその calls を根にする。flow は endpoint/step の meta と機能の contribution から作り、Next.js の step の calls は Route Handler の marker block から読む。

apps/map は同じカタログを受け取るが、実行トレースの根は Hono の handler/pipeline 本体、Next.js の Route Handler/Server Action である。`createApp` や `setRequestContext`、module initializer は自動では根にならない。根を決めるのは `packages/map-analysis/src/analyze.ts`、解析するファイルと package exports の source への付替えは `roots.ts` である。

`resolve.ts` は TypeScript の symbol から import・alias・re-export を解決し、receiver の型から interface/type/class のメンバーを引く。Hono の any context は literal-key `c.set()` の値の型を集めて補う。ただし型は、どの factory が値を作ったか、どの middleware がどの順に実行されるかを証明しない。

object literal の callable property は contextual type のメンバーの実装として `FlowTree.implements` に載る。`impact.ts` は実際の call node とメンバー実装が呼ぶものを結び、endpoint からの経路と必要な feature を求める。アプリの実装はそのアプリの source にだけ効く。この結び付けは interface 単位の保守的な近似であり、同じ型の実装のうちどの instance が選ばれるかまでは証明しない。

`FunctionEntry.calls` には CLI との整合のため deferred の呼び出しも入る。したがって、その配列だけを再帰探索して「エンドポイントから実行される」と報告してはいけない。根、frame の nodes/sites、implements、member、PR の changes.reach を読む。データの定義は `packages/map-analysis/src/model.ts`、`apps/map/src/types.ts` はその再輸出である。

## 題材で切れた理由

1. **根の外で振る舞いを組み立てる**。Hono は request context へ wrapper を格納し、Next.js は module initializer で wrapper を作る。endpoint が受け取る resolver の型から、その構築処理へ戻る辺はない。
2. **匿名の callable contract**。`withClientJwksUriKeys` と `resolveRequestObjectParams` の options は inline type で、旧 resolver はメンバーの owner 名を作れなかった。
3. **contextual type を失う**。Next.js の中間 object は型がなく、後で spread して渡しても最初の callback 定義と interface のメンバーは結び付かなかった。
4. **関数値を呼ぶ／登録する**。引数・context から取った callable、名前で渡した callback、module-level arrow は通常の function call と同じには解決できなかった。旧地図は一部を「追えない」とも示さず消していた。
5. **登録と実行を混同する**。任意の API に渡す inline callback を即時に動く array callback と同じ木にすると、起動時登録のコードが実行経路に混ざる。登録だけでは実行順や適用先は分からない。

同じ形の全件は、このディレクトリの `wiring-audit/` と棚卸しスクリプトで再現する。対象外のアプリの入口や CLI/解析ツール自身は、除外理由を付けて区別する。

## 比較して選んだ案

| 案 | endpoint から core | 機能除去・生成 | Hono/Next 共通性 | 規則・不確実性・手書き到達先 | 判断 |
| --- | --- | --- | --- | --- | --- |
| (a1) 値の provenance を別グラフにする | 構築元も遡れる | owner と instance ごとのデータフローが必要 | 中核は共通、context/module は別 | 手書き不要。alias、mutation、動的 key の境界に診断が必要 | instance の精密さに比べ実装範囲が大きく、今回は採らない |
| (a2) middleware と初期化を endpoint の根に合成 | 根の外も表示できる | route/filter 順序と feature の適用を再現する必要 | framework ごとの semantics が必要 | 不確実な mount を実行経路と断定しやすい | 採らない |
| (a3) 型付き member/callback の橋と診断を強める | 型で判明した橋を渡る | owner block/import はそのまま | 共通の compiler 解析 | 未解決は場所・理由付き。手書きの到達先不要 | **採用** |
| (b1) 振る舞いを endpoint が呼ぶ helper に置く | 準備から core まで直接辿れる | 機能 helper は owner block から呼ぶ | 両方に同じ形を写せる | 重複せず、小さな function 宣言規則を lint する | **採用** |
| (b2) context 全体を型付き DI にする | 値の型は分かるが構築元は分からない | 大幅な生成器/API の変更 | 共通化可能 | 型安全だけでは今回の切れ目を閉じない | 単独では採らない |
| (b3) 各 endpoint へ wrapper を展開する | 直接辿れる | owner block ごとの重複が増える | 写しも増える | 配線漏れを新しく生む | 採らない |

題材は (b1) により endpoint 側が `getClientKeyResolver` を呼ぶ。context/provider には元の adapter と設定・fetch の選択を置き、振る舞いは helper が組み立てる。キャッシュは引き続きプロセスで共有する。既定の認証や JWKS 変換を context の匿名 closure に隠す形も同じ方針で整理する。公開 callable の実体は `function` 宣言に揃える。

残る feature context hook、middleware、module initializer、任意の callback は、無理に実行トレースへ混ぜない。(a3) は型で分かる callback/member を結び、分からない配線を `map.json.wiring` に場所・種類・コード・理由付きで残す。画面の「追えない配線」と PR のデータから確認できる。これは unknown をゼロと答える代わりに境界を出すもので、解析が正確な到達先を計算できたという意味ではない。

## 継続して確かめる

既存の function 宣言規則を AST lint で検査する。新しい middleware や callback を一律禁止したり、`affectsEndpoints` のような到達先の注釈を要求したりしない。地図の検査は、未解決の呼び出しと配線に理由・場所があり、解決済みとするなら根拠を持つことを確かめる。解析の regression test は登録と実行、callable alias、typed object と型を失った object を区別する。

持続用の手順は `skills/provider-map-traceability/SKILL.md` に置く。PR ごとに build 出力をスクリプトで読み、before/after と未解決の一覧を残す。変更メモには意図を書き、到達先は地図が計算する。
