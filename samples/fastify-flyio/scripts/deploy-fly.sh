#!/usr/bin/env bash
# Thin wrapper around scripts/lib/deploy-fly-node-sample.sh for this sample.
# See samples/fastify-flyio/README.md for prerequisites and what this automates.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

export SAMPLE_DIR="samples/fastify-flyio"
export SAMPLE_PACKAGE="@maronn-openid-connect/sample-fastify-flyio"

cd "${ROOT_DIR}"
exec "${ROOT_DIR}/scripts/lib/deploy-fly-node-sample.sh" "$@"
