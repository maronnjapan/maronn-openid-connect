#!/usr/bin/env bash
set -euo pipefail

SUITE_DIR="${CONFORMANCE_SUITE_DIR:-/tmp/openid-conformance-suite}"
SUITE_REF="${CONFORMANCE_SUITE_REF:-master}"
CONFIG_PATH="${CONFORMANCE_CONFIG_PATH:-/workspace/tests/conformance/.generated/basic-op-config.json}"
RESULTS_DIR="${CONFORMANCE_RESULTS_DIR:-/workspace/tests/conformance/results}"
TEST_PLAN="${CONFORMANCE_TEST_PLAN:-oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]}"
CONFORMANCE_SERVER="${CONFORMANCE_SERVER:-https://conformance-nginx:8443/}"

export CONFORMANCE_SERVER
export CONFORMANCE_SERVER_MTLS="${CONFORMANCE_SERVER_MTLS:-${CONFORMANCE_SERVER}}"
export CONFORMANCE_DEV_MODE="${CONFORMANCE_DEV_MODE:-1}"
export DISABLE_SSL_VERIFY="${DISABLE_SSL_VERIFY:-1}"

wait_for_url() {
  local name="$1"
  local url="$2"
  local attempts="${3:-120}"

  for attempt in $(seq 1 "${attempts}"); do
    if curl -kfsS --max-time 10 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    echo "Waiting for ${name} (${attempt}/${attempts}): ${url}"
    sleep 2
  done

  echo "Timed out waiting for ${name}: ${url}" >&2
  return 1
}

if [[ ! -d "${SUITE_DIR}/.git" ]]; then
  git clone --depth 1 --branch "${SUITE_REF}" https://gitlab.com/openid/conformance-suite.git "${SUITE_DIR}"
fi

mkdir -p "${RESULTS_DIR}"

wait_for_url "conformance suite" "${CONFORMANCE_SERVER}api/runner/available" 150
# The OP is healthy before op-tls starts (docker-compose.yml), so this only
# waits for the TLS proxy.
wait_for_url "sample OP discovery" "https://op-tls:3443/.well-known/openid-configuration" 30

cd "${SUITE_DIR}"

python scripts/run-test-plan.py \
  --export-dir "${RESULTS_DIR}" \
  --no-parallel \
  "${TEST_PLAN}" \
  "${CONFIG_PATH}"
