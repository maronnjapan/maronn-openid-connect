import type { webcrypto } from 'node:crypto';
import { getJwaAlgorithm, rsaModulusBitLength } from './crypto-utils.js';

export interface SigningKey {
  privateKey: CryptoKey;
  publicJwk: webcrypto.JsonWebKey;
  keyId: string;
}

/**
 * Provider that loads signing keys from a secret store.
 *
 * `getSigningKey()` returns the key the OP should currently use to sign new
 * tokens (the "active" key). `getSigningKeys()` is optional and returns every
 * key the OP wants to advertise as verifiable — typically the active key plus
 * any rotated-out keys whose tokens are still in flight, plus alternate-alg
 * keys (e.g. RS256 + ES256) when clients pick `id_token_signed_response_alg`.
 *
 * The array order is "oldest → newest" so callers can treat the last entry as
 * the most recent. Implementations that do not support multiple keys may omit
 * `getSigningKeys`; helpers in this module fall back to `[await getSigningKey()]`.
 */
export interface SigningKeyProvider {
  getSigningKey(): Promise<SigningKey>;
  getSigningKeys?(): Promise<SigningKey[]>;
}

/**
 * Resolve the registered key set for a provider.
 *
 * If the provider implements `getSigningKeys()`, return that array verbatim.
 * Otherwise, fall back to `[await getSigningKey()]` so older provider
 * implementations keep working without modification.
 */
export async function getRegisteredSigningKeys(
  provider: SigningKeyProvider,
): Promise<SigningKey[]> {
  if (provider.getSigningKeys) {
    return provider.getSigningKeys();
  }
  return [await provider.getSigningKey()];
}

/**
 * Pick the signing key matching `requestedAlg` from a registered key set.
 *
 * - `requestedAlg` is the client's `id_token_signed_response_alg` (or other
 *   `*_signed_response_alg` metadata value). When undefined the OIDC default
 *   `RS256` is used (OIDC Dynamic Client Registration 1.0 §2).
 * - When multiple keys share the same alg (e.g. during rotation), the *last*
 *   one in the array wins because the array is ordered oldest → newest.
 * - When no key matches, throws — the caller should map this to a server
 *   configuration error, since advertising an alg we cannot sign with would
 *   produce ID Tokens the client cannot verify.
 */
export function selectSigningKeyByAlg(
  keys: readonly SigningKey[],
  requestedAlg: string | undefined,
): SigningKey {
  if (keys.length === 0) {
    throw new Error('No signing keys available');
  }
  const alg = requestedAlg ?? 'RS256';
  // Iterate from newest (end of array) so a rotated key supersedes its predecessor.
  for (let i = keys.length - 1; i >= 0; i--) {
    const key = keys[i]!;
    try {
      if (getJwaAlgorithm(key.privateKey) === alg) {
        return key;
      }
    } catch {
      // Skip keys whose alg cannot be derived (e.g. stub keys without algorithm metadata).
    }
  }
  throw new Error(`No signing key registered for alg "${alg}"`);
}

/**
 * Validate that the supplied key set includes at least one RS256-capable key.
 *
 * OIDC Core 1.0 §15.1 mandates RS256 support ("MUST be supported"). This is a
 * key-set-level requirement: the OP must be able to sign with RS256, but it
 * may also register additional keys (e.g. ES256) for clients that prefer them.
 *
 * @throws when no RS256 (RSASSA-PKCS1-v1_5 with SHA-256) key is found.
 */
export function assertHasRs256Key(keys: CryptoKey[]): void {
  for (const key of keys) {
    try {
      if (getJwaAlgorithm(key) === 'RS256') {
        return;
      }
    } catch {
      // Unsupported algorithm — not a candidate; keep scanning.
    }
  }
  throw new Error(
    'OIDC Core 1.0 §15.1 violation: at least one RS256 (RSASSA-PKCS1-v1_5 with SHA-256) key is required',
  );
}

/**
 * Assert that the kid strategy is consistent when the OP publishes more than one
 * signing key. RFC 7517 §4.5: `kid` selects the right key among several in a JWK Set,
 * and OIDC Core 1.0 §10.1 expects kid-based selection when keys are rotated/multiple.
 * If two or more keys are published, every key MUST carry a non-empty, Set-distinct
 * `keyId`; otherwise a relying party cannot unambiguously pick the verifying key and
 * ID Token verification can break silently.
 *
 * A single key is always unambiguous, so an empty kid is allowed there (backward compat).
 *
 * @throws when multiple keys include an empty or duplicate keyId.
 */
export function assertKidStrategyConsistent(keys: readonly SigningKey[]): void {
  if (keys.length <= 1) return; // single key resolves unambiguously without a kid
  const seen = new Set<string>();
  for (const key of keys) {
    if (!key.keyId) {
      throw new Error(
        'Multiple signing keys are published but a key has an empty kid (RFC 7517 §4.5)',
      );
    }
    if (seen.has(key.keyId)) {
      throw new Error(`Duplicate kid in signing key set: ${key.keyId} (RFC 7517 §4.5)`);
    }
    seen.add(key.keyId);
  }
}

/**
 * Minimum cryptographic strength a signing key must meet to be accepted.
 *
 * Defaults follow NIST SP 800-131A Rev.2 (RSA >= 2048-bit, 112-bit security)
 * and the NIST-approved curves for ECDSA. FAPI profiles may tighten these by
 * passing a stricter policy.
 */
export interface KeyStrengthPolicy {
  /** Minimum RSA modulus bit length. Default: 2048 (NIST SP 800-131A Rev.2). */
  minRsaModulusBits?: number;
  /** Allowed EC curves. Default: P-256 / P-384 / P-521. */
  allowedCurves?: readonly string[];
}

// NIST SP 800-131A Rev.2: RSA 1024-bit is disallowed; 2048-bit (112-bit
// security strength) is the minimum for use beyond 2030.
const DEFAULT_MIN_RSA_MODULUS_BITS = 2048;
// NIST-approved curves for ECDSA signing (P-256 ~ 128-bit security and above).
const DEFAULT_ALLOWED_CURVES: readonly string[] = ['P-256', 'P-384', 'P-521'];

/**
 * Assert that every registered signing key meets the minimum strength policy,
 * throwing (fail-closed) on the first weak key.
 *
 * RFC 8725 §3.5 (Ensure Cryptographic Keys Have Sufficient Entropy) and
 * §3.3 (Validate All Cryptographic Operations): a signature is only as
 * trustworthy as the key behind it. Web Crypto's `importKey` happily accepts
 * 512/1024-bit RSA keys, so a misconfigured OP could distribute ID Tokens that
 * verify yet are forgeable. This check is meant to run at startup, alongside
 * `assertHasRs256Key`, to reject weak keys before they ever sign a token.
 *
 * - RSA: the modulus bit length (derived from the public JWK `n`) must be
 *   >= `minRsaModulusBits` (default 2048).
 * - EC: the curve must be one of `allowedCurves` (default P-256/P-384/P-521).
 * - Any other key type is rejected as unsupported.
 *
 * Error messages name the offending `keyId` so operators can locate the key.
 * These messages are for logs/startup only and must never be surfaced in an
 * `error_description` returned to clients.
 *
 * @throws when any key is below the configured strength.
 */
export function assertKeyStrength(
  keys: readonly SigningKey[],
  policy?: KeyStrengthPolicy,
): void {
  const minRsaModulusBits = policy?.minRsaModulusBits ?? DEFAULT_MIN_RSA_MODULUS_BITS;
  const allowedCurves = policy?.allowedCurves ?? DEFAULT_ALLOWED_CURVES;

  for (const key of keys) {
    const jwk = key.publicJwk;

    if (jwk.kty === 'RSA') {
      if (!jwk.n) {
        throw new Error(
          `Signing key "${key.keyId}" is an RSA key but its public JWK has no modulus (n)`,
        );
      }
      const bits = rsaModulusBitLength(jwk.n);
      if (bits < minRsaModulusBits) {
        throw new Error(
          `Signing key "${key.keyId}" has a ${bits}-bit RSA modulus; minimum allowed is ${minRsaModulusBits} bits (NIST SP 800-131A Rev.2)`,
        );
      }
      continue;
    }

    if (jwk.kty === 'EC') {
      if (!jwk.crv || !allowedCurves.includes(jwk.crv)) {
        throw new Error(
          `Signing key "${key.keyId}" uses unsupported EC curve "${jwk.crv ?? '(missing)'}"; allowed curves: ${allowedCurves.join(', ')}`,
        );
      }
      continue;
    }

    throw new Error(
      `Signing key "${key.keyId}" uses unsupported key type "${jwk.kty ?? '(missing)'}"`,
    );
  }
}

/**
 * Wraps a SigningKeyProvider with a TTL-based cache.
 * Use this to avoid hammering a secret store on every request while still
 * picking up rotated keys after `ttlMs` milliseconds.
 *
 * Both `getSigningKey()` and `getSigningKeys()` are cached independently. The
 * cached provider always exposes `getSigningKeys`, even when the base does
 * not — in that case it falls back to `[await getSigningKey()]`.
 */
export function createCachedSigningKeyProvider(
  base: SigningKeyProvider,
  ttlMs: number,
): SigningKeyProvider {
  let singleCache: { key: SigningKey; expiresAt: number } | null = null;
  let multiCache: { keys: SigningKey[]; expiresAt: number } | null = null;

  return {
    async getSigningKey(): Promise<SigningKey> {
      if (!singleCache || Date.now() > singleCache.expiresAt) {
        const key = await base.getSigningKey();
        singleCache = { key, expiresAt: Date.now() + ttlMs };
      }
      return singleCache.key;
    },
    async getSigningKeys(): Promise<SigningKey[]> {
      if (!multiCache || Date.now() > multiCache.expiresAt) {
        const keys = base.getSigningKeys
          ? await base.getSigningKeys()
          : [await base.getSigningKey()];
        multiCache = { keys, expiresAt: Date.now() + ttlMs };
      }
      return multiCache.keys;
    },
  };
}
