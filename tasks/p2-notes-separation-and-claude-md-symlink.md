# [P2] 作業メモを非公開 notes リポジトリへ分離し、`CLAUDE.md` をシンボリックリンク化する（ローカル実行版）

## ステータス

🟡 Medium / 未着手

## 背景

OSS実装リポジトリは public であり、作業メモと非公開情報を置きたくない。
一方でメモ自体は git 管理下に置いて履歴を残したいし、ローカル作業中は OSS実装リポジトリ配下から参照できる状態を保ちたい。

そこでメモ類は別の非公開リポジトリで管理し、OSS実装リポジトリ側には git 管理対象外の `.notes` だけを置く。
`.notes` の実体は、既存 notes リポジトリのローカルチェックアウトへのシンボリックリンクとする。
`CLAUDE.md` の実体も `.notes/CLAUDE.md` へ移し、ルートにはシンボリックリンクを配置する。

本タスクはローカル実行だけを対象とする。
クラウド実行環境（Claude Code on the Web）向けの構成は扱わないが、影響は「スコープ外」節に記載する。

## リポジトリ情報

| | notes リポジトリ | OSS実装リポジトリ |
|---|---|---|
| ローカルパス | `/var/www/notes-maronn-openid-connect` | `/var/www/maronn-openid-provider` |
| GitHub URL | https://github.com/maronnjapan/notes-maronn-openid-connect | https://github.com/maronnjapan/maronn-openid-connect |

OSS実装リポジトリはローカルディレクトリ名（`maronn-openid-provider`）と GitHub 上のリポジトリ名（`maronn-openid-connect`）が異なる。
`.mcp.json` の serena 起動引数も `--project /var/www/maronn-openid-provider` を指しており、ローカルパスはこの前提で書かれている。

公開状態は public、fork 0、open PR は 10 件以上、コミット数は 218 件（2026-08-23 時点）。
この数字は「履歴からの削除」を採らない判断の根拠になる（「完了条件」を参照）。

## 着手前に確定している事実

指示書の前提を、実リポジトリと git の挙動で検証した結果を先に置く。
検証は 2026-08-23 に、`https://github.com/maronnjapan/maronn-openid-connect` の main（`65a4956`）と git 2.43.0 で行った。

### `CLAUDE.md` は追跡されている

`git ls-files CLAUDE.md` はヒットする。
初出は `45df806 first commit`、以後 7 コミット、現在 19,079 バイト。
条件分岐（「git 管理下にあった場合のみ退避する」）は不要で、退避は必須の手順になる。

### `AGENTS.md` と `GEMINI.md` は `CLAUDE.md` を指す追跡済みシンボリックリンク

```
$ git ls-files -s | grep ^120000
120000 681311eb9cf453d0faddf3aacaec7357e97ba8e9 0	AGENTS.md
120000 681311eb9cf453d0faddf3aacaec7357e97ba8e9 0	GEMINI.md
```

`CLAUDE.md` だけを追跡から外すと、この 2 つは公開ツリーで壊れたリンクとして残る。
3 ファイルをまとめて追跡から外し、セットアップスクリプトで再生成する。

### `.notes/` という `.gitignore` パターンではシンボリックリンクを無視できない

末尾スラッシュ付きのパターンはディレクトリだけにマッチする。
git はシンボリックリンクをディレクトリとして扱わないため、`.notes` は未追跡ファイルとして残る。

```
$ printf '.notes/\nCLAUDE.md\n' > .gitignore
$ ln -sfn ../notesrepo .notes
$ git status --porcelain
?? .gitignore
?? .notes          # 無視されていない
$ git check-ignore -v .notes CLAUDE.md
.gitignore:2:CLAUDE.md	CLAUDE.md
```

スラッシュを外した `.notes` なら、シンボリックリンクでもディレクトリでも無視される。
さらに先頭スラッシュを付けた `/.notes` にすると、ルート直下だけに限定できる。
`CLAUDE.md` も同様で、先頭スラッシュなしだと将来 `packages/*/CLAUDE.md` のような入れ子まで無視してしまう。

### git alias で `pull` と `fetch` は上書きできない

git は組み込みコマンドを隠すエイリアスを無視する。
`alias.fetch` と `alias.pull` を設定しても、実行されるのは組み込みコマンドのままだった。

```
$ git config alias.fetch '!echo ALIAS_FETCH_RAN'
$ git config alias.status '!echo ALIAS_STATUS_RAN'
$ git fetch      # 何も出力されない（エイリアスは無視される）
$ git status     # ALIAS_STATUS_RAN ではなく通常の status が出る
On branch master
```

元の指示書のタスク4はこの前提で書かれているため、そのままでは要件4を満たさない。
代わりに次の 2 つで追従を実装する。

- `git pull`（merge を伴う場合）は `.git/hooks/post-merge` で追従させる。git 2.43.0 では fast-forward の pull でも post-merge が動き、フックの cwd はワークツリーのルートになることを実測した
- `git fetch` 単体と、`git pull --rebase`（post-merge ではなく post-rewrite が動く）は明示コマンド `pnpm notes:sync` で追従させる

git に post-fetch フックは存在しない。
`git fetch` そのものに追従させたい場合はシェル関数を使うしかなく、それは各自の `~/.bashrc` 等に置く話になるため、実装は notes リポジトリ側の手順書に置く（「スコープ外」を参照）。

### `ln -sfn` は宛先が実ディレクトリのとき、その中にリンクを作る

```
$ mkdir realdir
$ ln -sfn /path/to/target realdir
$ ls -la realdir
lrwxrwxrwx 1 root root ... target -> /path/to/target   # realdir/target ができてしまう
```

終了コードは 0 で、失敗として検出できない。
`.notes` が実ディレクトリとして存在する場合にセットアップが静かに壊れるため、スクリプト側で事前判定して停止させる。

### `CLAUDE.md` を参照している箇所

`grep -rn 'CLAUDE\.md'` の結果は 207 件で、内訳は次のとおり。

| 場所 | 件数 | 本タスクでの扱い |
|---|---|---|
| `study-material/` | 116 | 触らない |
| `tasks/` | 74 | 触らない |
| `.claude/docs/` | 6 | 触らない |
| `RELEASE.md` | 2 | 参照先を差し替える |
| `docs/implementation-guides/experimental/README.md` | 2（日本語版と英語版） | 参照先を差し替える |
| `samples/README.md` / `samples/*/scripts/deploy-*.sh` | 3 | 参照先を差し替える |
| `packages/cli/src/frameworks/hono/templates.ts` | 2 | 参照先を差し替える |
| `scripts/lib/deploy-fly-node-sample.sh` | 1 | 参照先を差し替える |
| `CLAUDE.md` 自身の見出し | 1 | 移送とともに `.notes` へ移る |

`packages/cli` の 2 件（`templates.ts:6800` と `templates.ts:10779`）は CLI ソースの JSDoc であり、生成コードには出力されない。
生成物側に文字列が出ないことは `grep -rn "reuse-cascade contract\|drifted from the contract" samples/` が空になることで確認した。
したがってコメント文言の修正だけで済み、`conformance.test.ts` の再生成は不要になる。

`tasks/` と `study-material/` の 190 件はローカルではシンボリックリンク経由で解決するが、GitHub 上では参照先を失う。
リンク検査の CI 化を扱う `tasks/p2-doc-path-reference-repair-and-link-check.md` と衝突するため、その整合は同タスク側で決める（「判断が必要な点」を参照）。

### ビルドとテストは `CLAUDE.md` を読まない

`.github/workflows/`、`.github/scripts/`、`scripts/experimental-review/`、各 `vitest.config.ts` のいずれも `CLAUDE.md` を参照していない。
`pnpm-workspace.yaml` の対象は `packages/*` `samples/*` `tests/*` `docs/*` だけなので、`.notes` を置いても pnpm のワークスペース走査には入らない。
`CLAUDE.md` を追跡から外しても CI は壊れない。

### ルートに `README.md` が無い

ルートの追跡ファイルは `.codex` `.gitignore` `.mcp.json` `AGENTS.md` `CLAUDE.md` `GEMINI.md` `LICENSE` `RELEASE.md` `package.json` `pnpm-lock.yaml` `pnpm-workspace.yaml` だけで、`README.md` は存在しない。
`CLAUDE.md` を外すと、公開リポジトリのルートから説明文書が無くなる。

## 要件

1. `.gitignore` にルート限定パターンで `/.notes` `/CLAUDE.md` `/AGENTS.md` `/GEMINI.md` を追加し、以後のコミットと main の公開ツリーに含まれないようにする
2. `.notes` は既存 notes チェックアウト（`/var/www/notes-maronn-openid-connect`）へのシンボリックリンクとする。clone はやり直さない
3. ルートの `CLAUDE.md` は `.notes/CLAUDE.md` を指すシンボリックリンクとし、`AGENTS.md` と `GEMINI.md` は従来どおり `CLAUDE.md` を指すシンボリックリンクとして復元する
4. OSS実装リポジトリ配下で `git pull` を実行したとき、`.notes` も追従する。`git fetch` 単体と `git pull --rebase` は `pnpm notes:sync` で追従させる
5. 公開ファイルに残る `CLAUDE.md` への参照（10 件）を、参照先が存在する状態に直す
6. notes リポジトリへの push は扱わない

## 対象ファイル

- `.gitignore`
- `scripts/setup-notes.sh`（新規）
- `scripts/notes-sync.sh`（新規）
- `package.json`（`notes:setup` / `notes:sync` の追加）
- `RELEASE.md`（161 行目・468 行目）
- `docs/implementation-guides/experimental/README.md`（47 行目・53 行目）
- `samples/README.md`（3 行目）
- `samples/nextjs-vercel/scripts/deploy-vercel.sh`（7 行目）
- `samples/hono-cloudflare/scripts/deploy-cloudflare.sh`（7 行目）
- `scripts/lib/deploy-fly-node-sample.sh`（10 行目）
- `packages/cli/src/frameworks/hono/templates.ts`（6800 行目・10779 行目。いずれも JSDoc コメント）

## タスク

### タスク1: 事前確認

- [ ] `/var/www/maronn-openid-provider` で `git remote -v` を実行し、origin が `https://github.com/maronnjapan/maronn-openid-connect` であることを確認する
- [ ] `/var/www/notes-maronn-openid-connect` で `git remote -v` を実行し、origin が `https://github.com/maronnjapan/notes-maronn-openid-connect` であることを確認する
- [ ] notes リポジトリ側に既存の `CLAUDE.md` があるかを確認する（`ls /var/www/notes-maronn-openid-connect/CLAUDE.md`）
- [ ] `/var/www/maronn-openid-provider/.notes` が既に存在する場合、シンボリックリンクか実ディレクトリかを確認する（`ls -ld .notes`）

### タスク2: `CLAUDE.md` の実体を notes リポジトリへ移す

- [ ] `CLAUDE.md` を `/var/www/notes-maronn-openid-connect/CLAUDE.md` へ移す
- [ ] notes リポジトリ側に別の `CLAUDE.md` が既にある場合は上書きせず、統合方針を決めてからマージする
- [ ] notes リポジトリでコミットする（この時点では OSS実装リポジトリ側のワーキングツリーにファイルが残っていてよい。タスク5でシンボリックリンクに置き換える）

### タスク3: `.gitignore` の更新

`.gitignore` は用途ごとのコメント見出しで区切られている。
末尾に次の節を追加する。

```
# Work notes (private notes repository; see scripts/setup-notes.sh)
/.notes
/CLAUDE.md
/AGENTS.md
/GEMINI.md
```

- [ ] 先頭スラッシュ付きで追記する（ルート直下だけを対象にするため）
- [ ] `.notes` に末尾スラッシュを付けない（シンボリックリンクにマッチしなくなるため）

### タスク4: 3 ファイルの追跡を外す

- [ ] `git rm --cached CLAUDE.md AGENTS.md GEMINI.md` を実行する
- [ ] `git status` で 3 ファイルが削除としてステージされ、未追跡としては現れないことを確認する
- [ ] `.gitignore` の変更と合わせて 1 コミットにする

### タスク5: `scripts/setup-notes.sh` の作成

既存の `scripts/sample-up.sh` に合わせ、`scripts/lib/guide.sh` の出力ヘルパーを使う。
このスクリプトは秘匿情報を含まないため OSS実装リポジトリにコミットする。

```bash
#!/usr/bin/env bash
# 非公開 notes リポジトリのローカルチェックアウトを、このリポジトリへリンクする。
#
#   pnpm notes:setup
#
# .notes を既存チェックアウトへの symlink にし、CLAUDE.md / AGENTS.md / GEMINI.md を
# その中身へ向ける。notes リポジトリの clone はしない（既に手元にある前提）。
# 置き場所を変えたい場合は NOTES_LOCAL_PATH=<path> pnpm notes:setup で指定する。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/guide.sh
. "${SCRIPT_DIR}/lib/guide.sh"

NOTES_LOCAL_PATH="${NOTES_LOCAL_PATH:-/var/www/notes-maronn-openid-connect}"
NOTES_LINK="${ROOT_DIR}/.notes"
HOOK_PATH="${ROOT_DIR}/.git/hooks/post-merge"
HOOK_MARKER="maronn-notes-sync"

guide_step "notes リポジトリのチェックアウトを確認します"
if [ ! -e "${NOTES_LOCAL_PATH}/.git" ]; then
  guide_err "${NOTES_LOCAL_PATH} が見つからないか、git リポジトリではありません。"
  guide_info "先に clone してください:"
  guide_info "  git clone https://github.com/maronnjapan/notes-maronn-openid-connect ${NOTES_LOCAL_PATH}"
  exit 1
fi
guide_ok "notes: ${NOTES_LOCAL_PATH}"

guide_step ".notes をリンクします"
if [ -d "${NOTES_LINK}" ] && [ ! -L "${NOTES_LINK}" ]; then
  # ln -sfn は宛先が実ディレクトリのとき、その中にリンクを作って終了コード 0 を返す。
  # 静かに壊れるので、ここで止める。
  guide_err ".notes が実ディレクトリとして存在します: ${NOTES_LINK}"
  guide_info "中身を ${NOTES_LOCAL_PATH} へ移してディレクトリを削除してから、再実行してください。"
  exit 1
fi
ln -sfn "${NOTES_LOCAL_PATH}" "${NOTES_LINK}"
guide_ok ".notes -> ${NOTES_LOCAL_PATH}"

guide_step "CLAUDE.md / AGENTS.md / GEMINI.md をリンクします"
if [ -f "${ROOT_DIR}/CLAUDE.md" ] && [ ! -L "${ROOT_DIR}/CLAUDE.md" ]; then
  guide_err "CLAUDE.md が実ファイルとして残っています: ${ROOT_DIR}/CLAUDE.md"
  guide_info "先に ${NOTES_LOCAL_PATH}/CLAUDE.md へ移してから、再実行してください。"
  exit 1
fi
if [ ! -f "${NOTES_LOCAL_PATH}/CLAUDE.md" ]; then
  guide_err "${NOTES_LOCAL_PATH}/CLAUDE.md がありません。"
  guide_info "CLAUDE.md の実体を notes リポジトリへ移してから、再実行してください。"
  exit 1
fi
ln -sf .notes/CLAUDE.md "${ROOT_DIR}/CLAUDE.md"
ln -sf CLAUDE.md "${ROOT_DIR}/AGENTS.md"
ln -sf CLAUDE.md "${ROOT_DIR}/GEMINI.md"
guide_ok "CLAUDE.md -> .notes/CLAUDE.md / AGENTS.md・GEMINI.md -> CLAUDE.md"

guide_step "git pull 後の追従フックを設定します"
if [ -e "${HOOK_PATH}" ] && ! grep -q "${HOOK_MARKER}" "${HOOK_PATH}"; then
  guide_warn "既存の post-merge フックがあるため上書きしません: ${HOOK_PATH}"
  guide_info "次の1行を既存フックへ追記してください:"
  guide_info '  "$(git rev-parse --show-toplevel)/scripts/notes-sync.sh" || true'
else
  cat > "${HOOK_PATH}" <<'HOOK'
#!/usr/bin/env sh
# maronn-notes-sync: scripts/setup-notes.sh が生成。git pull（merge）後に .notes を追従させる。
"$(git rev-parse --show-toplevel)/scripts/notes-sync.sh" || true
HOOK
  chmod +x "${HOOK_PATH}"
  guide_ok "post-merge フックを設定しました。"
fi

guide_info "git fetch 単体と git pull --rebase にはフックが無いため、pnpm notes:sync を使ってください。"
guide_ok "セットアップが完了しました。"
```

- [ ] `chmod +x scripts/setup-notes.sh` を実行する

### タスク6: `scripts/notes-sync.sh` の作成

```bash
#!/usr/bin/env bash
# .notes（非公開 notes リポジトリ）を最新へ追従させる。
#
#   pnpm notes:sync
#
# scripts/setup-notes.sh が設定する post-merge フックからも呼ばれる。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/guide.sh
. "${SCRIPT_DIR}/lib/guide.sh"

# フック経由で呼ばれたとき、外側リポジトリの git 環境変数を引き継がないようにする。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX

NOTES_LINK="${ROOT_DIR}/.notes"

if [ ! -e "${NOTES_LINK}/.git" ]; then
  guide_info ".notes が未設定のためスキップします（pnpm notes:setup で設定できます）。"
  exit 0
fi

guide_step ".notes を追従させます"
if ! git -C "${NOTES_LINK}" fetch; then
  guide_err ".notes の fetch に失敗しました。"
  exit 1
fi
if ! git -C "${NOTES_LINK}" pull --ff-only; then
  guide_err ".notes を fast-forward できませんでした。手動で確認してください。"
  exit 1
fi
guide_ok ".notes を更新しました。"
```

- [ ] `chmod +x scripts/notes-sync.sh` を実行する
- [ ] `--ff-only` にする（メモ側にローカル変更があるとき、勝手にマージコミットを作らないため）

### タスク7: `package.json` にコマンドを追加する

既存の `sample:*` / `deploy:*` と同じ形式で追加する。

```json
"notes:setup": "bash scripts/setup-notes.sh",
"notes:sync": "bash scripts/notes-sync.sh",
```

- [ ] `scripts` の並びに追加する（`sample:*` の直前）

### タスク8: 公開ファイルの `CLAUDE.md` 参照を差し替える

参照先は「判断が必要な点」の決定に従う。
公開文書（`README.md` など）を作る場合はそこへ、作らない場合は「本リポジトリの規約」のような一般的な表現に置き換える。

- [ ] `RELEASE.md:161` / `RELEASE.md:468`
- [ ] `docs/implementation-guides/experimental/README.md:47`（日本語）と `:53`（英語）
- [ ] `samples/README.md:3`
- [ ] `samples/nextjs-vercel/scripts/deploy-vercel.sh:7`
- [ ] `samples/hono-cloudflare/scripts/deploy-cloudflare.sh:7`
- [ ] `scripts/lib/deploy-fly-node-sample.sh:10`
- [ ] `packages/cli/src/frameworks/hono/templates.ts:6800` / `:10779`（JSDoc のみ。生成物には出力されない）
- [ ] `grep -rn 'CLAUDE\.md' --exclude-dir=node_modules --exclude-dir=tasks --exclude-dir=study-material --exclude-dir=.claude .` が 0 件になることを確認する

### タスク9: 動作確認

タスク5とタスク6のスクリプトは、notes 側と OSS 側の upstream を模したサンドボックスで通しで実行し、以下の項目とガード（`.notes` が実ディレクトリ、`CLAUDE.md` が実ファイル、notes パス不在、既存 post-merge フックあり、`.notes` 未設定）の挙動を確認してある（2026-08-23、git 2.43.0）。
実環境での確認は次の手順で行う。

- [ ] `pnpm notes:setup` を実行する
- [ ] `readlink .notes` が `/var/www/notes-maronn-openid-connect` を返す
- [ ] `readlink CLAUDE.md` が `.notes/CLAUDE.md`、`readlink AGENTS.md` と `readlink GEMINI.md` が `CLAUDE.md` を返す
- [ ] `head -1 CLAUDE.md` で notes リポジトリ側の中身が読める
- [ ] `git status --porcelain` に `.notes` `CLAUDE.md` `AGENTS.md` `GEMINI.md` が現れない
- [ ] `git check-ignore -v .notes CLAUDE.md AGENTS.md GEMINI.md` が 4 行返す
- [ ] `git ls-files CLAUDE.md AGENTS.md GEMINI.md` が空になる
- [ ] `git -C .notes rev-parse HEAD` を控えてから `git pull` を実行し、`.notes` 側の HEAD も更新される（post-merge が動く）
- [ ] `packages/core` などサブディレクトリで `git pull` を実行しても `.notes` が追従する（フックは `git rev-parse --show-toplevel` でルートを解決する）
- [ ] `git fetch` のあと `pnpm notes:sync` で `.notes` が追従する
- [ ] `.notes` を一時的に退避した状態で `pnpm notes:sync` を実行し、エラーではなくスキップになる
- [ ] `pnpm --filter @maronn-openid-connect/cli test` が通る（タスク8で `templates.ts` を触るため）
- [ ] `pnpm run test:supply-chain` が通る

### タスク10: 判断が必要な点の決定を反映する

- [ ] 「判断が必要な点」の 3 項目について決定し、本タスク文書に決定内容を追記する
- [ ] 公開向け `README.md` を作る決定をした場合、`CLAUDE.md` から公開してよい内容（コンセプト、ディレクトリ構成、コマンド、準拠仕様）を抜き出して作成する

## 完了条件

- 以後のコミットと main の公開ツリーに `.notes` `CLAUDE.md` `AGENTS.md` `GEMINI.md` が含まれない
- `pnpm notes:setup` の実行だけで 4 つのリンクと post-merge フックが揃う
- `git pull` を実行すると、サブディレクトリからでも `.notes` が追従する
- `git fetch` 単体のあとは `pnpm notes:sync` で `.notes` が追従する
- 公開ファイルに `CLAUDE.md` への参照が残っていない
- CI（`pnpm run test:ci`）が緑のまま

過去の履歴に残る `CLAUDE.md` は削除しない。
`git rm --cached` が消すのは tip のツリーだけであり、履歴から消すには `git filter-repo` などで 218 コミットを書き換えて force push する必要がある。
それは 10 件以上の open PR のブランチを無効化する。
`CLAUDE.md` の中身はリポジトリの開発規約であって資格情報ではないため、履歴書き換えの費用に見合わない。
履歴からの削除を要件に加えるなら、別タスクとして切り出し、open PR の退避手順とセットで計画する。

## 判断が必要な点

着手前に次の 3 点を決める。
決定によってタスク8とタスク10の内容が変わる。

### 1. 公開ルートに説明文書を残すか

現在ルートに `README.md` は無く、`CLAUDE.md` が唯一の全体説明になっている。
そのまま外すと、公開リポジトリのルートから説明が消える。

- 案A: `CLAUDE.md` をそのまま `.notes` へ移し、公開文書は作らない
- 案B: `CLAUDE.md` の公開してよい部分（コンセプト、ディレクトリ構成、コマンド、準拠仕様、テスト規約）を `README.md` として切り出し、残りを `.notes/CLAUDE.md` に置く

案B を推す。
`CLAUDE.md` の内容の大半は OSS の開発規約であり、公開しても不都合が無い。
案B なら公開ファイル 10 件の参照先も `README.md` に向け直せる。

### 2. `tasks/` と `study-material/` をどう扱うか

この 2 つは作業メモそのもので、合計 460 ファイル、`CLAUDE.md` への参照を 190 件持つ。
「作業メモを一切含めたくない」という目的からは移送対象に見えるが、いま移すと `pnpm review:experimental` と `pnpm run test:experimental-review` が壊れる。
`scripts/experimental-review/lib/repo.mjs:62-63` が `tasks/experimental/<feature-id>` と `tasks/experimental/done/<feature-id>` を読むためである。

- 案A: 本タスクでは移さない（推奨）。`CLAUDE.md` への参照はローカルでは解決するため、実害はリンク検査を CI 化したときに顕在化する
- 案B: 併せて移す。experimental の昇格レビューパケット生成を notes リポジトリ側から動かす設計が別途必要になる

案A を採る場合、リンク検査を扱う `tasks/p2-doc-path-reference-repair-and-link-check.md` に「`tasks/` と `study-material/` から `CLAUDE.md` への参照は検査対象外とする」ことを明記する。

### 3. 本タスク文書自体をどこに置くか

本文書も作業メモである。
現状 `tasks/` 配下に 225 件のタスク文書が公開されているため、当面はその慣行に合わせて `tasks/` に置いている。
判断2で案B を採るなら、本文書も notes リポジトリへ移す。

## スコープ外

- notes リポジトリへの push
- notes リポジトリと OSS実装リポジトリ間の自動マージとコンフリクト解決
- 履歴からの `CLAUDE.md` 削除（「完了条件」に理由を記載）
- `git fetch` 単体をシェル側で追従させる設定。次のシェル関数を各自の `~/.bashrc` や `~/.zshrc` に置けば実現できるが、リポジトリにコミットできる設定ではないため notes リポジトリ側の手順書で扱う

  ```bash
  git() {
    command git "$@" || return
    case "${1:-}" in
      fetch|pull)
        local root
        root="$(command git rev-parse --show-toplevel 2>/dev/null)" || return 0
        [ -e "${root}/.notes/.git" ] && command git -C "${root}/.notes" "$1"
        ;;
    esac
  }
  ```

- クラウド実行環境（Claude Code on the Web）向けの構成

  クラウド実行はスコープ外だが、影響は無視できない。
  このリポジトリは `.claude/settings.json` の SessionStart フックで `npx -y gh-setup-hooks`（Claude Code on the Web 向けの gh 自動導入）を実行しており、`claude/*` ブランチ由来の PR も複数ある。
  `CLAUDE.md` を追跡から外すと、クラウドセッションはプロジェクト規約を読まない状態で動く。
  判断1で案B（公開 `README.md` を作る）を採れば、規約の主要部分はクラウドからも読める。
  それでも不足する場合は、トークンを使って notes リポジトリを clone する SessionStart フックを別タスクで検討する。

- `.claude/settings.json` と `.mcp.json` に含まれるローカル環境依存の記述の扱い

  `.claude/settings.json` には Windows の PowerShell パス、`.mcp.json` には `/var/www/maronn-openid-provider` が入っており、いずれも公開されている。
  秘匿情報ではないが、作業環境依存という点では同じ性質を持つ。
  分離するなら `.claude/settings.local.json` への移動を含めて別タスクで扱う。

## 元の指示書からの変更点

| 元の記述 | 変更内容 | 理由 |
|---|---|---|
| `.gitignore` に `.notes/` | `/.notes`（スラッシュ位置を変更） | 末尾スラッシュ付きパターンはシンボリックリンクにマッチしない |
| `.gitignore` に `CLAUDE.md` | `/CLAUDE.md` `/AGENTS.md` `/GEMINI.md` | ルート限定にするため。`AGENTS.md` と `GEMINI.md` は `CLAUDE.md` を指す追跡済みリンクで、放置すると公開ツリーで壊れる |
| タスク2「該当する場合のみ」 | 必須手順に変更 | `CLAUDE.md` は追跡済み（7 コミットの履歴あり） |
| `git config alias.fetch` / `alias.pull` | post-merge フック＋`pnpm notes:sync` に置き換え | git は組み込みコマンドを隠すエイリアスを無視する |
| `ln -sfn` を無条件実行 | `.notes` が実ディレクトリのときに停止する判定を追加 | 実ディレクトリ宛てだと、その中にリンクを作って成功扱いになる |
| `CLAUDE.md` を `ln -sf` で無条件上書き | 実ファイルが残っているときに停止する判定を追加 | 退避前に実行すると実体を消してしまう |
| スクリプトを素の `echo` で構成 | `scripts/lib/guide.sh` の出力ヘルパーを使用 | `scripts/sample-up.sh` と `samples/*/scripts/deploy-*.sh` の既存規約に合わせる |
| 起動手段が `bash scripts/setup-notes.sh` | `pnpm notes:setup` / `pnpm notes:sync` を追加 | ルート `package.json` の `sample:*` / `deploy:*` と同じ入口に揃える |
| 参照修復の記載なし | 公開ファイル 10 件の参照差し替えをタスク化 | `RELEASE.md`・`docs/`・`samples/`・`packages/cli` が `CLAUDE.md` を参照している |
| 受け入れ基準「コミット履歴に一切含まれていない」 | 「以後のコミットと main の公開ツリーに含まれない」へ変更 | 履歴書き換えは 218 コミットの force push と open PR の無効化を伴う |
| コードブロックが閉じておらず `chmod +x` の項目が混入 | 整形を修正 | 手順として読めない状態だった |
