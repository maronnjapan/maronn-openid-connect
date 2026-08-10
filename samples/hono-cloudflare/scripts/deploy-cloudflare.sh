#!/usr/bin/env bash
# One-command deploy of the hono-cloudflare sample OP to Cloudflare Workers + D1.
#
# This is verification tooling for maintainers of this repository: it puts the
# CLI-generated OP onto real Cloudflare infrastructure so the D1 storage
# backend can be checked against an actual HTTPS deployment. It is not a
# production deployment guide for library users (see CLAUDE.md).
#
# Zero-argument usage is the intended path. The script automates everything
# wrangler allows: D1 database creation/reuse, database_id resolution (the
# checked-in wrangler.jsonc keeps a placeholder id for local dev), remote
# migrations, deploy, and issuer pinning. The only human steps are the
# Cloudflare login (browser) and — on first ever Workers deploy for an
# account — the workers.dev subdomain registration prompt wrangler shows.
#
# The issuer works like this: a Worker cannot know its public
# https://<name>.<subdomain>.workers.dev URL before the first deploy, so on
# the first run we deploy once, read the URL wrangler reports, pin it as the
# ISSUER var, and deploy again. The URL is persisted to .deploy/issuer so
# every later run deploys exactly once. Use --issuer to pin a custom domain.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${SAMPLE_DIR}/../.." && pwd)"
# shellcheck source=scripts/lib/guide.sh
. "${ROOT_DIR}/scripts/lib/guide.sh"

D1_NAME="maronn-openid-connect-sample"
STATE_DIR="${SAMPLE_DIR}/.deploy"
ISSUER_FILE="${STATE_DIR}/issuer"
DEPLOY_CONFIG="${SAMPLE_DIR}/wrangler.deploy.jsonc"

ISSUER="${OIDC_DEPLOY_ISSUER:-}"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --issuer) ISSUER="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      cat <<EOF
Usage: deploy-cloudflare.sh [--issuer <https://...>] [--dry-run]

引数なしで実行するとガイド付きでデプロイします:
  1. pnpm / 依存関係 / @maronn-openid-connect/core のビルドを準備
  2. Cloudflare 未ログインなら 'wrangler login' を起動
  3. D1 データベース（${D1_NAME}）を作成または再利用し、database_id を自動解決
  4. wrangler.deploy.jsonc（gitignore 済み）を生成してリモートへマイグレーション適用
  5. デプロイし、workers.dev の公開URLを ISSUER として固定（初回のみ2回デプロイ）
  6. Discovery エンドポイントで issuer の一致を検証

ISSUER は ${SAMPLE_DIR#"${ROOT_DIR}"/}/.deploy/issuer に保存され、次回以降は1回のデプロイで完了します。
カスタムドメインを使う場合は --issuer で明示してください。
非対話環境（CI等）では CLOUDFLARE_API_TOKEN を設定してください。
EOF
      exit 0
      ;;
    *) guide_err "不明な引数です: $1（--help で使い方を表示）"; exit 1 ;;
  esac
done

wrangler_cmd() {
  (cd "${SAMPLE_DIR}" && pnpm exec wrangler "$@")
}

run() {
  guide_info "実行: wrangler $*"
  if [ "${DRY_RUN}" = "1" ]; then
    return 0
  fi
  wrangler_cmd "$@"
}

guide_step "Cloudflare Workers へのデプロイを開始します（サンプル: hono-cloudflare）"

# ── ツールチェーンと依存関係 ───────────────────────────────────────────
guide_require_node_version 22 13
guide_require_pnpm
guide_ensure_workspace_deps "${ROOT_DIR}"
guide_info "@maronn-openid-connect/core をビルドします。"
if [ "${DRY_RUN}" != "1" ]; then
  (cd "${ROOT_DIR}" && pnpm --filter @maronn-openid-connect/core build >/dev/null)
fi
guide_ok "ツールチェーンの準備ができました（wrangler はサンプルの devDependencies を使用）。"

# ── Cloudflare ログイン ────────────────────────────────────────────────
if [ "${DRY_RUN}" != "1" ]; then
  if ! wrangler_cmd whoami >/dev/null 2>&1; then
    guide_warn "Cloudflare に未ログインです。"
    guide_info "これから 'wrangler login' を起動します。ブラウザが開くので、Cloudflare アカウントでログインして許可してください（アカウントが無い場合は無料登録できます）。"
    if ! guide_is_tty; then
      guide_err "非対話環境ではログインできません。CLOUDFLARE_API_TOKEN（と必要なら CLOUDFLARE_ACCOUNT_ID）を設定して再実行してください。"
      exit 1
    fi
    guide_run wrangler_cmd login
  fi
  guide_ok "Cloudflare にログイン済みです。"
fi

# ── D1 データベースの作成 / database_id の解決 ─────────────────────────
guide_step "D1 データベース（${D1_NAME}）を準備します"
DATABASE_ID="00000000-0000-0000-0000-000000000000"
if [ "${DRY_RUN}" != "1" ]; then
  lookup_database_id() {
    wrangler_cmd d1 list --json 2>/dev/null \
      | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const list=JSON.parse(d.slice(d.indexOf('[')));const hit=list.find(x=>x.name==='${D1_NAME}');process.stdout.write(hit?hit.uuid:'')}catch{process.stdout.write('')}})"
  }
  DATABASE_ID="$(lookup_database_id)"
  if [ -n "${DATABASE_ID}" ]; then
    guide_ok "既存の D1 データベースを再利用します（database_id: ${DATABASE_ID}）。"
  else
    run d1 create "${D1_NAME}"
    DATABASE_ID="$(lookup_database_id)"
    if [ -z "${DATABASE_ID}" ]; then
      guide_err "D1 データベースの作成後に database_id を解決できませんでした。'pnpm --filter @maronn-openid-connect/sample-hono-cloudflare exec wrangler d1 list' で状態を確認してください。"
      exit 1
    fi
    guide_ok "D1 データベースを作成しました（database_id: ${DATABASE_ID}）。"
  fi
else
  guide_info "実行: wrangler d1 list --json（database_id を解決）"
fi

# ── デプロイ用 wrangler 設定の生成 ────────────────────────────────────
# チェックイン済みの wrangler.jsonc はローカル開発用にプレースホルダ id の
# まま残し、実 id と ISSUER var はこの生成ファイル（gitignore 済み）にだけ
# 書き込む。生成は wrangler.jsonc を機械的に変換するので、ベース設定の変更
# には自動で追随する。
generate_deploy_config() {
  local issuer_value="$1"
  node - "${SAMPLE_DIR}/wrangler.jsonc" "${DEPLOY_CONFIG}" "${DATABASE_ID}" "${issuer_value}" <<'EOF'
const fs = require('node:fs');
const [src, dest, databaseId, issuer] = process.argv.slice(2);
const jsonc = fs.readFileSync(src, 'utf8');
const config = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, ''));
delete config.$schema;
config.d1_databases[0].database_id = databaseId;
if (issuer) {
  config.vars = { ...config.vars, ISSUER: issuer };
}
fs.writeFileSync(
  dest,
  '// Generated by scripts/deploy-cloudflare.sh — do not edit or commit.\n' +
    JSON.stringify(config, null, 2) + '\n',
);
EOF
}

deploy_once() {
  # wrangler の出力を表示しつつ、workers.dev の公開URLを拾う。
  local log_file="${STATE_DIR}/last-deploy.log"
  mkdir -p "${STATE_DIR}"
  guide_info "実行: wrangler deploy --config wrangler.deploy.jsonc"
  wrangler_cmd deploy --config "${DEPLOY_CONFIG}" 2>&1 | tee "${log_file}"
  DEPLOYED_URL="$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' "${log_file}" | head -n 1 || true)"
}

if [ "${DRY_RUN}" = "1" ]; then
  generate_deploy_config "${ISSUER:-https://example.workers.dev}"
  guide_info "wrangler.deploy.jsonc を生成しました（dry-run 用のサンプル値）。"
  guide_info "実行: wrangler d1 migrations apply ${D1_NAME} --remote --config wrangler.deploy.jsonc"
  guide_info "実行: wrangler deploy --config wrangler.deploy.jsonc"
  guide_ok "--dry-run のため、実際の Cloudflare API 呼び出しは行いませんでした。"
  exit 0
fi

# ── ISSUER の解決（前回値 → 初回はデプロイ結果から確定） ───────────────
if [ -z "${ISSUER}" ] && [ -f "${ISSUER_FILE}" ]; then
  ISSUER="$(head -n 1 "${ISSUER_FILE}" | tr -d '[:space:]')"
  if [ -n "${ISSUER}" ]; then
    guide_info "前回の issuer を再利用します: ${ISSUER}（変更する場合は --issuer を指定）"
  fi
fi

guide_step "リモート D1 へマイグレーションを適用します"
generate_deploy_config "${ISSUER}"
run d1 migrations apply "${D1_NAME}" --remote --config "${DEPLOY_CONFIG}"

guide_step "デプロイします"
if [ -z "${ISSUER}" ]; then
  guide_info "初回デプロイのため、まず公開URLを確定させます（このあと ISSUER を固定してもう一度デプロイします）。"
  deploy_once
  if [ -z "${DEPLOYED_URL}" ]; then
    guide_err "デプロイ出力から workers.dev のURLを特定できませんでした。上のログのURLを確認し、--issuer <URL> を付けて再実行してください。"
    exit 1
  fi
  ISSUER="${DEPLOYED_URL}"
  guide_ok "公開URLを確認しました: ${ISSUER}"
  guide_info "ISSUER を固定して再デプロイします。"
  generate_deploy_config "${ISSUER}"
fi
deploy_once
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
guide_warn "サンプルの署名鍵は起動時生成のため、複数インスタンス間で鍵が一致しない可能性があります。本番相当の検証では Cloudflare Secrets 等から固定鍵を読み込んでください。"
guide_info "後片付けする場合: wrangler delete --config wrangler.deploy.jsonc && wrangler d1 delete ${D1_NAME}"
