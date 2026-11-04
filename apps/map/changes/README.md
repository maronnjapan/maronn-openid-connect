# 変更メモ

PR の地図（`map-preview.yml` が PR ごとに出す OIDC Provider Map）は、その PR が変えた関数とエンドポイントの処理本体ごとに、何を変えたかとどこに効くかを計算して見せる。
変更メモには、地図が計算できない意図と背景を書く。

| 問い | 答えるもの |
|---|---|
| 何を変えたか | 地図。処理の流れの木の差分から作る要約（「条件 `expiresAt <= now`: `<` を `<=` に変えた」）と差分 |
| どこに効くか | 地図。届くエンドポイント、そこまでの経路と決定、要る機能、外へ出る失敗の変化とそれを捕まえる場所、型で追えない呼び出し |
| なぜ変えたか、何に気をつけるか | 変更メモ |

## いつ書くか

関数カタログの関数（`packages/core`、`packages/experimental`、`packages/google-login`、`apps/hono`、`apps/nextjs` の関数）か、エンドポイントの処理本体（hono の pipeline のハンドラー、Next.js の Route Handler）のコードを変える PR では、このディレクトリに Markdown を 1 つ足し、変えた関数ごとに節を書く。

地図のビルドは、コードを変えた関数で節の無いものを「説明の無い変更」として、PR のコメントと地図の「このPRの変更」の先頭に並べる。
そのうち、エンドポイントに届く関数とエンドポイントの処理本体に節が無いと、地図のビルド（CI）が落ちる。
store や resolver の実装は、そのメンバーを呼ぶところを通ってエンドポイントに届く（`apps/hono` の実装は Hono・Express・Fastify、`apps/nextjs` の実装は Next.js のエンドポイントにだけ届く）。
どのエンドポイントにも届かない関数、コメントや書き方だけを変えた関数（処理の流れの木が同じもの）、型で追えない呼び出しのほかからは届かない関数は、一覧に出るだけで、ビルドは落ちない。
節の本文の質は検査しない。

## 雛形を作る

節の雛形はコマンドで作れる。

```bash
MAP_BASE=origin/main pnpm --filter @maronn-openid-connect/map changes:draft
```

`MAP_BASE`（省略すると `origin/main`）からの差分で、コードを変えた関数のうち、まだ節の無いものごとに節を書く。
書き込む先は、そのブランチがすでに足している変更メモか、なければ `apps/map/changes/<ブランチ名>.md` である。
引数でファイルを指定することもできる（`pnpm --filter @maronn-openid-connect/map changes:draft apps/map/changes/x.md`。リポジトリのルートからのパス）。

```md
## validateUserInfoTokenExpiration <!-- core:userinfo.ts#validateUserInfoTokenExpiration -->

<!-- 自動要約: 条件 `tokenInfo.expiresAt <= now`: `<` を `<=` に変えた -->
<!-- 届く先: hono:userinfo, nextjs:userinfo -->
<!-- なぜ変えたか、何に気をつけるかを書く（何を変えたかとどこに効くかは地図が出す） -->
```

見出しの HTML コメントがその関数の id で、自動要約と届く先は参考として HTML コメントで添える。
HTML コメントだけの節は説明の無い節として数えるので、コメントの下に意図を書く。
生成した節を消すと、同じ検査がまた「説明の無い変更」として挙げる。

## 書き方

ファイル名は自由で、PR ごとに新しいファイルを足す（例: `claims-allowlist.md`）。
最初の `##` 見出しより前に PR 全体の説明を書き、`##` 見出しごとに関数の意図を書く。

````md
# UserInfo のトークンの期限の境界をそろえる

UserInfo とイントロスペクションで、期限の時刻ちょうどのトークンの扱いをそろえる。

## validateUserInfoTokenExpiration <!-- core:userinfo.ts#validateUserInfoTokenExpiration -->

期限の時刻からは受け付けない（RFC 7519 §4.1.4 の `exp` と同じ）。
これまでは同じ瞬間に、UserInfo はトークンを受け付け、イントロスペクションは inactive と答えていた。

## token <!-- endpoint:token -->

未対応の `grant_type` を、クライアント認証の後で拒否する。

## verifyClientSecret

比べる時間が値によって変わらないようにした。

## 背景

利用者が自分で書いた resolver では、この関数が唯一の期限の確認になる。
````

- `##` 見出しには関数の名前を書き、複数の関数はカンマで並べる。名前に続く `()`、バッククォート、名前の後ろの言葉は読み飛ばす
- 見出しに `<!-- id -->` があれば、その id の関数（またはエンドポイントの処理本体）だけに付く。エンドポイントの処理本体の id は `endpoint:<エンドポイント>`（`## token <!-- endpoint:token -->`）、Next.js の Route Handler は関数と同じ id（`nextjs:app/token/route.ts#token`）である
- 名前だけの見出しは、その PR が変えた同じ名前の関数すべてに付く。二つ以上に当たるときはビルドが警告し、当たった id を並べる。当たった関数のルート（core、experimental、google-login、hono、nextjs）が違えば `core:verifyClientSecret` のようにルートを付けて絞り込める。同じルートにあるときは、見出しに `<!-- id -->` で id を書いて絞り込む
- 関数の名前でない見出し（`背景` など）は、PR 全体の説明として表示する
- 英字で始まる見出しの名前に合う関数が無いときは、ビルドが警告する（`"<名前>" names no function of the catalog`）
- コードを変えていない関数の名前を書くと、その関数は「メモ」の札で一覧に加わる。呼び方を変えた関数の説明を、呼ばれる側に残したいときに使う
- 本文には段落、`-` の箇条書き、コードブロック、`` `code` `` を書ける。段落の改行はそのまま表示し、HTML コメントは表示しない

## 地図が読む範囲とマージ後

地図が読むのは、その PR が足したり書き換えたりした変更メモだけである。
マージしてもファイルは消さずに残す。
後の PR の地図には出ないので、残っていても邪魔にならない。

ローカルでは、比べる相手を `MAP_BASE` に渡して地図を作ると、作業ツリーの変更（コミットしていないものを含む）が同じように表示され、検査も同じように走る。

```bash
pnpm --filter @maronn-openid-connect/cli build
pnpm --filter @maronn-openid-connect/map-analysis build
MAP_BASE=origin/main pnpm --filter @maronn-openid-connect/map dev
MAP_BASE=origin/main pnpm --filter @maronn-openid-connect/map build
```

メモを書き足したあとは、開発サーバーを動かしたまま `MAP_BASE=origin/main pnpm --filter @maronn-openid-connect/map data` でデータだけを作り直し、ページを読み込み直せば載る。
