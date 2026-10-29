#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFORMANCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CERT_DIR="${CONFORMANCE_DIR}/.generated/certs"

mkdir -p "${CERT_DIR}"

# A self-signed certificate for one host of the compose network, valid for 30
# days, left alone once it exists.
ensure_cert() {
  local name="$1"
  local subject_alt_names="$2"
  local cert_path="${CERT_DIR}/${name}.crt"
  local key_path="${CERT_DIR}/${name}.key"

  if [[ -f "${cert_path}" && -f "${key_path}" ]]; then
    return 0
  fi

  openssl req \
    -x509 \
    -newkey rsa:2048 \
    -sha256 \
    -nodes \
    -days 30 \
    -keyout "${key_path}" \
    -out "${cert_path}" \
    -subj "/CN=${name}" \
    -addext "subjectAltName=${subject_alt_names}"
}

# The TLS proxy in front of the sample OP (op-tls service).
ensure_cert op-tls "DNS:op-tls,DNS:localhost,IP:127.0.0.1"

# The certificate the conformance suite's nginx (conformance-nginx service)
# serves instead of the one baked into its image (CN=localhost, no subject
# alternative name). With dynamic client registration the OP fetches the
# request_uri modules' Request Objects from the suite over HTTPS (OIDC Core 1.0
# §6.2.3), so the OP container trusts this certificate through
# NODE_EXTRA_CA_CERTS (docker-compose.yml), which Node.js and wrangler dev
# (miniflare) both honour, and the host name of the suite must be among its
# subject alternative names.
ensure_cert conformance-nginx "DNS:conformance-nginx,DNS:nginx,DNS:localhost,IP:127.0.0.1"
