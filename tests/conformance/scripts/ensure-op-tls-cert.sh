#!/usr/bin/env bash
# The TLS certificates of the conformance run, all issued by one throwaway CA
# (.generated/certs/ca.crt) made here:
#
# - op-tls.crt: the HTTPS proxy in front of the sample OP (op-tls:3443).
# - conformance-nginx.crt: the HTTPS proxy of the suite (conformance-nginx:8443).
#   docker-compose.yml mounts it over the self-signed certificate of the suite's
#   nginx image, whose subject (CN=localhost) does not name conformance-nginx.
#
# The op service trusts the CA (NODE_EXTRA_CA_CERTS), so the OP fetches what the
# suite serves for its dynamically registered clients over verified TLS: the
# jwks_uri, request_uri and sector_identifier_uri of the Dynamic OP plan. Node.js
# reads NODE_EXTRA_CA_CERTS itself, and wrangler dev (hono-cloudflare) hands the
# certificates to workerd (trustedCertificates of Miniflare). TLS verification
# is never turned off.
#
# The CA and both keys are local to this run and are not secrets of anything
# else. Files that exist are kept, so a rerun keeps the same CA (a new CA
# reissues the certificates).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFORMANCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CERT_DIR="${CONFORMANCE_DIR}/.generated/certs"
CA_CERT="${CERT_DIR}/ca.crt"
CA_KEY="${CERT_DIR}/ca.key"

mkdir -p "${CERT_DIR}"

if [[ ! -f "${CA_CERT}" || ! -f "${CA_KEY}" ]]; then
  # A new CA reissues every certificate: the ones already here do not chain to it.
  rm -f "${CERT_DIR}"/*.crt "${CERT_DIR}"/*.key "${CERT_DIR}"/*.csr "${CERT_DIR}"/*.srl
  openssl req \
    -x509 \
    -newkey rsa:2048 \
    -sha256 \
    -nodes \
    -days 30 \
    -keyout "${CA_KEY}" \
    -out "${CA_CERT}" \
    -subj "/CN=maronn conformance run CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
fi

# Issues <name>.crt and <name>.key for the DNS names and IP of subject_alt_name, signed by the CA.
issue_certificate() {
  local name="$1"
  local subject_alt_name="$2"
  local cert_path="${CERT_DIR}/${name}.crt"
  local key_path="${CERT_DIR}/${name}.key"
  local csr_path="${CERT_DIR}/${name}.csr"
  local ext_path="${CERT_DIR}/${name}.ext"

  if [[ -f "${cert_path}" && -f "${key_path}" ]]; then
    return 0
  fi
  openssl req -newkey rsa:2048 -sha256 -nodes -keyout "${key_path}" -out "${csr_path}" -subj "/CN=${name}"
  printf 'subjectAltName=%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' \
    "${subject_alt_name}" > "${ext_path}"
  openssl x509 -req -in "${csr_path}" -CA "${CA_CERT}" -CAkey "${CA_KEY}" -CAcreateserial \
    -days 30 -sha256 -extfile "${ext_path}" -out "${cert_path}"
  rm -f "${csr_path}" "${ext_path}"
  # nginx of the suite image runs its workers as another user than the one who made the file.
  chmod 644 "${key_path}"
}

issue_certificate op-tls "DNS:op-tls,DNS:localhost,IP:127.0.0.1"
issue_certificate conformance-nginx "DNS:conformance-nginx,DNS:nginx,DNS:localhost,IP:127.0.0.1"
