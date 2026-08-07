#!/usr/bin/env node
// Generate an RS256 signing key for the sample OpenID Providers and print the
// private key as a JWK JSON object on stdout.
//
// The samples fall back to generating a key pair per process when no key is
// configured, which means every isolate / machine / serverless instance
// publishes different key material under the same `kid`. A relying party that
// fetched `jwks_uri` from one instance then fails to verify an ID Token signed
// by another (RFC 7515 §4.1.4 selects the verification key by `kid`; OIDC Core
// 1.0 §10.1 assumes that mapping is stable across the OP). Storing the output
// of this script as a secret and exposing it as OIDC_SIGNING_KEY_JWK makes the
// key stable across instances, restarts, and redeploys.
//
// Usage:
//   node scripts/generate-signing-key.mjs [--kid <key id>] [--bits <modulus bits>]
//
//   wrangler secret put OIDC_SIGNING_KEY_JWK   # paste the output
//   fly secrets set OIDC_SIGNING_KEY_JWK="$(node scripts/generate-signing-key.mjs)"
//   vercel env add OIDC_SIGNING_KEY_JWK        # paste the output
//
// The output contains PRIVATE key material. Never commit it.

import { webcrypto } from 'node:crypto';

const DEFAULT_KEY_ID = 'oidc-rs256-key';
// NIST SP 800-131A Rev.2: RSA below 2048 bits is disallowed. packages/core
// rejects weaker keys at startup via assertKeyStrength.
const DEFAULT_MODULUS_BITS = 2048;

function parseArgs(argv) {
  const options = { keyId: DEFAULT_KEY_ID, modulusBits: DEFAULT_MODULUS_BITS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--kid') {
      const value = argv[++i];
      if (!value) throw new Error('--kid requires a value');
      options.keyId = value;
      continue;
    }
    if (arg === '--bits') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 2048) {
        throw new Error('--bits requires an integer >= 2048 (NIST SP 800-131A Rev.2)');
      }
      options.modulusBits = value;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

const HELP = `Usage: node scripts/generate-signing-key.mjs [--kid <key id>] [--bits <modulus bits>]

RS256 の署名鍵を生成し、秘密鍵を JWK JSON として標準出力に書き出します。
出力はそのまま各サンプル OP の OIDC_SIGNING_KEY_JWK に設定してください。

  --kid   JWK の kid（既定: ${DEFAULT_KEY_ID}）
  --bits  RSA modulus のビット長（既定: ${DEFAULT_MODULUS_BITS}、2048 未満は不可）

例:
  node scripts/generate-signing-key.mjs --kid hono-cloudflare-rs256-key
  fly secrets set OIDC_SIGNING_KEY_JWK="$(node scripts/generate-signing-key.mjs)"

出力には秘密鍵が含まれます。リポジトリにコミットしないでください。
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const keyPair = await webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: options.modulusBits,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );

  const jwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey);
  // key_ops / ext come from the WebCrypto export and would over-constrain the
  // importKey call on the consuming side; alg / use / kid are what RFC 7517 §4
  // and OIDC Core 1.0 §10.1 expect the OP to publish.
  delete jwk.key_ops;
  delete jwk.ext;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  jwk.kid = options.keyId;

  process.stdout.write(`${JSON.stringify(jwk)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
