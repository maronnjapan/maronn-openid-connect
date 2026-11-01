#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFORMANCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${CONFORMANCE_DIR}/../.." && pwd)"
GENERATED_DIR="${CONFORMANCE_DIR}/.generated"
RESULTS_DIR="${CONFORMANCE_DIR}/results"
COMPOSE_FILE="${CONFORMANCE_DIR}/docker-compose.yml"

# The certification plan of the run: basic (the default), implicit or hybrid
# (create-op-config.mjs).
PLAN="${1:-${CONFORMANCE_PLAN:-basic}}"
# How the suite gets its client: static (the default), the clients
# create-op-config.mjs registers on the OP, or dynamic, a client the suite
# registers itself at POST /register of the sample OP before each module
# (client_registration=dynamic_client).
CLIENT_REGISTRATION="${CONFORMANCE_CLIENT_REGISTRATION:-static}"
SAMPLE_APP="${CONFORMANCE_SAMPLE_APP:-hono-cloudflare}"
CONFORMANCE_OP_ISSUER="${CONFORMANCE_OP_ISSUER:-https://op-tls:3443}"
CONFORMANCE_SUITE_BASE_URL="${CONFORMANCE_SUITE_BASE_URL:-https://conformance-nginx:8443}"
CONFORMANCE_OP_ISSUER="${CONFORMANCE_OP_ISSUER%/}"
CONFORMANCE_SUITE_BASE_URL="${CONFORMANCE_SUITE_BASE_URL%/}"

case "${PLAN}" in
  basic)
    # The Basic OP plan has modules of the authorization code flow without
    # PKCE (README).
    DEFAULT_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW=1
    ;;
  implicit)
    # The Implicit OP plan issues no authorization code.
    DEFAULT_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW=0
    ;;
  hybrid)
    # The Hybrid OP plan exchanges the code of every module without PKCE,
    # as the Basic OP plan does (README).
    DEFAULT_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW=1
    ;;
  *)
    echo "Unsupported CONFORMANCE_PLAN \"${PLAN}\". Expected one of: basic, implicit, hybrid" >&2
    exit 1
    ;;
esac

case "${CLIENT_REGISTRATION}" in
  static|dynamic)
    ;;
  *)
    echo "Unsupported CONFORMANCE_CLIENT_REGISTRATION \"${CLIENT_REGISTRATION}\". Expected one of: static, dynamic" >&2
    exit 1
    ;;
esac

case "${SAMPLE_APP}" in
  hono-cloudflare)
    SAMPLE_PACKAGE="@maronn-openid-connect/sample-hono-cloudflare"
    DEFAULT_START_COMMAND="corepack enable && pnpm --dir samples/hono-cloudflare start"
    ;;
  express-flyio)
    SAMPLE_PACKAGE="@maronn-openid-connect/sample-express-flyio"
    DEFAULT_START_COMMAND="node samples/express-flyio/dist/server.js"
    ;;
  fastify-flyio)
    SAMPLE_PACKAGE="@maronn-openid-connect/sample-fastify-flyio"
    DEFAULT_START_COMMAND="node samples/fastify-flyio/dist/server.js"
    ;;
  nextjs-vercel)
    SAMPLE_PACKAGE="@maronn-openid-connect/sample-nextjs-vercel"
    DEFAULT_START_COMMAND="corepack enable && pnpm --dir samples/nextjs-vercel start"
    ;;
  *)
    echo "Unsupported CONFORMANCE_SAMPLE_APP \"${SAMPLE_APP}\". Expected one of: hono-cloudflare, express-flyio, fastify-flyio, nextjs-vercel" >&2
    exit 1
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run the OpenID Foundation conformance suite" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker daemon is not available; start Docker before running the OpenID Foundation conformance suite" >&2
  exit 1
fi

mkdir -p "${GENERATED_DIR}/nginx" "${RESULTS_DIR}"

cd "${ROOT_DIR}"

pnpm --filter @maronn-openid-connect/cli build
pnpm --filter "${SAMPLE_PACKAGE}" build

CONFORMANCE_PLAN="${PLAN}" \
CONFORMANCE_CLIENT_REGISTRATION="${CLIENT_REGISTRATION}" \
CONFORMANCE_ALIAS="${CONFORMANCE_ALIAS:-maronn-${PLAN}-op}" \
CONFORMANCE_OP_ISSUER="${CONFORMANCE_OP_ISSUER}" \
CONFORMANCE_SUITE_BASE_URL="${CONFORMANCE_SUITE_BASE_URL}" \
CONFORMANCE_SAMPLE_APP="${SAMPLE_APP}" \
CONFORMANCE_OUT_DIR="${GENERATED_DIR}" \
pnpm --filter @maronn-openid-connect/conformance generate

"${SCRIPT_DIR}/ensure-op-tls-cert.sh"
# The mount point of the tmpfs the op service writes wrangler's bundles to: it
# has to exist, because the workspace is mounted read-only.
mkdir -p "${ROOT_DIR}/samples/${SAMPLE_APP}/.wrangler"
cp "${CONFORMANCE_DIR}/nginx/op-tls.conf" "${GENERATED_DIR}/nginx/op-tls.conf"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-maronn_oidf_conformance}"
export CONFORMANCE_SAMPLE_APP="${SAMPLE_APP}"
export CONFORMANCE_CLIENT_REGISTRATION="${CLIENT_REGISTRATION}"
export CONFORMANCE_SAMPLE_START_COMMAND="${CONFORMANCE_SAMPLE_START_COMMAND:-${DEFAULT_START_COMMAND}}"
export CONFORMANCE_OP_ISSUER
export CONFORMANCE_SUITE_BASE_URL
export CONFORMANCE_SERVER="${CONFORMANCE_SUITE_BASE_URL}/"
export CONFORMANCE_SERVER_MTLS="${CONFORMANCE_SERVER_MTLS:-${CONFORMANCE_SERVER}}"
export CONFORMANCE_CONFIG_PATH="/workspace/tests/conformance/.generated/${PLAN}-op-config.json"
export CONFORMANCE_RESULTS_DIR="/workspace/tests/conformance/results"
# The plan, without the manual review modules when
# CONFORMANCE_SKIP_MANUAL_REVIEW=1 (create-op-config.mjs writes it).
export CONFORMANCE_TEST_PLAN="${CONFORMANCE_TEST_PLAN:-$(cat "${GENERATED_DIR}/test-plan.txt")}"
export OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW="${OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW:-${DEFAULT_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW}}"
# OIDC Core 1.0 §6.1 / RFC 9101: both plans skip the Request Object modules
# (oidcc-unsigned-request-object-... / oidcc-ensure-request-object-with-redirect-uri)
# unless the OP advertises 'none' in request_object_signing_alg_values_supported, i.e.
# accepts unsigned Request Objects. Enable that compatibility for the conformance OP so
# both modules run (and pass) instead of being skipped.
export OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT="${OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT:-1}"
export OIDC_CLIENTS_JSON
OIDC_CLIENTS_JSON="$(tr -d '\n' < "${GENERATED_DIR}/oidc-clients.json")"

set +e
docker compose -f "${COMPOSE_FILE}" up --build --abort-on-container-exit --exit-code-from runner runner
status=$?
set -e

docker compose -f "${COMPOSE_FILE}" logs --no-color > "${RESULTS_DIR}/docker-compose.log" 2>/dev/null || true

if [[ "${CONFORMANCE_KEEP_SERVICES:-0}" != "1" ]]; then
  docker compose -f "${COMPOSE_FILE}" down -v --remove-orphans >/dev/null 2>&1 || true
fi

exit "${status}"
