#!/usr/bin/env bash
# One-command local launcher for the samples/* OpenID Providers.
#
#   pnpm sample:hono-cloudflare
#   pnpm sample:express-flyio
#   pnpm sample:fastify-flyio
#   pnpm sample:nextjs-vercel
#
# From a fresh clone this handles everything up to a listening OP: toolchain
# checks (with guidance when something is missing), workspace install, core
# build, sample build, and start. No arguments are required.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/guide.sh
. "${SCRIPT_DIR}/lib/guide.sh"

SAMPLE="${1:-}"
if [ -z "${SAMPLE}" ] || [ ! -f "${ROOT_DIR}/samples/${SAMPLE}/package.json" ]; then
  {
    echo "Usage: sample-up.sh <sample-name>"
    echo "利用できるサンプル:"
    for dir in "${ROOT_DIR}"/samples/*/; do
      [ -f "${dir}package.json" ] && echo "  - $(basename "${dir}")"
    done
  } >&2
  exit 1
fi

SAMPLE_DIR="${ROOT_DIR}/samples/${SAMPLE}"
SAMPLE_PACKAGE="$(node -p "require('${SAMPLE_DIR}/package.json').name" 2>/dev/null || true)"
if [ -z "${SAMPLE_PACKAGE}" ]; then
  # node がまだ無い場合でも package 名は決め打ちできる（@maronn-openid-connect/sample-<dir>）。
  SAMPLE_PACKAGE="@maronn-openid-connect/sample-${SAMPLE}"
fi

guide_step "ツールチェーンを確認します"
guide_require_node_version 22 13
guide_require_pnpm
guide_ok "node / pnpm を確認しました。"

guide_ensure_workspace_deps "${ROOT_DIR}"

guide_step "${SAMPLE} をビルドして起動します"
guide_info "停止する場合は Ctrl+C を押してください。"
cd "${ROOT_DIR}"
exec pnpm --filter "${SAMPLE_PACKAGE}" run launch
