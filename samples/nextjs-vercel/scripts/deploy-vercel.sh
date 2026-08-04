#!/usr/bin/env bash
# One-command deploy of the nextjs-vercel sample OP to Vercel + Upstash Redis.
#
# This is verification tooling for maintainers of this repository: it puts the
# CLI-generated OP onto real Vercel infrastructure so the Upstash Redis REST
# storage backend can be checked against an actual HTTPS deployment. It is not
# a production deployment guide for library users (see CLAUDE.md).
#
# Zero-argument usage is the intended path. The script automates everything the
# Vercel CLI allows: project link, env pull, local monorepo build
# (`vercel build`), and prebuilt deploy. Building locally matters because the
# sample depends on `@maronn-openid-connect/core: workspace:*`, which only resolves
# inside this pnpm workspace — `vercel deploy --prebuilt` then uploads the
# finished build output, so Vercel never has to install workspace deps itself.
#
# Human steps the guide walks through when they are unavoidable:
#   - Vercel login (browser / email confirmation)
#   - Upstash Redis credentials: Vercel cannot create the database via CLI, so
#     the guide explains where to create it (Vercel Marketplace or Upstash
#     console) and accepts the two REST values as pasted input.
#
# The issuer works like the other samples: the production URL is only known
# after the first deploy, so the first run deploys once, pins the reported URL
# as OIDC_ISSUER, and deploys again. The URL is persisted to .deploy/issuer so
# every later run deploys exactly once. Use --issuer for a custom domain.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${SAMPLE_DIR}/../.." && pwd)"
# shellcheck source=scripts/lib/guide.sh
. "${ROOT_DIR}/scripts/lib/guide.sh"

# Pinned so every run resolves the same CLI major; pnpm dlx caches it after
# the first download, so no global install is required.
VERCEL_PKG="vercel@56"
PROJECT_NAME="maronn-oidc-sample-nextjs-vercel"
STATE_DIR="${SAMPLE_DIR}/.deploy"
ISSUER_FILE="${STATE_DIR}/issuer"

ISSUER="${OIDC_DEPLOY_ISSUER:-}"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --issuer) ISSUER="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      cat <<EOF
Usage: deploy-vercel.sh [--issuer <https://...>] [--dry-run]

引数なしで実行するとガイド付きでデプロイします:
  1. pnpm / 依存関係 / @maronn-openid-connect/core のビルドを準備
  2. Vercel 未ログインなら 'vercel login' を起動
  3. プロジェクト（${PROJECT_NAME}）を作成またはリンク
  4. Upstash Redis の環境変数（UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN）が
     未設定なら、作成手順を案内して貼り付け入力で設定
  5. ローカルで 'vercel build' を実行し、--prebuilt で本番デプロイ
     （workspace 依存の @maronn-openid-connect/core を含めてローカルで解決）
  6. 公開URLを OIDC_ISSUER として固定（初回のみ2回デプロイ）し、Discovery で検証

ISSUER は .deploy/issuer に保存され、次回以降は1回のデプロイで完了します。
非対話環境（CI等）では VERCEL_TOKEN を設定してください。
EOF
      exit 0
      ;;
    *) guide_err "不明な引数です: $1（--help で使い方を表示）"; exit 1 ;;
  esac
done

TOKEN_ARGS=()
if [ -n "${VERCEL_TOKEN:-}" ]; then
  TOKEN_ARGS=(--token "${VERCEL_TOKEN}")
fi

vercel_cmd() {
  (cd "${SAMPLE_DIR}" && pnpm dlx "${VERCEL_PKG}" "$@" ${TOKEN_ARGS[0]:+"${TOKEN_ARGS[@]}"})
}

run() {
  guide_info "実行: vercel $*"
  if [ "${DRY_RUN}" = "1" ]; then
    return 0
  fi
  vercel_cmd "$@"
}

guide_step "Vercel へのデプロイを開始します（サンプル: nextjs-vercel）"

# ── ツールチェーンと依存関係 ───────────────────────────────────────────
guide_require_node_version 22 13
guide_require_pnpm
guide_ensure_workspace_deps "${ROOT_DIR}"
guide_info "@maronn-openid-connect/core をビルドします。"
if [ "${DRY_RUN}" != "1" ]; then
  (cd "${ROOT_DIR}" && pnpm --filter @maronn-openid-connect/core build >/dev/null)
fi
guide_ok "ツールチェーンの準備ができました（Vercel CLI は pnpm dlx 経由で使用、グローバルインストール不要）。"

if [ "${DRY_RUN}" = "1" ]; then
  guide_info "実行: vercel login（未ログイン時のみ）"
  guide_info "実行: vercel link --yes --project ${PROJECT_NAME}"
  guide_info "実行: vercel env ls production（UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN を確認）"
  guide_info "実行: vercel pull --yes --environment=production"
  guide_info "実行: vercel build --prod"
  guide_info "実行: vercel deploy --prebuilt --prod"
  guide_ok "--dry-run のため、実際の Vercel API 呼び出しは行いませんでした。"
  exit 0
fi

# ── Vercel ログイン ────────────────────────────────────────────────────
if ! vercel_cmd whoami >/dev/null 2>&1; then
  guide_warn "Vercel に未ログインです。"
  guide_info "これから 'vercel login' を起動します。案内に従ってログインしてください（アカウントが無い場合は https://vercel.com/signup で無料登録できます）。"
  if ! guide_is_tty; then
    guide_err "非対話環境ではログインできません。VERCEL_TOKEN を設定して再実行してください。"
    exit 1
  fi
  vercel_cmd login
fi
guide_ok "Vercel にログイン済みです。"

# ── プロジェクトのリンク ──────────────────────────────────────────────
if [ ! -f "${SAMPLE_DIR}/.vercel/project.json" ]; then
  guide_step "Vercel プロジェクトを作成 / リンクします"
  run link --yes --project "${PROJECT_NAME}"
else
  guide_ok "リンク済みの Vercel プロジェクトを再利用します（.vercel/project.json）。"
fi

# ── Upstash Redis 環境変数の確認（無ければガイド付きで設定） ───────────
guide_step "ストレージ（Upstash Redis）の環境変数を確認します"
env_list="$(vercel_cmd env ls production 2>/dev/null || true)"
missing=()
for name in UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN; do
  if ! printf '%s' "${env_list}" | grep -q "${name}"; then
    missing+=("${name}")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  guide_warn "未設定の環境変数があります: ${missing[*]}"
  guide_info "このサンプルは Vercel 上では Upstash Redis REST をストレージに使います。値の入手方法は次のどちらでも構いません:"
  guide_info "  A) Vercel ダッシュボード → プロジェクト → Storage → Upstash (Marketplace) で Redis を作成"
  guide_info "     （この場合は環境変数が自動注入されるので、完了後にこのスクリプトを再実行するだけです）"
  guide_info "  B) https://console.upstash.com で Redis データベースを作成し、『REST API』欄の"
  guide_info "     UPSTASH_REDIS_REST_URL と UPSTASH_REDIS_REST_TOKEN をこの場に貼り付け"
  if ! guide_confirm "いま値を貼り付けて設定しますか？（n の場合は A) の完了後に再実行してください）" y; then
    guide_info "Marketplace 連携の完了後、もう一度このコマンドを実行してください。"
    exit 0
  fi
  for name in "${missing[@]}"; do
    case "${name}" in
      UPSTASH_REDIS_REST_URL)
        guide_ask value "UPSTASH_REDIS_REST_URL（例: https://xxxx.upstash.io）" ""
        ;;
      *)
        guide_ask_secret value "UPSTASH_REDIS_REST_TOKEN"
        ;;
    esac
    printf '%s' "${value}" | vercel_cmd env add "${name}" production >/dev/null
    guide_ok "${name} を production に設定しました。"
  done
fi
guide_ok "ストレージの環境変数が揃っています。"

# ── ISSUER の解決（前回値 → 初回はデプロイ結果から確定） ───────────────
if [ -z "${ISSUER}" ] && [ -f "${ISSUER_FILE}" ]; then
  ISSUER="$(head -n 1 "${ISSUER_FILE}" | tr -d '[:space:]')"
  if [ -n "${ISSUER}" ]; then
    guide_info "前回の issuer を再利用します: ${ISSUER}（変更する場合は --issuer を指定）"
  fi
fi

set_issuer_env() {
  local issuer_value="$1"
  vercel_cmd env rm OIDC_ISSUER production --yes >/dev/null 2>&1 || true
  printf '%s' "${issuer_value}" | vercel_cmd env add OIDC_ISSUER production >/dev/null
  guide_ok "OIDC_ISSUER=${issuer_value} を production に設定しました。"
}

build_and_deploy() {
  local log_file="${STATE_DIR}/last-deploy.log"
  mkdir -p "${STATE_DIR}"
  guide_info "実行: vercel pull --yes --environment=production"
  vercel_cmd pull --yes --environment=production >/dev/null
  guide_info "実行: vercel build --prod（ローカルビルド。workspace 依存をここで解決します）"
  vercel_cmd build --prod
  guide_info "実行: vercel deploy --prebuilt --prod"
  vercel_cmd deploy --prebuilt --prod 2>&1 | tee "${log_file}"
  DEPLOYED_URL="$(grep -oE 'https://[A-Za-z0-9.-]+\.vercel\.app' "${log_file}" | tail -n 1 || true)"
}

guide_step "ビルドしてデプロイします"
if [ -n "${ISSUER}" ]; then
  if ! vercel_cmd env ls production 2>/dev/null | grep -q OIDC_ISSUER; then
    set_issuer_env "${ISSUER}"
  fi
  build_and_deploy
else
  guide_info "初回デプロイのため、まず公開URLを確定させます（このあと OIDC_ISSUER を固定してもう一度デプロイします）。"
  build_and_deploy
  if [ -z "${DEPLOYED_URL}" ]; then
    guide_err "デプロイ出力から公開URLを特定できませんでした。上のログのURLを確認し、--issuer <URL> を付けて再実行してください。"
    exit 1
  fi
  ISSUER="${DEPLOYED_URL}"
  guide_ok "公開URLを確認しました: ${ISSUER}"
  set_issuer_env "${ISSUER}"
  guide_info "OIDC_ISSUER を反映するため再デプロイします。"
  build_and_deploy
fi
mkdir -p "${STATE_DIR}"
printf '%s\n' "${ISSUER}" > "${ISSUER_FILE}"

# ── デプロイ結果の検証 ────────────────────────────────────────────────
guide_step "Discovery エンドポイントで issuer の一致を確認します"
discovery="$(curl -sf "${ISSUER}/.well-known/openid-configuration" || true)"
if [ -z "${discovery}" ]; then
  guide_err "Discovery エンドポイントへの疎通確認に失敗しました: ${ISSUER}/.well-known/openid-configuration"
  exit 1
fi
if ! printf '%s' "${discovery}" | ISSUER="${ISSUER}" node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const m=JSON.parse(d);process.exit(m.issuer===process.env.ISSUER?0:1)})"; then
  guide_err "Discovery の issuer が ${ISSUER} と一致しません。--issuer で正しい公開URLを指定して再実行してください。"
  exit 1
fi
guide_ok "デプロイが完了しました: ${ISSUER}"
guide_info "動作確認: curl ${ISSUER}/.well-known/openid-configuration"
guide_warn "サンプルの署名鍵は起動時生成のため、複数インスタンス間で鍵が一致しない可能性があります。本番相当の検証では固定鍵の読み込みに置き換えてください。"
guide_info "後片付けする場合: Vercel ダッシュボードからプロジェクト ${PROJECT_NAME} を削除してください。"
