# 配線の全件監査

[調査・設計・検証の報告](report.md) に、地図の境界、分類、設計比較、前後の出力、失敗ログと未対応の範囲をまとめた。

対象の関数名を検索せず、TypeScript AST と型から配線になりうる形を探す。
一覧には、すでに追える interface 実装や普通の配列 callback も含まれる。
題材の修正だけで見つかった問題を閉じたことにしないため、広く集めて地図の実データと照合する。

- `before.json`: `ef250f1`（`claude/upbeat-faraday-64u0g7`）の全候補と、変更前の地図の出力を照合した結果。
- `after.json`: 修正後の全候補と、修正後の地図の出力を照合した結果。
- 各行は `kind`, `file`, `line`, `end` で候補を特定する。完全なコードはそのソースで読む。
- `traced` は実際の呼び出し先、interface の実装の対応、展開された callback の木、endpoint の根、または解決済みの `map.wiring` を根拠にする。単に関数の行に含まれるだけでは `traced` にしない。
- `untraceable` は地図に出た未解決の配線または call node を `evidence` に記し、地図の `why` を残す。
- `outside-map-roots` は `packages/cli/extract.json` の生成 OP の入力範囲外。CLI と地図自身、外側のアプリの起動・設定・operator を OP endpoint に届くと推測しない。
- `uncovered` は地図のどの出力にも明示されない候補。変更前の欠落の記録として残すが、変更後の監査はこの状態があれば非ゼロで終了する。

```sh
# 依存を用意して地図をビルドする
pnpm install
pnpm run build:map

# 現行ソースから全候補を探し、ビルドした地図で全件を照合する
node scripts/audit-wiring.mjs --output work/wiring-inventory.json
node scripts/check-wiring-audit.mjs \
  work/wiring-inventory.json apps/map/public/data/map.json work/wiring-coverage.json

# 作業ツリーの編集を含めず、指定 revision の候補を再現する
node scripts/audit-wiring.mjs --ref ef250f1 --output work/wiring-inventory-before.json
```

`--ref` はその revision の対象ソースを `git archive` で `work/inventory-before-repo/` に取り出し、TypeScript の仮想ファイルとして読む。
依存の解決に使うパスは通常のリポジトリと同じなので、並行編集中のソースを混ぜずに before/after を比較できる。
型 API の失敗は `typeErrors` に記録する。失敗があったデータを全件調査の根拠には使わない。

調べる形は、型が `any` の受信者の `.set`、module 初期化の呼び出し、callable な module 値、メソッドを持つ object の return、関数値の property、callable 引数、middleware/route/hook の登録である。
動的キーの `.set` には context から取ったストアへの業務データ保存も入る。地図の call target がその store の interface member を指すことを確認して区別する。
普通の native iteration の callback には repository の関数呼び出しを持たないものもある。その場合も host statement と callback source が出ることを確認し、その根拠を行に残す。

到達の比較は次で再現できる（解析パッケージのビルド後）。第4引数の正規表現は表示対象を選ぶだけで、配線の探索・到達計算の規則ではない。

```sh
node scripts/inspect-map-wiring.mjs work/map-before work/map-before-report.json 'ClientJwksUri|#withRegisteredClientJwksUri$'
node scripts/inspect-map-wiring.mjs apps/map/public/data work/map-after-report.json 'ClientJwksUri|#withRegisteredClientJwksUri$'
```

`after.json` は解析コミット後の作業ツリー（規則・検査も含む）の記録である。`revision` はその時点の HEAD、`workingTree: true` は未コミットの変更を含めて読んだことを示す。`map-after.json` は PR 差分付きの実出力を読む。

`build:map` は `check:wiring` も実行し、全候補に木・実装の橋・理由付き診断のどれも無いと失敗する。先に実際の追跡根拠を調べ、保守的な wiring 診断はその後の根拠として使う。範囲外は生成 OP の根を広げず理由を残す。
