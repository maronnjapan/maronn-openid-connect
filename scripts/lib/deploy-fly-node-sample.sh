#!/usr/bin/env bash
# Shared Fly.io deploy routine for the single-process Node.js samples
# (express-flyio / fastify-flyio) that persist state to a local node:sqlite
# file.
#
# This is verification tooling for maintainers of this repository: it spins
# up a sample OP on real infrastructure so the sqlite-on-a-volume storage
# backend can be checked against an actual HTTP/TLS deployment. It is not a
# production deployment guide for library users — samples/* exist for
# internal verification of CLI-generated code (see the repository README.md).
#
# Zero-argument usage is the intended path: everything that can be derived
# is derived, and the script guides interactively through the only two
# things it cannot do alone (flyctl install and Fly login). The chosen app
# name is persisted to <sample>/.deploy/fly-app-name so re-deploys never
# ask again.
#
# Per-sample wrapper scripts (samples/<name>/scripts/deploy-fly.sh) set
# SAMPLE_DIR / SAMPLE_PACKAGE and exec this script with the user's CLI
# arguments.
set -euo pipefail

: "${SAMPLE_DIR:?SAMPLE_DIR must be set by the caller (e.g. samples/express-flyio)}"
: "${SAMPLE_PACKAGE:?SAMPLE_PACKAGE must be set by the caller (e.g. @maronn-openid-connect/sample-express-flyio)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=scripts/lib/guide.sh
. "${SCRIPT_DIR}/guide.sh"

SAMPLE_NAME="$(basename "${SAMPLE_DIR}")"
STATE_DIR="${ROOT_DIR}/${SAMPLE_DIR}/.deploy"
APP_NAME_FILE="${STATE_DIR}/fly-app-name"

APP_NAME="${FLY_APP_NAME:-}"
REGION="nrt"
ORG="personal"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --app-name) APP_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      cat <<EOF
Usage: deploy-fly.sh [--app-name <globally-unique-name>] [--region <region>] [--org <org>] [--dry-run]

引数なしで実行するとガイド付きでデプロイします:
  1. flyctl が無ければインストールを提案
  2. 未ログインなら 'fly auth login' を起動
  3. アプリ名は前回の値（${SAMPLE_DIR}/.deploy/fly-app-name）を再利用。
     初回は自動生成した候補を提示（Fly のアプリ名は全アカウントでグローバル一意）
  4. アプリ・ボリュームを作成（既存なら再利用）してデプロイし、
     https://<app-name>.fly.dev の Discovery で issuer を検証

非対話環境（CI等）では --app-name または FLY_APP_NAME が必須です。
EOF
      exit 0
      ;;
    *) guide_err "不明な引数です: $1（--help で使い方を表示）"; exit 1 ;;
  esac
done

guide_step "Fly.io へのデプロイを開始します（サンプル: ${SAMPLE_NAME}）"

# ── flyctl の確認（無ければインストールをガイド） ──────────────────────
if [ -d "${HOME}/.fly/bin" ]; then
  PATH="${HOME}/.fly/bin:${PATH}"
fi
if ! command -v fly >/dev/null 2>&1 && ! command -v flyctl >/dev/null 2>&1 && [ "${DRY_RUN}" != "1" ]; then
  guide_warn "flyctl（Fly.io CLI）が見つかりません。"
  if guide_confirm "公式インストールスクリプト（https://fly.io/install.sh）で flyctl をインストールしますか？" y; then
    guide_run bash -c 'curl -fsSL https://fly.io/install.sh | sh'
    PATH="${HOME}/.fly/bin:${PATH}"
  fi
fi
if ! command -v fly >/dev/null 2>&1 && ! command -v flyctl >/dev/null 2>&1; then
  if [ "${DRY_RUN}" = "1" ]; then
    # dry-run はコマンドを表示するだけなので、flyctl 未導入でも続行できる。
    FLY_BIN="fly"
  else
    guide_err "flyctl が利用できません。https://fly.io/docs/flyctl/install/ を参照してインストール後、再実行してください。"
    exit 1
  fi
else
  FLY_BIN="$(command -v fly || command -v flyctl)"
fi
guide_ok "flyctl: ${FLY_BIN}"

# ── ログイン状態の確認（未ログインならブラウザログインをガイド） ───────
if [ "${DRY_RUN}" != "1" ]; then
  if ! "${FLY_BIN}" auth whoami >/dev/null 2>&1; then
    guide_warn "Fly.io に未ログインです。"
    guide_info "これから 'fly auth login' を起動します。ブラウザが開くので、Fly.io アカウントでログインしてください（アカウントが無い場合はその場で無料登録できます）。"
    if ! guide_is_tty; then
      guide_err "非対話環境ではログインできません。先に 'fly auth login' を済ませるか、FLY_API_TOKEN を設定してください。"
      exit 1
    fi
    guide_run "${FLY_BIN}" auth login
  fi
  guide_ok "ログイン済み: $("${FLY_BIN}" auth whoami 2>/dev/null || echo '(確認済み)')"
fi

# ── アプリ名の決定（前回値を再利用 → 無ければ生成候補を提示） ─────────
if [ -z "${APP_NAME}" ] && [ -f "${APP_NAME_FILE}" ]; then
  APP_NAME="$(head -n 1 "${APP_NAME_FILE}" | tr -d '[:space:]')"
  if [ -n "${APP_NAME}" ]; then
    guide_info "前回使用したアプリ名を再利用します: ${APP_NAME}（変更する場合は --app-name を指定）"
  fi
fi
if [ -z "${APP_NAME}" ]; then
  suffix="$(node -e 'console.log(require("node:crypto").randomBytes(3).toString("hex"))' 2>/dev/null || date +%s | tail -c 7)"
  default_app_name="maronn-openid-connect-${SAMPLE_NAME}-${suffix}"
  guide_info "Fly のアプリ名は全アカウントを通じてグローバルに一意である必要があるため、衝突しにくい候補を生成しました。"
  guide_ask APP_NAME "使用するアプリ名（公開URLは https://<アプリ名>.fly.dev になります）" "${default_app_name}"
fi
if [ "${DRY_RUN}" != "1" ]; then
  mkdir -p "${STATE_DIR}"
  printf '%s\n' "${APP_NAME}" > "${APP_NAME_FILE}"
fi

ISSUER="https://${APP_NAME}.fly.dev"
VOLUME_NAME="oidc_data"

run() {
  guide_info "実行: $*"
  if [ "${DRY_RUN}" = "1" ]; then
    return 0
  fi
  "$@"
}

# ── アプリ・ボリュームの作成（既存なら再利用） ─────────────────────────
guide_step "Fly アプリとボリュームを準備します"
app_exists=0
if [ "${DRY_RUN}" != "1" ] && "${FLY_BIN}" status --app "${APP_NAME}" >/dev/null 2>&1; then
  app_exists=1
fi
if [ "${app_exists}" = "1" ]; then
  guide_ok "アプリ ${APP_NAME} は既に存在するため再利用します。"
else
  run "${FLY_BIN}" apps create "${APP_NAME}" --org "${ORG}"
fi

volume_exists=0
if [ "${DRY_RUN}" != "1" ] && "${FLY_BIN}" volumes list --app "${APP_NAME}" --json 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const v=JSON.parse(d);process.exit(v.some(x=>x.Name==='${VOLUME_NAME}')?0:1)}catch{process.exit(1)}})"; then
  volume_exists=1
fi
if [ "${volume_exists}" = "1" ]; then
  guide_ok "Volume ${VOLUME_NAME} は既に存在するため再利用します。"
else
  run "${FLY_BIN}" volumes create "${VOLUME_NAME}" --app "${APP_NAME}" --region "${REGION}" --size 1 --yes
fi

# ── デプロイ（ビルドは Fly のリモートビルダーで実行、ローカル Docker 不要） ─
guide_step "デプロイします（初回はリモートビルドに数分かかります）"
guide_info "リポジトリルートを Docker ビルドコンテキストとしてデプロイします（Dockerfile は ${SAMPLE_DIR}/Dockerfile）。"
guide_info "issuer は ${ISSUER} を使用します（Fly のデフォルトホスト名から決定的に導出）。"
run "${FLY_BIN}" deploy \
  --app "${APP_NAME}" \
  --config "${SAMPLE_DIR}/fly.toml" \
  --dockerfile "${SAMPLE_DIR}/Dockerfile" \
  --build-context "${ROOT_DIR}" \
  --region "${REGION}" \
  --env "HOST=0.0.0.0" \
  --env "ISSUER=${ISSUER}" \
  --remote-only \
  --yes

if [ "${DRY_RUN}" = "1" ]; then
  guide_ok "--dry-run のため、実際の Fly API 呼び出しは行いませんでした。"
  exit 0
fi

# ── デプロイ結果の検証 ────────────────────────────────────────────────
guide_step "Discovery エンドポイントで issuer の一致を確認します"
discovery="$(curl -sf "${ISSUER}/.well-known/openid-configuration" || true)"
if [ -z "${discovery}" ]; then
  guide_err "Discovery エンドポイントへの疎通確認に失敗しました: ${ISSUER}/.well-known/openid-configuration"
  exit 1
fi
if ! printf '%s' "${discovery}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const m=JSON.parse(d);process.exit(m.issuer==='${ISSUER}'?0:1)})"; then
  guide_err "Discovery の issuer が ${ISSUER} と一致しません。"
  exit 1
fi
guide_ok "デプロイが完了しました: ${ISSUER}"
guide_info "動作確認: curl ${ISSUER}/.well-known/openid-configuration"
guide_info "後片付けする場合: fly apps destroy ${APP_NAME} --yes"
