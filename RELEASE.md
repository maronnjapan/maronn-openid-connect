# リリース手順

このリポジトリの npm publish は **Changesets + GitHub Actions（`.github/workflows/release.yml`）** で自動化されている。
publish は **npm Trusted Publishing (OIDC)** を利用し、長期トークン（`NPM_TOKEN`）を一切持たない構成。

対象パッケージ:

- `@maronn-oidc/core`
- `@maronn-oidc/cli`
- `@maronn-oidc/experimental`

通常のリリース運用（changeset を貯めて Version Packages PR をマージすると publish される二段階フロー）は
`release.yml` 冒頭のコメントを参照。本ドキュメントは **publish を成立させるための初期セットアップ**を扱う。

---

## バージョニング方針

### 前提: experimental は core より速く publish する

`@maronn-oidc/experimental` は新しい仕様を先行実装する場所なので、**core が同じバージョンに
留まったまま experimental だけが何度も publish される**運用を想定する。バージョン番号を
両者で揃える運用（Changesets の `fixed` グループ）は採用しない。採用すると experimental を
1回 publish するたびに **コード変更のない core が別バージョンとして再 publish される**ため、
安定性をシグナルとして売る core のバージョンが無意味に流れてしまう。

したがって次の状態が正常である。

```
@maronn-oidc/core          0.1.0   （据え置き）
@maronn-oidc/experimental  0.0.1 → 0.0.2 → 0.0.3 → …（先に進む）
```

### experimental の bump は常に patch に固定する

`@maronn-oidc/experimental` は**変更内容に関わらず patch を 1 つ上げるだけ**とする。
API の追加でも破壊的変更でも minor / major は使わない。これは experimental のリリースを
「`packages/experimental/src` が変わったら publish する」という機械的な運用
（→ [experimental の自動 publish](#experimental-の自動-publish)）に寄せるためで、bump 種別を
判断する余地をなくすことで、Version Packages PR のマージを忘れて複数の変更がたまっても
**まとめて patch 1 回に吸収される**状態を保つ。

そもそも experimental は package 名のとおり API の安定性を約束しない場所なので、
バージョン番号で互換性を表現しない。利用者に伝えるべき互換性の情報は CHANGELOG と
README に書く。安定性のシグナルは core が担う。

手書きの changeset が experimental を minor / major で上げていないかは
`pnpm run test:release-contract`（`.github/scripts/verify-release-contract.mjs`）が CI で検査する。

### core のインスタンスを 1 つに保つのは peerDependencies の役割

experimental は core の内部寄りの関数（`validateAuthorizationRequest`、
`resolveAuthenticatedTokenClient` など）を直接使い、core の `AuthorizationError` / `TokenError` を
`instanceof` で判定する。CLI 生成コードは同じ catch 節で core 由来と experimental 由来のエラーを
両方扱うため、**アプリ内に core のインスタンスが 1 つしか存在しないこと**が動作の前提になっている。

これは `packages/experimental/package.json` で core を `peerDependencies` にすることで担保する
（`dependencies` にすると core が二重にインストールされ、`instanceof` が静かに false になって
本来 `invalid_request` を返す場面が 500 になる）。バージョン番号の一致は必要ない。
peer なので、利用者のアプリが持っている core が experimental からもそのまま使われる。

### peer range は「下限」を宣言する

range は `>=0.1.0 <1.0.0`。これは「experimental が実際に要求する最低の core」を表す下限であり、
バージョン番号の一致を要求するものではない。したがって experimental が 0.5.0 まで進んでも、
core 0.1.0 のままで問題なく動く。

**下限は「次に publish される core のバージョン」以上でなければならない。**
experimental はモノレポ内の core（= 次に publish される core）だけを相手にビルド・テストされる。
それより古い core を下限に据えることは、**一度も試していない組み合わせを「動く」と宣言する**
ことに等しい。下限を上げておけば、古い core を使っている利用者のインストール時に
`unmet peer` が出て気づける。

この規則は `pnpm run test:release-contract`
（`.github/scripts/verify-release-contract.mjs` の `assertExperimentalCorePeerRangeCoversNextCore`）が
CI で強制する。未消化の changeset から次の core バージョンを計算し、下限がそれを下回っていれば
上げるべき値を添えて落ちる。

#### 上げ忘れると何が起きたか（実際の事故）

`@maronn-oidc/experimental@0.0.1` は core のステップ関数
（`extractClientCredentials` / `resolveAuthenticatedTokenClient` /
`validateClientAuthMethod` / `verifyClientSecret`）を import した状態で、下限を `>=0.0.1` の
まま publish された。これらを export する core は当時まだ publish されておらず、
`@maronn-oidc/core@0.0.1` との組み合わせがインストールできてしまい、利用者のバンドル時に

```
✘ [ERROR] No matching export in "node_modules/@maronn-oidc/core/dist/index.js"
  for import "extractClientCredentials"
```

で落ちた。モノレポの CI は常に HEAD の core に対して experimental をビルド・テストするため、
**この組み合わせはどのテストにも現れない**。下限だけが唯一の防波堤なので、CI で機械的に検査する。

caret（`^0.0.1` など）は使わない。semver では `0.0.x` の caret が完全一致扱いになるため、
core を minor 上げするだけで Changesets の「peer dependent は major で上げる」ルールが発火し、
**core も experimental も一気に 1.0.0 になってしまう**（実測で確認済み）。あわせて
`.changeset/config.json` に
`___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange: true`
を設定している。これがないと range が広くても major 昇格が起きる。
**このオプションは名前のとおり Changesets の patch リリースで変わり得るため、Version Packages PR の
diff で「意図しない 1.0.0 昇格が起きていないか」を必ず目視確認する。**

### core の minor / major では experimental も一緒にリリースする

range を広く取っている代償として、**core だけが先に進むと「公開済みの古い experimental が、
まだ組み合わせて試していない新しい core を受け入れる」状態**になる。モノレポの CI は常に
HEAD の core に対して experimental をビルド・テストするので開発時の破壊は検出できるが、
公開済みの組み合わせは検証されない。

そのため core を minor / major で上げる changeset があるときは experimental の changeset も
必須とし、`pnpm run test:release-contract`（`.github/scripts/verify-release-contract.mjs`、
`test:ci` に組み込み済み）で CI から強制している。同スクリプトは core が experimental の
`dependencies` に戻っていないかも検査する。

---

## experimental の自動 publish

`@maronn-oidc/experimental` だけは **changeset を手で書かなくてよい**。
`packages/experimental/src` に機能追加や実装修正が入った時点で publish できる状態になる。

### フロー

1. experimental の実装を変更した PR を main にマージする（`pnpm changeset` は不要）
2. main への push で `release.yml` が `.github/scripts/ensure-experimental-changeset.mjs` を実行し、
   前回リリース以降に `packages/experimental/src` が変わっていれば
   `.changeset/auto-experimental-patch.md`（`@maronn-oidc/experimental: patch`）を生成する
3. Changesets が「Version Packages」PR を作成・更新する（= publish 用の PR）
4. **その PR をマージすると publish される**

つまり publish するかどうかは「Version Packages PR をいつマージするか」だけで決まる。
core / cli の changeset を手で書く従来の運用はそのまま並存し、同じ Version Packages PR に集約される。

### 何を「変更」と見なすか

| 対象 | 自動 publish |
|---|---|
| `packages/experimental/src/**` の実装（`.ts`） | する |
| `packages/experimental/src/**` のテスト（`*.test.ts` / `*.spec.ts`） | しない（`dist` に出ず利用者への成果物が変わらないため） |
| `packages/experimental/package.json`・README・LICENSE | しない（必要なら `pnpm changeset` で patch の changeset を手で足す） |

比較の基準は **`packages/experimental/package.json` の `version` を最後に確定したコミット**。
`main` の**第一親**をたどった履歴で version が変わったコミット、つまり実際には
Version Packages PR のマージコミットがそれにあたる。version を確定したコミットが履歴に無い場合は、
追跡されている `src` 配下すべてを未リリース扱いにする。
この履歴判定のために `release.yml` の checkout は `fetch-depth: 0` にしてある。
shallow clone で基準点を辿れないときは、フォールバックに落ちずにスクリプトが失敗する
（後述の循環へ静かに戻るのを防ぐため）。

### なぜ version 確定コミットを基準にするのか

以前はこの基準を **publish 時に打たれる `@maronn-oidc/experimental@<version>` タグ**に置いていた。
これは循環していて、publish に一生到達しない。

```
タグが無い → 全 src が未リリース扱い → changeset が生成される
          → changesets/action は「未消化の changeset がある」と判断して version 段階へ
          → publish されない → タグが打たれない → 最初に戻る
```

Version Packages PR をマージしても、そのマージによる push で同じ判定が走り、
また changeset が生成されて次の Version Packages PR が立つだけになる。
`release.yml` は成功で終わり、PR もマージ済みなので、**npm だけが古いまま誰も気づけない**。
実際にこの状態で main は core 0.1.0 / cli 0.1.0 / experimental 0.0.3 まで進み、
npm は 3 つとも 0.0.1 で止まっていた。

タグが仮にあったとしても同じことが起きる。タグは前回 publish したコミットを指すので、
Version Packages PR のマージ直後でも「タグ以降に `src` が変わっている」状態は解消しない。
**publish の結果として生まれるものを、publish の前提条件にしてはいけない**。

version 確定コミットならこの循環が無い。version は Version Packages PR のマージ時点で確定し、
publish の成否に依存しないので、マージ直後の main では差分ゼロ = changeset を作らない
= publish 段階へ進む、と判定できる。publish が npm 側の理由で失敗した場合も、
version は確定したままなので次の push で publish が再試行される
（タグ基準では再試行されず、バージョンだけが空振りで上がり続けていた）。

#### 第一親でたどる理由

履歴は `git log --first-parent` でたどり、version は**第一親とだけ**比較する。
リリースブランチ側の "Version Packages" コミットを基準に選んではいけない。

```
*   Merge pull request #1        ← publish されるのはこのツリー。基準点はここ
|\
| * Version Packages             ← ここを基準にすると…
* | feat: b                      ← リリースブランチを切ったあとに main へ入った src が
|/                                  「未リリース」に見え、changeset が作り直される
* feat: a
```

`Version Packages` コミットのツリーはリリースブランチを切った時点のものなので、
切ってからマージするまでに main へ入った変更が差分に残る。実際には
マージコミットのツリーが publish されるので、その変更は確定したバージョンに載っている。
ここを未リリース扱いにすると version 段階へ戻され、**publish が 1 サイクル空振りする**
（デッドロックではなく次のサイクルで収束するが、症状は「マージしたのに publish されない」で
本来のバグと見分けがつかない）。

### マージを忘れて変更がたまったとき

生成する changeset は常に `auto-experimental-patch.md` の 1 本だけで、実行のたびに
「未リリースの変更一覧」で上書きされる。したがって Version Packages PR をマージしないまま
機能を 3 つ積んでも、**bump は patch 1 回のまま**で、CHANGELOG には 3 つ分の変更が並ぶ。

手書きの experimental changeset が未リリースで残っているときは、自動生成はスキップする
（人が書いたリリースノートを上書きしないため）。この場合も changeset は 1 本なので patch 1 回に収まる。

### スクリプトを 2 か所で実行している理由

`release.yml` では自動 changeset の生成を 2 回実行している。

- **`Ensure experimental release changeset` ステップ**: `changesets/action` は起動時に
  「未消化の changeset があるか」を見て version 段階と publish 段階を切り替える。
  この判定より前に changeset を置かないと、version 段階に入らず publish 段階へ抜けてしまう。
- **`ci:version` の中**: `changesets/action` は release ブランチを作り直してから version コマンドを
  実行するため、その過程で生成物が失われても changeset が残ることを保証する。

スクリプトは冪等（同じ状態なら同じ内容を書くだけ）なので、2 回実行しても changeset は 1 本のままになる。

### core が 1.0.0 に到達したときの対応

core を major バージョンアップすると、Changesets が peer range を自動的に `>=1.0.0` へ
書き換える（実測で確認済み）。この時点で 0.x 系特有の caret 問題は解消するので、
range を `^1.0.0` に切り替え、`onlyUpdatePeerDependentsWhenOutOfRange` を外すかどうかを判断する。

---

## publish に流れ込む前の検証ゲート

`release.yml` は `main` への push を起点に version / publish 段階を進める。
したがって **`main` が緑であること**が publish の前提になる。これを支えるのが `ci.yml` で、
以下の構成をとる。

| 検証 | 実行タイミング | 何を防ぐか |
|---|---|---|
| `pull_request: [main]` | main 向け PR | PR 経由の変更 |
| `push: [main]` | main への push | **PR を経由しない直接 push** が無検査で publish 経路へ流れること |
| `pnpm run build` | 上記の各実行 | ビルド破綻が `ci:publish`（publish 直前）まで露見しないこと |
| `pnpm run typecheck` | 上記の各実行 | vitest が transform で通してしまう型エラーの素通り |
| `pnpm run test:ci` | 上記の各実行 | 振る舞いの退行 |

`build` は `typecheck` より **前** に置く。`samples/*` と `packages/experimental` は
`@maronn-oidc/core` をビルド成果物（`dist` の `.d.ts`）として解決するため、
未ビルドだと `Cannot find module '@maronn-oidc/core'` で `typecheck` が落ちる。

このゲート構成自体（push トリガ / 実行順 / typecheck の網羅）は
`pnpm run test:ci-gate`（`.github/scripts/verify-ci-gate.mjs`）が検証する。
ゲートは「一度直せば終わり」ではなく、外されたときに気づけることが要件なので、
ステップを消す・順序を入れ替える・`typecheck` スクリプトを持たないパッケージを増やす、
のいずれもテストが赤になる。

### Lint を有効化していない理由

`packages/*` のどのパッケージにも `lint` スクリプトが無く、ルートの `pnpm run lint` は
対象 0 件のまま成功する。この状態で CI に `Lint` ステップを足すと
**常に緑で何も検証しないステップ**になり、かえって「lint 済み」という誤ったシグナルを出す。
そのため lint ツール導入までステップは追加しない。
将来 `pnpm run lint` を CI に足したときに実体が無ければ `test:ci-gate` が赤になる。

### ブランチ保護（要対応・リポジトリ設定側）

**結論: `main` のブランチ保護を有効化することを推奨する。** ワークフローの変更だけでは
「CI をすり抜ける経路」は塞げない。`push: [main]` は直接 push を**検知**するが、
壊れたコミットが `main` に入ること自体は止められず、`release.yml` は同じ push で動き出す。

GitHub のリポジトリ設定（コード管理外）で以下を設定する。

- `main` への直接 push を禁止する（Require a pull request before merging）
- 必須ステータスチェックに CI の `test` ジョブを設定する
- 有効化後は `main` へ直接 push できなくなる運用変更を伴う

---

## 全体像

npm の Trusted Publisher は「**そのパッケージが npm 上に既に存在していること**」を前提に設定する。
そのため publish は以下の順序になる。

1. **初回だけ**: ローカルから手動で publish して、パッケージを npm 上に作成する（→ [初回 publish](#初回-publish手動ブートストラップ)）
2. **npm 側で Trusted Publisher を設定する**（→ [Trusted Publisher の設定](#trusted-publisher-の設定次回以降のためのnpm側設定)）
3. **2回目以降**: GitHub Actions の OIDC publish だけで完結する（手動作業不要）

> organization 単位の Trusted Publisher を使える場合は 1 を省略できることがあるが、
> 確実なのはパッケージ単位設定なので、本手順では初回手動 publish を前提にする。

---

## 初回 publish（手動ブートストラップ）

各パッケージの **最初の 1 回だけ** ローカルから実行する。

### 前提

- npm アカウントが `@maronn-oidc` スコープ（organization）に publish 権限を持っていること
- 2FA を有効にしている場合は publish 時に OTP を求められる
- ローカルの Node / pnpm がリポジトリ指定バージョンであること（`pnpm@10.17.0`）

### 手順

```bash
# 1. npm にログイン（ブラウザ認証 or トークン）
npm login

# 2. 公開状態とバージョンを確認（private:true でないこと、access:public であること）
cat packages/core/package.json   # publishConfig.access = "public" を確認
cat packages/cli/package.json
cat packages/experimental/package.json

# 3. クリーンな状態でビルド
pnpm install --frozen-lockfile
pnpm run build

# 4. 各パッケージを publish（スコープ付きなので public 指定が必須）
#    experimental は core を peerDependencies で参照するので core を先に publish する
pnpm --filter @maronn-oidc/core         publish --access public --no-git-checks
pnpm --filter @maronn-oidc/experimental publish --access public --no-git-checks
pnpm --filter @maronn-oidc/cli          publish --access public --no-git-checks
```

> `--no-git-checks` は「コミットされていない変更があると pnpm publish が止まる」挙動を回避するためのもの。
> ブートストラップ時のみ利用し、通常リリースは CI に任せるので普段は使わない。

publish 後、npmjs.com に各パッケージのページが作成されていることを確認する。

- https://www.npmjs.com/package/@maronn-oidc/core
- https://www.npmjs.com/package/@maronn-oidc/cli
- https://www.npmjs.com/package/@maronn-oidc/experimental

> 初回手動 publish では provenance（来歴証明）は付かない。provenance は CI の OIDC publish で自動付与される。

---

## Trusted Publisher の設定（次回以降のための npm 側設定）

初回 publish でパッケージが存在する状態になったら、各パッケージに GitHub Actions を信頼させる。
**この設定をすると以降 `NPM_TOKEN` 不要で、CI から短命トークンで安全に publish できる。**

### 手順（パッケージごとに実施）

1. npmjs.com にログインし、対象パッケージページを開く
   - `@maronn-oidc/core`
   - `@maronn-oidc/cli`
   - `@maronn-oidc/experimental`
2. **Settings** タブ → **Trusted Publisher**（Publishing access）セクションへ
3. **GitHub Actions** を選び、以下を登録する

   | 項目 | 値 |
   |---|---|
   | Provider | GitHub Actions |
   | Organization / user | `maronnjapan` |
   | Repository | `maronn-oidc` |
   | Workflow filename | `release.yml` |
   | Environment | （未使用なので空欄） |

4. 保存する。3パッケージとも同じ内容で登録する。

> Workflow filename は **パスではなくファイル名のみ**（`release.yml`）。
> リポジトリ内の `.github/workflows/release.yml` と一致している必要がある。

### 補足: なぜトークンが要らないのか

- `release.yml` は `permissions.id-token: write` を付与しており、GitHub が発行する OIDC トークンを取得できる。
- npm 側の Trusted Publisher 設定と OIDC トークンの `repository` / `workflow` が一致すると、npm が短命の publish トークンを発行する。
- pnpm 10.17+ がこの OIDC trusted publishing に対応しているため、`changeset publish`（実体は pnpm publish）がそのまま通る。

---

## 2回目以降の通常リリース（参考）

ここまで設定すれば、以降は手動 publish は不要。

1. 機能 PR で `pnpm changeset` を実行し `.changeset/*.md` をコミットして main にマージ
   （`packages/experimental/src` の変更は changeset 不要。CI が patch の changeset を自動生成する
   → [experimental の自動 publish](#experimental-の自動-publish)）
2. Changesets が「Version Packages」PR を自動作成・更新（バージョンと CHANGELOG を集約）
3. リリースしたいタイミングでその PR をマージ → main への push で CI が npm へ publish

詳細は `.github/workflows/release.yml` の冒頭コメントを参照。

### changeset の書き忘れは CI が止める

上のフローは 1 の changeset が起点になっている。逆に言うと **changeset を書き忘れた変更は
Version Packages PR に現れず、publish されないまま main に埋もれる**。CI は緑、PR もマージ済みで、
気づく手がかりがどこにもないのが厄介な点。

そこで CI（`.github/workflows/ci.yml` の `changeset-coverage` job、実体は
`.github/scripts/verify-changeset-coverage.mjs`）が、**publish 可能なパッケージの出荷物を
変更した PR には対応する changeset があること**を必須にしている。
`packages/cli` にオプションを 1 つ追加した時点で、リリース導線が必ず立ち上がる状態になる。

| 変更内容 | changeset |
|---|---|
| `packages/*` の実装・`package.json`・README（= npm に出るファイル） | **必須** |
| `packages/*` のテスト・`CHANGELOG.md`・`vitest.config.ts` | 不要 |
| `samples/*`・`tests/*`・`docs/*`・リポジトリ直下の文書 | 不要 |

リリース不要と判断した変更は `pnpm changeset --empty` で空の changeset をコミットして通す。
空 changeset は `changeset version` がバージョンを上げずに消化するため、
「リリース不要と判断した」ことが diff に残りレビューに載る。この判断を明示的にしたいので、
ラベルや環境変数でチェックを飛ばす手段はあえて用意していない。

判定は「**その PR で追加された** changeset」だけを見る。main に溜まっている既存 changeset を
数えてしまうと、前の PR の changeset が今回の変更の CHANGELOG 記載を肩代わりして履歴が欠ける。

この job は次の 2 つの自動 PR では実行しない。

- **Version Packages PR**（head branch が `changeset-release/` 始まり）: changeset を消化する側なので、
  要求すると「changeset を消す PR が changeset を要求される」デッドロックになる
- **Dependabot PR**: 更新対象は `packages/*` の devDependencies で出荷物は変わらない
  （本リポジトリの `dependencies` は workspace 内部のみ、という CLAUDE.md の規約が前提）。
  publish が必要な bump だと判断したときは、担当者が手動で changeset を足す

### provenance の自動検証と手動確認

`release.yml` は publish が発生したとき、Changesets の `publishedPackages` に含まれる
正確な `name@version` を一時ディレクトリへインストールし、`npm audit signatures --json
--include-attestations` を実行する。署名検証に加えて、対象の各 `name@version` に
SLSA provenance v1 attestation が存在することを明示的に検査するため、registry signature
だけが有効で provenance が欠落している場合も release job は失敗する。

リリース担当者は job の成功に加え、npm の各バージョンページに provenance の緑色チェックが
表示され、次の4項目が意図した GitHub Actions 実行と一致することを確認する。

1. Build Environment
2. Build Summary（`release.yml` の該当 run）
3. Source Commit（リリース対象 commit）
4. Build File（`.github/workflows/release.yml`）

2026-07-21 時点では両パッケージを npm registry で照会すると `E404` であり、公開済み
version の provenance はまだ確認できない。初回 publish は手動ブートストラップのため
provenance が付かず、Trusted Publisher を設定した次の CI publish から上記の自動検証を必須とする。

### publish に到達したことを検証する

`release.yml` の最後に `.github/scripts/verify-release-published.mjs` を実行し、
**main の `packages/*/package.json` のバージョンが npm registry に存在すること**を確認する。
存在しなければ release job を赤くする。

これは「publish が失敗した」ではなく「**publish が起きなかった**」を検出するためのゲートである。
version 段階と publish 段階の分岐が壊れると、Version Packages PR をマージしてバージョンが
確定しても publish されず、それでいて run は成功で終わる。この状態は
provenance 検証（publish が起きたときだけ走る）でも changeset-coverage（PR 時点の検査）でも
検出できず、npm を直接見に行くまで気づけない。実際に
[なぜ version 確定コミットを基準にするのか](#なぜ-version-確定コミットを基準にするのか)の循環で
33 run にわたって気づけなかったので、分岐の実装ではなく **結果**を検査する形にしてある。

判定の細かい約束は 4 つ。

- 比較対象は main の commit に入っている `package.json`（`git show <sha>:...`）。
  `changesets/action` は version 段階でリリースブランチへ checkout するため、
  ワークツリーを読むとバンプ後のバージョンを読んでしまう
- **main の commit に未消化の changeset が残っているときは検査しない**。version 段階が
  正しい状態であり、publish は次の Version Packages PR のマージまで起きない。
  Version Packages PR のマージと changeset 追加が競合すると、バージョンだけ先に進んだ
  状態が一時的に生まれるため、ここを弾かないようにしてある。
  changeset も commit から読む（ワークツリーには `Ensure experimental release changeset` が
  書き出した changeset が居るので、それを数えると検出したい状態を見逃す）
- registry のほうが新しいのは publish 漏れではないので通す
- publish 実績がまったく無いパッケージは対象外。初回 publish は Trusted Publishing の
  chicken-and-egg で手動になるため（[初回 publish（手動ブートストラップ）](#初回-publish手動ブートストラップ)）

---

## トラブルシューティング

| 症状 | 原因 / 対処 |
|---|---|
| CI publish が `404` / `403` で失敗 | パッケージ未作成、または Trusted Publisher 未設定。初回手動 publish と npm 側設定を確認 |
| `Workflow does not match` 系エラー | npm の Trusted Publisher の Workflow filename が `release.yml` と一致しているか確認 |
| publish 後の `Verify published package provenance` が失敗 | npm の version ページで provenance を確認し、Trusted Publisher の repository/workflow 設定、`id-token: write`、公開リポジトリであることを確認 |
| `npm publish` がローカルで `private` を理由に止まる | ルート以外の対象パッケージで `private: true` になっていないか確認（公開対象は `core` / `cli` / `experimental`） |
| スコープ付きで `402 Payment Required` | `--access public` 指定漏れ。`publishConfig.access: "public"` も併せて確認 |
| Version Packages PR で core / experimental が意図せず `1.0.0` になっている | Changesets の `onlyUpdatePeerDependentsWhenOutOfRange` が効いていない。`.changeset/config.json` の設定と Changesets のバージョンを確認する（[バージョニング方針](#バージョニング方針)） |
| CI で `core を minor 以上で上げる changeset がありますが…` で落ちる | 意図した挙動。core の minor / major では experimental も同時にリリースする（`pnpm changeset` で experimental の changeset を追加する） |
| core と experimental のバージョン番号がずれている | 正常。番号の一致は要求していない（[バージョニング方針](#バージョニング方針)） |
| CI の `changeset-coverage` が `対応する changeset がありません` で落ちる | 意図した挙動。`pnpm changeset`（リリースする場合）または `pnpm changeset --empty`（リリース不要の場合）を実行してコミットする（[changeset の書き忘れは CI が止める](#changeset-の書き忘れは-ci-が止める)） |
| packages を変更していないのに `changeset-coverage` が落ちる | 出荷物判定が想定と違う可能性。`.github/scripts/verify-changeset-coverage.mjs` の `NON_SHIPPED_FILE_PATTERNS` を確認する |
| CI で `@maronn-oidc/experimental を patch 以外で上げる changeset がありますが…` で落ちる | 意図した挙動。experimental の bump は patch 固定なので、該当 changeset の bump 種別を `patch` に直す（[experimental の bump は常に patch に固定する](#experimental-の-bump-は常に-patch-に固定する)） |
| experimental の実装を変更したのに Version Packages PR が立たない | 変更が `packages/experimental/src` の実装ファイル以外（テスト・README・package.json）ではないか確認する。それ以外なら release job の `Ensure experimental release changeset` ステップのログで比較基準コミットと判定理由を確認する（[experimental の自動 publish](#experimental-の自動-publish)） |
| Version Packages PR に experimental の変更が 1 つしか載っていない | `auto-experimental-patch.md` は毎回上書きされるので通常は起きない。手書きの experimental changeset が残っていると自動生成がスキップされるため、`.changeset/` に手書きのものが無いか確認する |
| Version Packages PR をマージしたのに publish されず、また Version Packages PR が立つ | release job の `Ensure experimental release changeset` のログを見る。「未リリースの変更が N 件あるため」と出ているなら比較基準の判定が壊れている（[なぜ version 確定コミットを基準にするのか](#なぜ-version-確定コミットを基準にするのか)）。マージ直後の main では「変更がないため changeset を作成しない」になるのが正しい |
| CI で `main のバージョンが npm に出ていません` で落ちる | publish 段階へ到達しないまま run が終わっている。上の行と同じ調査をする（[publish に到達したことを検証する](#publish-に到達したことを検証する)） |


---

## トラブルシュート詳細ログ（初回セットアップ時の実録）

上表は要点のみのため、実際に踏んだエラーの詳細と根本原因を時系列で残す。
将来同種の問題が再発した場合の一次情報として、また将来的なブログ化のために記録する。

### 1. PR作成で403エラー

```
Error: GitHub Actions is not permitted to create or approve pull requests.
```

**要因:**
`permissions: pull-requests: write` をワークフローに設定していても、リポジトリ側の
「GitHub Actions が PR を作成・承認することを許可する」設定がデフォルト OFF のため。
ワークフロー内権限とは別レイヤーのガードになっている。

**対処:**
Settings → Actions → General → Workflow permissions →
「Allow GitHub Actions to create and approve pull requests」にチェック

**参考:**
- https://docs.github.com/rest/pulls/pulls#create-a-pull-request

### 2. npm publishで404エラー（1回目・根本原因）

```
Error: 404 Not Found - PUT https://registry.npmjs.org/@scope/pkg
```

**要因:**
GitHub Actions の Node 22 にバンドルされる npm は v10 系で、
npm trusted publishing（OIDC）の要求バージョン（npm >= 11.5.1）を満たさない。
OIDC ハンドシェイクが失敗すると匿名ユーザー扱いになり、認証エラーではなく紛らわしい 404 が返る。

**対処:**
`npm install -g npm@latest`（または具体バージョンにピン留め）のステップを
`setup-node` の直後、`pnpm install` の前に追加する。

**参考:**
- https://github.com/npm/cli/issues/8730
- https://github.com/npm/cli/issues/8976
- https://github.com/npm/cli/issues/8678
- https://medium.com/@kenricktan11/npm-trusted-publishers-the-weird-404-error-and-the-node-js-24-fix-a9f1d717a5dd
- https://docs.npmjs.com/trusted-publishers/

### 3. ERR_PNPM_IGNORED_BUILDS

```
Ignored build scripts: esbuild@0.21.5, esbuild@0.25.12, esbuild@0.27.7, sharp@0.34.5
```

**要因:**
pnpm 10 以降、依存パッケージの postinstall 等の build script を
サプライチェーン攻撃対策としてデフォルトで自動実行しなくなった。
ローカルで `pnpm approve-builds` を実行した結果（`package.json` / `pnpm-workspace.yaml` への書き込み）が
コミット・push されておらず、CI 上のチェックアウトには反映されていなかった。

**対処:**
ローカルで `pnpm approve-builds` → 生成された設定を確認してコミットする
（pnpm 10 系では `package.json` の `pnpm.onlyBuiltDependencies` に反映される）。
pnpm バージョン（`packageManager` フィールド）がローカル / CI で一致しているかも合わせて確認する。

**参考:**
- https://pnpm.io/settings
- https://github.com/pnpm/pnpm/issues/9082（`shared-workspace-lockfile=false` 時の既知の非適用問題）
- https://pnpm.io/blog/releases/11.0（v11 で `onlyBuiltDependencies` → `allowBuilds` へ変更、参考として）

### 4. npm publishで404エラー（2回目・pnpm 11回帰バグ）

```
Error: 404 Not Found（pnpm 11環境下でのOIDC publish）
```

**要因:**
pnpm 11 で publish コマンドが npm CLI 委譲からネイティブ実装に変更され、
それに伴い OIDC trusted publishing が v10 時代と同じに動かず 404 になる既知の回帰バグ。

**対処:**
`packageManager` フィールドを動作実績のある pnpm@10.17.0 系に固定し直す。

**参考:**
- https://github.com/pnpm/pnpm/issues/11513
- https://pnpm.io/blog/releases/11.3（ネイティブ publish 移行の経緯）

### 5. Cannot find module 'sigstore'

```
error an error occurred while publishing @maronn-oidc/cli:
MODULE_NOT_FOUND Cannot find module 'sigstore'
```

**要因:**
`npm install -g npm@latest` が、`latest` dist タグの解決タイミングによって
意図せずプレリリース版（12.0.0-pre.2 系）を掴んでしまい、
そのビルドで `libnpmpublish` が依存する `sigstore` モジュール解決が壊れていた。
npm/cli 側の直近の未修正バグ（2026年7月頭に報告）。

**対処:**
`npm@latest` ではなく、正式タグ付けされた安定版を明示的にバージョンピン留めする
（今回は `npm@11.17.0` を指定して解消）。

**参考:**
- https://github.com/npm/cli/issues/9722
- https://github.com/npm/cli/releases（正式リリースタグの確認）

### 最終的な release.yml の該当部分（要点）

```yaml
- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: '22'
    cache: 'pnpm'
    registry-url: 'https://registry.npmjs.org'
- name: Update npm to a pinned stable version
  run: npm install -g npm@11.17.0   # latestではなく明示バージョン指定
- name: Install dependencies
  run: pnpm install --frozen-lockfile
```

```jsonc
// package.json
{
  "packageManager": "pnpm@10.17.0", // pnpm11の回帰バグを回避
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild", "sharp"] // 承認結果をコミット
  }
}
```

リポジトリ設定:
Settings → Actions → General → Workflow permissions →
「Allow GitHub Actions to create and approve pull requests」ON
