# 変更メモ

PR の地図（`map-preview.yml` が PR ごとに出す OIDC Provider Map）は、その PR が変えた関数に札を付け、ここに書いた説明を表示する。
関数カタログの関数（`packages/core`、`packages/experimental`、`packages/google-login`、`apps/hono`、`apps/nextjs` の関数）を変える PR では、このディレクトリに Markdown を 1 つ足し、どの関数をどう変えたかを書く。

## 書き方

ファイル名は自由で、PR ごとに新しいファイルを足す（例: `claims-allowlist.md`）。
最初の `##` 見出しより前に PR 全体の説明を書き、`##` 見出しごとに関数をどう変えたかを書く。

````md
# クレーム名のアロウリスト

`claims` パラメータで要求できるクレーム名をアロウリストで絞る。

## applyRequestedIdTokenClaims

アロウリストに載っている名前だけを ID Token に足すようにした。
アロウリスト外のクレームはエラーにせず省く。

## getRequestedClaimNames, applyRequestedClaims

UserInfo も同じアロウリストで絞る。

## 背景

resolver が返した余分なフィールドが、scope を迂回して開示されていた。
````

- `##` 見出しには関数の名前を書き、複数の関数はカンマで並べる。名前に続く `()`、バッククォート、名前の後ろの言葉は読み飛ばす
- 名前だけの見出しは、その PR が変えた同じ名前の関数すべてに付く。一つに絞るときは `core:verifyClientSecret` のようにルート（core、experimental、google-login、hono、nextjs）を付けるか、`core:client-auth.ts#verifyClientSecret` のように id で書く
- 関数の名前でない見出し（`背景` など）は、PR 全体の説明として表示する
- コードを変えていない関数の名前を書くと、その関数は「メモ」の札で一覧に加わる。呼び方を変えた関数の説明を、呼ばれる側に残したいときに使う
- 本文には段落、`-` の箇条書き、コードブロック、`` `code` `` を書ける。段落の改行はそのまま表示する

英字で始まる見出しの名前に合う関数がないときは、地図のビルドが警告を出す（`"<名前>" names no function of the catalog`）。

## 地図が読む範囲とマージ後

地図が読むのは、その PR が足したり書き換えたりした変更メモだけである。
マージしてもファイルは消さずに残す。
後の PR の地図には出ないので、残っていても邪魔にならない。

ローカルでは、比べる相手を `MAP_BASE` に渡して地図を作ると、作業ツリーの変更（コミットしていないものを含む）が同じように表示される。

```bash
pnpm --filter @maronn-openid-connect/cli build
MAP_BASE=origin/main pnpm --filter @maronn-openid-connect/map dev
```
