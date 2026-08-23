# [P2] 作業メモを notes リポジトリへ分離し、公開規約を README.md に切り出す

## ステータス

🟡 Medium / 未着手

## 背景

OSS実装リポジトリは public であり、作業メモと非公開情報を置きたくない。
一方でメモ自体は git 管理下に置いて履歴を残したいし、ローカル作業中は OSS実装リポジトリ配下から参照できる状態を保ちたい。

メモ類は別リポジトリで管理し、OSS実装リポジトリ側には git 管理対象外のシンボリックリンクだけを置く。
ローカルでは既存チェックアウト（`/var/www/notes-maronn-openid-connect`）へリンクし、Claude Code on the Web では `.notes` を実クローンとして取得する。

`CLAUDE.md` のうち公開してよい規約は `README.md` として切り出し、公開リポジトリのルートに説明文書を残す。

## 決定事項

2026-08-23 に依頼者が判断した内容を、以下の設計の前提とする。

1. `CLAUDE.md` の公開してよい部分を `README.md` へ切り出す
2. `tasks/` と `study-material/` も notes リポジトリへ移す。`scripts/experimental-review/` は現時点で意義が弱いため削除してよい
3. 本タスク文書自身も notes リポジトリへ移す
4. Claude Code on the Web からも `.notes` の内容を取得できるようにする

決定3により、本文書は最終的に `.notes/tasks/` へ移る。
notes リポジトリにまだ中身が無く、この作業環境から書き込めないため、フェーズ3の移送で `tasks/` 全体と一緒に運ぶ。

## リポジトリ情報

| | notes リポジトリ | OSS実装リポジトリ |
|---|---|---|
| ローカルパス | `/var/www/notes-maronn-openid-connect` | `/var/www/maronn-openid-provider` |
| GitHub URL | https://github.com/maronnjapan/notes-maronn-openid-connect | https://github.com/maronnjapan/maronn-openid-connect |

OSS実装リポジトリはローカルディレクトリ名（`maronn-openid-provider`）と GitHub 上のリポジトリ名（`maronn-openid-connect`）が異なる。
`.mcp.json` の serena 起動引数も `--project /var/www/maronn-openid-provider` を指している。

## 着手前に確定している事実

2026-08-23 に、main（`65a4956`）と git 2.43.0 で検証した結果を先に置く。

### notes リポジトリは現在 public で、コミットが 1 つも無い

認証情報なしで `git clone` が成功し、`warning: You appear to have cloned an empty repository.` が返る。
つまり現状は「非公開リポジトリ」ではなく、中身も空である。
メモを push する前に GitHub 側で private へ変更する必要がある（フェーズ0）。

この事実はクラウド対応の設計にも効く。
public のままなら誰でも読めてしまい、private にするとクラウドからの取得に認証が要る。

### `CLAUDE.md` は追跡されている

`git ls-files CLAUDE.md` はヒットする。
初出は `45df806 first commit`、以後 7 コミット、現在 19,079 バイト。

### `AGENTS.md` と `GEMINI.md` は `CLAUDE.md` を指す追跡済みシンボリックリンク

```
$ git ls-files -s | grep ^120000
120000 681311eb9cf453d0faddf3aacaec7357e97ba8e9 0	AGENTS.md
120000 681311eb9cf453d0faddf3aacaec7357e97ba8e9 0	GEMINI.md
```

`CLAUDE.md` だけを追跡から外すと、この 2 つは公開ツリーで壊れたリンクとして残る。

### `.notes/` という `.gitignore` パターンではシンボリックリンクを無視できない

末尾スラッシュ付きのパターンはディレクトリだけにマッチし、git はシンボリックリンクをディレクトリとして扱わない。

```
$ printf '.notes/\n' > .gitignore
$ ln -sfn ../notesrepo .notes
$ git status --porcelain
?? .notes          # 無視されていない
```

スラッシュを外した `.notes` なら、シンボリックリンクでもディレクトリでも無視される。
先頭スラッシュを付けた `/.notes` にすると、ルート直下だけに限定できる。

### git alias で `pull` と `fetch` は上書きできない

git は組み込みコマンドを隠すエイリアスを無視する。

```
$ git config alias.status '!echo ALIAS_STATUS_RAN'
$ git status
On branch master        # エイリアスは実行されない
```

`git pull` の追従は `.git/hooks/post-merge` で実装する。
git 2.43.0 では fast-forward の pull でも post-merge が動き、フックの cwd はワークツリーのルートになることを実測した。
`git fetch` 単体と `git pull --rebase`（post-merge ではなく post-rewrite が動く）は `pnpm notes:sync` で追従させる。

### `ln -sfn` は宛先が実ディレクトリのとき、その中にリンクを作る

終了コードは 0 で、失敗として検出できない。
`.notes` が実ディレクトリとして存在する場合に静かに壊れるため、スクリプト側で事前判定して停止させる。

### SessionStart フックは終了コード 0 で JSON を出せば文脈へ注入できる

Claude Code の SessionStart フックは、標準出力に次の形の JSON を出すとその内容が文脈へ入る。

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "..."
  }
}
```

プレーンテキストの標準出力もそのまま文脈へ入り、フックはセッション開始をブロックできない。
`.claude/settings.json` には既に `npx -y gh-setup-hooks` の SessionStart フックがあるため、2 つ目のフックとして追加する。

### `CLAUDE.md` を参照している箇所

`grep -rn 'CLAUDE\.md'` の結果は 207 件。
`study-material/` 116 件、`tasks/` 74 件、`.claude/docs/` 6 件はメモ側なので、フェーズ3で一緒に移る。
公開のまま残るのは次の 10 件で、参照先を `README.md` へ差し替える。

| ファイル | 件数 |
|---|---|
| `RELEASE.md`（161 行目・468 行目） | 2 |
| `docs/implementation-guides/experimental/README.md`（47 行目・53 行目） | 2 |
| `samples/README.md`（3 行目） | 1 |
| `samples/nextjs-vercel/scripts/deploy-vercel.sh`（7 行目） | 1 |
| `samples/hono-cloudflare/scripts/deploy-cloudflare.sh`（7 行目） | 1 |
| `scripts/lib/deploy-fly-node-sample.sh`（10 行目） | 1 |
| `packages/cli/src/frameworks/hono/templates.ts`（6800 行目・10779 行目） | 2 |

`packages/cli` の 2 件は CLI ソースの JSDoc であり、生成コードには出力されない。
`grep -rn "reuse-cascade contract\|drifted from the contract" samples/` が空になることで確認した。

### `tasks/` と `study-material/` を参照している公開ファイル

フェーズ3で移送すると、次の参照が公開ツリーから解決できなくなる。

| ファイル | 件数 | 備考 |
|---|---|---|
| `docs/implementation-guides/experimental/*.ja.md` / `*.en.md` | 36 | 解説本文と、掲載しているソース全文の両方に含まれる |
| `packages/experimental/src/device-authorization-grant/verification.ts` | 2 | 実装解説に全文掲載されているため、直すと解説側も直す |
| `packages/cli/src/frameworks/hono/templates.ts` | 2 | 生成コードへ出力される。`samples/*/src/oidc-provider` の 8 箇所はこの 2 件が実体 |
| `packages/core/src/token-response.ts` | 1 | |
| `packages/cli/src/__tests__/hono-generator.test.ts` | 1 | |
| `tests/conformance/README.md` | 1 | |
| `.github/scripts/verify-ci-gate.mjs` | 1 | |

### ビルドとテストはメモ類を読まない

`.github/workflows/`、`vitest.config.ts`、`pnpm-workspace.yaml` のいずれもメモ類に依存していない。
`pnpm-workspace.yaml` の対象は `packages/*` `samples/*` `tests/*` `docs/*` だけなので、`.notes` を置いても pnpm のワークスペース走査には入らない。

例外は昇格レビューツールで、`scripts/experimental-review/lib/repo.mjs:62-63` が `tasks/experimental/<feature-id>` を読む。
`pnpm run test:experimental-review` は `pnpm run test:ci` に含まれており、`tasks/` を移すとここだけが壊れる。
決定2に従い、このツールごと削除する（フェーズ4）。

`.github/scripts/verify-ci-gate.mjs` が要求するのは `pnpm run build` → `pnpm run typecheck` → `pnpm run test:ci` の順序だけで、`test:ci` の内訳は検査していない。
`test:ci` から `test:experimental-review` を外しても CI ゲートは通る。

## 全体像

依存関係の順にフェーズを分ける。
フェーズ1まで終われば `CLAUDE.md` は公開ツリーから消える。

| フェーズ | 内容 | 前提 |
|---|---|---|
| 0 | notes リポジトリを private にし、初期コミットを作る | なし |
| 1 | `CLAUDE.md` の分離、`README.md` の切り出し、リンクと同期の仕組み | 0 |
| 2 | Claude Code on the Web からの `.notes` 取得 | 1 |
| 3 | `tasks/` `study-material/` `.review/` `.claude/docs/` の移送と参照修復 | 1 |
| 4 | 昇格レビューツールの削除 | 3 |

## フェーズ0: notes リポジトリの前提整備

- [ ] GitHub の Settings → General → Danger Zone → Change repository visibility で `notes-maronn-openid-connect` を private にする
- [ ] private 化のあと、認証なしの `git clone https://github.com/maronnjapan/notes-maronn-openid-connect` が失敗することを確認する
- [ ] `/var/www/notes-maronn-openid-connect` の内容を push し、リモートが空でない状態にする
- [ ] `/var/www/maronn-openid-provider` で `git remote -v` の origin が `https://github.com/maronnjapan/maronn-openid-connect` であることを確認する
- [ ] `/var/www/notes-maronn-openid-connect` で `git remote -v` の origin が notes リポジトリであることを確認する

## フェーズ1: `CLAUDE.md` の分離と `README.md` の切り出し

### タスク1-1: `README.md` を作る

`CLAUDE.md` の次の節をそのまま `README.md` へ移す。
公開ライブラリの読者に向けた文書なので、移したあとに宛先（開発者向けか利用者向けか）が混ざっていないかを見直す。

| 移す節 | 理由 |
|---|---|
| プロジェクトについて（コンセプト、ターゲットユーザー、差別化の3軸、リリース方針、利用者の入口） | ライブラリの位置づけそのもの |
| 実装におけるルール | 外部コントリビュータにも効く規約 |
| ドキュメント作成の規約 | 同上 |
| テストコードの書き方 | 同上。`.claude/skills/` は公開されているため参照も残せる |
| コマンド | 公開情報 |
| アーキテクチャ | 公開情報 |
| 準拠仕様 | 公開情報 |
| ディレクトリの構成 | 公開情報。ただし `tasks/` と `study-material/` の記述は notes 側へ移った旨に書き換える |

`.notes/CLAUDE.md` に残すのは次の 3 つとする。

- `README.md` を先に読むよう促す 1 行
- レビュー内容について（`.review/` の運用）
- `tasks/` と `study-material/` の運用（`.notes` 配下にある旨とパス）

- [ ] `README.md` を作成する（`japanese-tech-writing` スキルを使う）
- [ ] `.notes/CLAUDE.md` を上記 3 点に絞る
- [ ] 「experimental 機能の昇格レビュー」の節は、フェーズ4のツール削除に合わせて消す

### タスク1-2: `CLAUDE.md` の実体を notes リポジトリへ移す

- [ ] `CLAUDE.md` を `/var/www/notes-maronn-openid-connect/CLAUDE.md` へ移す
- [ ] notes リポジトリでコミットして push する

### タスク1-3: `.gitignore` の更新

`.gitignore` は用途ごとのコメント見出しで区切られている。
末尾に次の節を追加する。

```
# Work notes (notes repository; see scripts/setup-notes.sh)
/.notes
/CLAUDE.md
/AGENTS.md
/GEMINI.md
```

- [ ] 先頭スラッシュ付きで追記する（ルート直下だけを対象にするため）
- [ ] `.notes` に末尾スラッシュを付けない（シンボリックリンクにマッチしなくなるため）

### タスク1-4: 3 ファイルの追跡を外す

- [ ] `git rm --cached CLAUDE.md AGENTS.md GEMINI.md` を実行する
- [ ] `.gitignore` と `README.md` の変更と合わせて 1 コミットにする

### タスク1-5: `scripts/setup-notes.sh` の作成

既存の `scripts/sample-up.sh` に合わせ、`scripts/lib/guide.sh` の出力ヘルパーを使う。
ローカルとクラウドの両方を 1 本で扱う。

- `NOTES_LOCAL_PATH`（既定 `/var/www/notes-maronn-openid-connect`）に git リポジトリがあれば、そこへのシンボリックリンクを張る
- 無ければ notes リポジトリを `.notes` へクローンする（クラウド実行の経路。フェーズ2で使う）
- `--hook` を付けると、SessionStart フック用の JSON だけを出して必ず終了コード 0 で終わる

```bash
#!/usr/bin/env bash
# notes リポジトリをこのリポジトリへ結びつける。
#
#   pnpm notes:setup            ローカル: 既存チェックアウトへ symlink / クラウド: clone
#   pnpm notes:setup -- --hook  SessionStart フック用（JSON だけを出し、常に成功で終わる）
#
# ローカルの置き場所は NOTES_LOCAL_PATH で変えられる。
# private リポジトリを認証付きで取得する場合は NOTES_REPO_TOKEN に read 権限の
# ファイングレイン PAT を渡す（環境変数のみ。リポジトリには置かない）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/guide.sh
. "${SCRIPT_DIR}/lib/guide.sh"

NOTES_LOCAL_PATH="${NOTES_LOCAL_PATH:-/var/www/notes-maronn-openid-connect}"
NOTES_REPO_URL="${NOTES_REPO_URL:-https://github.com/maronnjapan/notes-maronn-openid-connect}"
NOTES_LINK="${ROOT_DIR}/.notes"
HOOK_MARKER="maronn-notes-sync"

HOOK_MODE=0
if [ "${1:-}" = "--hook" ]; then
  HOOK_MODE=1
fi

# フック経由で呼ばれたとき、外側リポジトリの git 環境変数を引き継がない。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX

# worktree でも正しい hooks ディレクトリを指す。
HOOK_PATH="$(git -C "${ROOT_DIR}" rev-parse --git-path hooks/post-merge 2>/dev/null || echo '.git/hooks/post-merge')"
case "${HOOK_PATH}" in
  /*) ;;
  *) HOOK_PATH="${ROOT_DIR}/${HOOK_PATH}" ;;
esac

# 認証が要る場合だけ Authorization ヘッダを付ける。
# URL に埋めるとリモート設定へ残るため、コマンド単位の -c で渡す。
notes_git() {
  if [ -n "${NOTES_REPO_TOKEN:-}" ]; then
    local header
    header="$(printf 'x-access-token:%s' "${NOTES_REPO_TOKEN}" | base64 | tr -d '\n')"
    git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${header}" "$@"
  else
    git "$@"
  fi
}

# 成功時は状態を表す 1 行を、失敗時は理由を 1 行返す。
setup_links() {
  local mode name
  if [ -d "${NOTES_LINK}" ] && [ ! -L "${NOTES_LINK}" ] && [ ! -e "${NOTES_LINK}/.git" ]; then
    # ln -sfn は宛先が実ディレクトリのとき、その中にリンクを作って成功扱いになる。
    echo ".notes が git リポジトリでない実ディレクトリとして存在します: ${NOTES_LINK}"
    return 1
  fi

  if [ -e "${NOTES_LOCAL_PATH}/.git" ]; then
    if [ -d "${NOTES_LINK}" ] && [ ! -L "${NOTES_LINK}" ]; then
      echo ".notes にクローン済みの実体があります。ローカルチェックアウトへ切り替えるには先に削除してください。"
      return 1
    fi
    ln -sfn "${NOTES_LOCAL_PATH}" "${NOTES_LINK}"
    mode="symlink -> ${NOTES_LOCAL_PATH}"
  elif [ -e "${NOTES_LINK}/.git" ]; then
    notes_git -C "${NOTES_LINK}" pull --ff-only --quiet >/dev/null 2>&1 || true
    mode="clone (updated)"
  else
    if ! notes_git clone --quiet "${NOTES_REPO_URL}" "${NOTES_LINK}" >/dev/null 2>&1; then
      echo "notes リポジトリを取得できませんでした: ${NOTES_REPO_URL}"
      return 1
    fi
    mode="clone (fresh)"
  fi

  if [ -f "${ROOT_DIR}/CLAUDE.md" ] && [ ! -L "${ROOT_DIR}/CLAUDE.md" ]; then
    echo "CLAUDE.md が実ファイルとして残っています。先に notes リポジトリへ移してください。"
    return 1
  fi
  if [ ! -f "${NOTES_LINK}/CLAUDE.md" ]; then
    echo ".notes/CLAUDE.md がありません。notes リポジトリの内容を確認してください。"
    return 1
  fi
  ln -sf .notes/CLAUDE.md "${ROOT_DIR}/CLAUDE.md"
  ln -sf CLAUDE.md "${ROOT_DIR}/AGENTS.md"
  ln -sf CLAUDE.md "${ROOT_DIR}/GEMINI.md"

  # フェーズ3で移送するメモ類。notes 側に無いもの、実体が残っているものは飛ばす。
  for name in tasks study-material .review; do
    if [ ! -d "${NOTES_LINK}/${name}" ]; then
      continue
    fi
    if [ -e "${ROOT_DIR}/${name}" ] && [ ! -L "${ROOT_DIR}/${name}" ]; then
      continue
    fi
    ln -sfn ".notes/${name}" "${ROOT_DIR}/${name}"
  done
  if [ -d "${NOTES_LINK}/claude-docs" ]; then
    if [ ! -e "${ROOT_DIR}/.claude/docs" ] || [ -L "${ROOT_DIR}/.claude/docs" ]; then
      ln -sfn ../.notes/claude-docs "${ROOT_DIR}/.claude/docs"
    fi
  fi

  echo "${mode}"
}

# 0: 設置した / 2: 別のフックがあるので触らない
install_hook() {
  if [ -e "${HOOK_PATH}" ] && ! grep -q "${HOOK_MARKER}" "${HOOK_PATH}"; then
    return 2
  fi
  mkdir -p "$(dirname "${HOOK_PATH}")"
  cat > "${HOOK_PATH}" <<'HOOK'
#!/usr/bin/env sh
# maronn-notes-sync: scripts/setup-notes.sh が生成。git pull（merge）後に .notes を追従させる。
"$(git rev-parse --show-toplevel)/scripts/notes-sync.sh" || true
HOOK
  chmod +x "${HOOK_PATH}"
  return 0
}

emit_hook_json() {
  # 改行とダブルクォートだけ最小限にエスケープして 1 つの JSON にする。
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
    "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')"
}

if [ "${HOOK_MODE}" = "1" ]; then
  if result="$(setup_links 2>&1)"; then
    install_hook >/dev/null 2>&1 || true
    emit_hook_json "作業メモは .notes に用意済み（${result}）。規約は README.md、作業メモの運用は .notes/CLAUDE.md を参照すること。tasks / study-material も .notes 配下にある。"
  else
    emit_hook_json "作業メモ（.notes）は取得できなかった: ${result} 規約は README.md を参照すること。"
  fi
  exit 0
fi

guide_step "notes リポジトリを結びつけます"
if ! result="$(setup_links 2>&1)"; then
  guide_err "${result}"
  exit 1
fi
guide_ok ".notes: ${result}"
guide_ok "CLAUDE.md -> .notes/CLAUDE.md / AGENTS.md・GEMINI.md -> CLAUDE.md"

guide_step "git pull 後の追従フックを設定します"
set +e
install_hook
hook_status=$?
set -e
if [ "${hook_status}" = "2" ]; then
  guide_warn "既存の post-merge フックがあるため上書きしません: ${HOOK_PATH}"
  guide_info "次の1行を既存フックへ追記してください:"
  guide_info '  "$(git rev-parse --show-toplevel)/scripts/notes-sync.sh" || true'
else
  guide_ok "post-merge フックを設定しました。"
fi

guide_info "git fetch 単体と git pull --rebase にはフックが無いため、pnpm notes:sync を使ってください。"
guide_ok "セットアップが完了しました。"
```

- [ ] `chmod +x scripts/setup-notes.sh` を実行する

### タスク1-6: `scripts/notes-sync.sh` の作成

```bash
#!/usr/bin/env bash
# .notes（notes リポジトリ）を最新へ追従させる。
#
#   pnpm notes:sync
#
# scripts/setup-notes.sh が設定する post-merge フックからも呼ばれる。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/guide.sh
. "${SCRIPT_DIR}/lib/guide.sh"

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX

NOTES_LINK="${ROOT_DIR}/.notes"

notes_git() {
  if [ -n "${NOTES_REPO_TOKEN:-}" ]; then
    local header
    header="$(printf 'x-access-token:%s' "${NOTES_REPO_TOKEN}" | base64 | tr -d '\n')"
    git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${header}" "$@"
  else
    git "$@"
  fi
}

if [ ! -e "${NOTES_LINK}/.git" ]; then
  guide_info ".notes が未設定のためスキップします（pnpm notes:setup で設定できます）。"
  exit 0
fi

guide_step ".notes を追従させます"
if ! notes_git -C "${NOTES_LINK}" fetch; then
  guide_err ".notes の fetch に失敗しました。"
  exit 1
fi
if ! notes_git -C "${NOTES_LINK}" pull --ff-only; then
  guide_err ".notes を fast-forward できませんでした。手動で確認してください。"
  exit 1
fi
guide_ok ".notes を更新しました。"
```

- [ ] `chmod +x scripts/notes-sync.sh` を実行する
- [ ] `--ff-only` にする（メモ側にローカル変更があるとき、勝手にマージコミットを作らないため）

### タスク1-7: `package.json` にコマンドを追加する

既存の `sample:*` / `deploy:*` と同じ形式で追加する。

```json
"notes:setup": "bash scripts/setup-notes.sh",
"notes:sync": "bash scripts/notes-sync.sh",
```

- [ ] `scripts` の並びの先頭側（`sample:*` の直前）へ追加する

### タスク1-8: 公開ファイルの `CLAUDE.md` 参照を `README.md` へ差し替える

- [ ] `RELEASE.md:161` / `RELEASE.md:468`
- [ ] `docs/implementation-guides/experimental/README.md:47`（日本語）と `:53`（英語）
- [ ] `samples/README.md:3`
- [ ] `samples/nextjs-vercel/scripts/deploy-vercel.sh:7`
- [ ] `samples/hono-cloudflare/scripts/deploy-cloudflare.sh:7`
- [ ] `scripts/lib/deploy-fly-node-sample.sh:10`
- [ ] `packages/cli/src/frameworks/hono/templates.ts:6800` / `:10779`
- [ ] `grep -rn 'CLAUDE\.md' --exclude-dir=node_modules --exclude-dir=tasks --exclude-dir=study-material --exclude-dir=.claude .` が 0 件になる

### タスク1-9: 動作確認

タスク1-5とタスク1-6のスクリプトは、notes 側と OSS 側の upstream を模したサンドボックスで動かし、symlink 経路・clone 経路・`--hook` の成功と失敗・post-merge の追従・ガード（`.notes` が実ディレクトリ、`CLAUDE.md` が実ファイル、`tasks/` が実ディレクトリのまま、notes 取得失敗、既存 post-merge フックあり、`.notes` 未設定）を確認してある（2026-08-23、git 2.43.0）。`NOTES_REPO_TOKEN` を設定した経路では、`.git/config` にも `.notes/.git/config` にもトークンが残らないことを確認した。
実環境での確認は次の手順で行う。

- [ ] `pnpm notes:setup` を実行する
- [ ] `readlink .notes` が `/var/www/notes-maronn-openid-connect` を返す
- [ ] `readlink CLAUDE.md` が `.notes/CLAUDE.md`、`readlink AGENTS.md` と `readlink GEMINI.md` が `CLAUDE.md` を返す
- [ ] `head -1 CLAUDE.md` で notes リポジトリ側の中身が読める
- [ ] `git status --porcelain` に `.notes` `CLAUDE.md` `AGENTS.md` `GEMINI.md` が現れない
- [ ] `git check-ignore -v .notes CLAUDE.md AGENTS.md GEMINI.md` が 4 行返す
- [ ] `git -C .notes rev-parse HEAD` を控えてから `git pull` を実行し、`.notes` 側の HEAD も更新される
- [ ] `packages/core` などサブディレクトリで `git pull` を実行しても `.notes` が追従する
- [ ] `git fetch` のあと `pnpm notes:sync` で `.notes` が追従する
- [ ] `pnpm --filter @maronn-openid-connect/cli test` と `pnpm run test:supply-chain` が通る

## フェーズ2: Claude Code on the Web からの `.notes` 取得

クラウドセッションはコンテナ起動時に OSS実装リポジトリだけをクローンする。
`.notes` は追跡対象外なので、セッション側で取得する必要がある。
取得経路は 3 つあり、上から順に試す。

| 経路 | 仕組み | 前提 |
|---|---|---|
| A: セッションの git 認証で clone | `scripts/setup-notes.sh` の clone 経路がそのまま通る | 接続した GitHub アカウントの認証がプロキシ経由で private リポジトリにも及ぶこと |
| B: 環境変数のトークンで clone | `NOTES_REPO_TOKEN` を cloud environment の環境変数に置き、`http.extraheader` で認証する | notes リポジトリだけに read 権限を持つファイングレイン PAT を発行できること |
| C: セッション内でリポジトリを追加してから clone | エージェントがリポジトリ追加を実行し、その後 `pnpm notes:setup` を呼ぶ | 毎セッションでエージェント操作が要る |

経路Aが通るかは環境設定に依存するため、フェーズ2の最初に 1 セッションで試す。
通らない場合は経路Bを既定にする。

### タスク2-1: 経路Aの可否を確認する

- [ ] notes リポジトリを private にした状態でクラウドセッションを開き、`git clone https://github.com/maronnjapan/notes-maronn-openid-connect /tmp/notes-probe` が成功するか確かめる
- [ ] 成功したら経路Aを採用し、タスク2-2 は環境変数なしで進める

### タスク2-2: 経路B（トークン）の設定

- [ ] GitHub の Settings → Developer settings → Personal access tokens → Fine-grained tokens で、`notes-maronn-openid-connect` のみ・Contents: Read-only・有効期限つきのトークンを発行する
- [ ] Claude Code の cloud environment 設定（環境変数）に `NOTES_REPO_TOKEN` として登録する
- [ ] トークンをリポジトリのファイル・コミットメッセージ・PR 本文へ書かない
- [ ] `scripts/setup-notes.sh` はコマンド単位の `-c http.extraheader` でトークンを渡し、`.git/config` へ残さない（実装済み）

### タスク2-3: SessionStart フックを追加する

`.claude/settings.json` の `SessionStart` に 2 つ目のフックを足す。
既存の `npx -y gh-setup-hooks` は残す。

```json
{
  "type": "command",
  "command": "bash \"${CLAUDE_PROJECT_DIR}/scripts/setup-notes.sh\" --hook",
  "timeout": 120
}
```

- [ ] `--hook` は常に終了コード 0 で終わり、JSON 以外を標準出力へ出さない（実装済み）
- [ ] 取得に失敗したときも、`README.md` を参照するよう促す JSON を返す
- [ ] ローカルセッションでも同じフックが動くため、`NOTES_LOCAL_PATH` があれば symlink 経路になることを確認する

### タスク2-4: 動作確認

- [ ] クラウドセッションを開き、`.notes` が実クローンとして存在する
- [ ] `cat CLAUDE.md` が notes 側の内容を返す
- [ ] `git status --porcelain` に `.notes` が現れない
- [ ] `pnpm notes:sync` でクラウド側の `.notes` も更新できる
- [ ] notes を取得できない状態（トークン未設定など）でも、セッションが正常に開始し、フックのメッセージが `README.md` を案内する

## フェーズ3: メモ類の移送と参照修復

### タスク3-1: 移送

notes リポジトリ側のディレクトリ名は、OSS実装リポジトリ側のリンク名に合わせる。
`.claude/docs` だけは notes 側で `claude-docs` とし、`.claude` 配下のリンクから参照する。

| 移送元 | 移送先 | リンク |
|---|---|---|
| `tasks/` | `.notes/tasks/` | `tasks -> .notes/tasks` |
| `study-material/` | `.notes/study-material/` | `study-material -> .notes/study-material` |
| `.review/` | `.notes/.review/` | `.review -> .notes/.review` |
| `.claude/docs/` | `.notes/claude-docs/` | `.claude/docs -> ../.notes/claude-docs` |

- [ ] `git mv` ではなく、notes リポジトリへコピーしてから OSS実装リポジトリ側で `git rm -r` する（履歴は notes 側で作り直す）
- [ ] 本タスク文書も `tasks/` と一緒に移す（決定3）
- [ ] `.gitignore` に `/tasks` `/study-material` `/.review` `/.claude/docs` を追加する
- [ ] `pnpm notes:setup` を再実行し、4 つのリンクが張られることを確認する

### タスク3-2: 参照修復

移送で解決できなくなる参照を直す。
パスを書かず、内容で説明する形へ寄せる（`tasks/p2-doc-path-reference-repair-and-link-check.md` の表記規約の議論と揃える）。

- [ ] `packages/cli/src/frameworks/hono/templates.ts` の 2 件。生成コードへ出力されるため、修正後に `samples/*` を再生成する
- [ ] `packages/experimental/src/device-authorization-grant/verification.ts` の 2 件。`docs/implementation-guides/experimental/device-authorization-grant.{ja,en}.md` の掲載コードも同じ変更で直す
- [ ] `packages/core/src/token-response.ts` の 1 件
- [ ] `packages/cli/src/__tests__/hono-generator.test.ts` の 1 件
- [ ] `tests/conformance/README.md` の 1 件
- [ ] `.github/scripts/verify-ci-gate.mjs` の 1 件
- [ ] `docs/implementation-guides/experimental/*.{ja,en}.md` の残り
- [ ] `grep -rnE '(tasks|study-material)/[A-Za-z0-9._/-]+\.(md|yaml)' --exclude-dir=node_modules .` が 0 件になる

### タスク3-3: 動作確認

- [ ] `pnpm run build` と `pnpm run typecheck` が通る
- [ ] `pnpm --filter "./packages/*" test` が通る
- [ ] `pnpm run test:conformance` が通る（`samples/*` を再生成したため）

## フェーズ4: 昇格レビューツールの削除

決定2に従い、`tasks/experimental/*/promotion-review/` を生成する仕組みを畳む。
パケット自体は `tasks/` と一緒に notes 側へ移るため、生成物が消えるわけではない。

- [ ] `scripts/experimental-review/` を削除する
- [ ] `package.json` から `review:experimental` と `test:experimental-review` を削除し、`test:ci` の連結からも外す
- [ ] `docs/implementation-guides/experimental/README.md`（日英）と `package-overview.{ja,en}.md` の言及（計 6 箇所）を削除または書き換える
- [ ] `.notes/CLAUDE.md` の「experimental 機能の昇格レビュー」節を削除する（タスク1-1 で先に消していれば確認だけ）
- [ ] `pnpm run test:ci` が通る
- [ ] `pnpm run test:ci-gate` が通る（`build` → `typecheck` → `test:ci` の順序は変えないため通るはず）

## 完了条件

- 以後のコミットと main の公開ツリーに `.notes` `CLAUDE.md` `AGENTS.md` `GEMINI.md` `tasks/` `study-material/` `.review/` `.claude/docs/` が含まれない
- 公開リポジトリのルートに `README.md` があり、開発規約が読める
- `pnpm notes:setup` の実行だけで、ローカルでは symlink、クラウドでは clone として `.notes` が用意される
- クラウドセッションの開始時に `.notes` が取得され、取得できない場合も `README.md` を案内して正常に開始する
- `git pull` を実行すると、サブディレクトリからでも `.notes` が追従する
- 公開ファイルに `CLAUDE.md` `tasks/` `study-material/` への解決できない参照が残っていない
- `pnpm run test:ci` と `pnpm run test:e2e` が緑

過去の履歴に残る `CLAUDE.md` は削除しない。
`git rm --cached` が消すのは tip のツリーだけであり、履歴から消すには 218 コミットを書き換えて force push する必要がある。
それは 10 件以上の open PR のブランチを無効化する。
`CLAUDE.md` の中身は開発規約であって資格情報ではなく、フェーズ1で公開部分は `README.md` へ移るため、履歴書き換えの費用に見合わない。

`tasks/` と `study-material/` も同様に、過去の履歴には残る。
公開したくない記述が含まれている場合は、移送前に該当箇所を洗い出す必要がある。

- [ ] 移送対象のメモに、公開したくない記述（資格情報、他者の非公開情報）が含まれていないかを確認する。含まれる場合は履歴書き換えの要否を別途判断する

## スコープ外

- notes リポジトリへの push 自動化
- notes リポジトリと OSS実装リポジトリ間の自動マージとコンフリクト解決
- 履歴からの削除（「完了条件」に理由を記載）
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

- `.claude/settings.json` の Windows 依存の通知フックと、`.mcp.json` のローカルパス。公開されているが秘匿情報ではない。分離するなら `.claude/settings.local.json` への移動を含めて別タスクで扱う

## 元の指示書からの変更点

| 元の記述 | 変更内容 | 理由 |
|---|---|---|
| notes リポジトリは非公開という前提 | private 化と初期 push をフェーズ0として明示 | 実際には public かつコミットが 1 つも無い |
| `.gitignore` に `.notes/` | `/.notes` へ変更 | 末尾スラッシュ付きパターンはシンボリックリンクにマッチしない |
| `.gitignore` に `CLAUDE.md` | `/CLAUDE.md` `/AGENTS.md` `/GEMINI.md` へ拡張 | `AGENTS.md` と `GEMINI.md` は `CLAUDE.md` を指す追跡済みリンクで、放置すると公開ツリーで壊れる |
| タスク2「該当する場合のみ」 | 必須手順に変更 | `CLAUDE.md` は追跡済み |
| `git config alias.fetch` / `alias.pull` | post-merge フックと `pnpm notes:sync` に置き換え | git は組み込みコマンドを隠すエイリアスを無視する |
| `ln -sfn` を無条件実行 | `.notes` が実ディレクトリのとき停止する判定を追加 | 実ディレクトリ宛てだと、その中にリンクを作って成功扱いになる |
| `CLAUDE.md` を `ln -sf` で無条件上書き | 実ファイルが残っているとき停止する判定を追加 | 退避前に実行すると実体を消す |
| スクリプトを素の `echo` で構成 | `scripts/lib/guide.sh` の出力ヘルパーを使用 | 既存スクリプトの規約に合わせる |
| 起動手段が `bash scripts/setup-notes.sh` | `pnpm notes:setup` / `pnpm notes:sync` を追加 | ルート `package.json` の `sample:*` / `deploy:*` と同じ入口に揃える |
| 対象は `CLAUDE.md` のみ | `README.md` 切り出し、メモ類 4 種の移送、昇格レビューツール削除を追加 | 依頼者の決定1・2・3 |
| クラウド実行は対象外 | フェーズ2として取り込み、取得経路を 3 つ用意 | 依頼者の決定4 |
| 参照修復の記載なし | `CLAUDE.md` 参照 10 件とメモパス参照 44 件の修復をタスク化 | 移送すると公開ツリーから解決できなくなる |
| 受け入れ基準「コミット履歴に一切含まれていない」 | 「以後のコミットと main の公開ツリーに含まれない」へ変更 | 履歴書き換えは 218 コミットの force push と open PR の無効化を伴う |
