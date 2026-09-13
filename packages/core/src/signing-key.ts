import type { webcrypto } from 'node:crypto';
import {
  extractAlgorithmParamsFromJwk,
  getJwaAlgorithm,
  rsaModulusBitLength,
} from './crypto-utils.js';

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
    assertJwkStrength(key.publicJwk, key.keyId, minRsaModulusBits, allowedCurves);
  }
}

/**
 * Strength check for a single JWK, shared by {@link assertKeyStrength} and
 * {@link createJwkSigningKeyProvider}. Kept private so the public API keeps
 * exposing the key-set-level check only.
 */
function assertJwkStrength(
  jwk: webcrypto.JsonWebKey,
  keyId: string,
  minRsaModulusBits: number,
  allowedCurves: readonly string[],
): void {
  if (jwk.kty === 'RSA') {
    if (!jwk.n) {
      throw new Error(
        `Signing key "${keyId}" is an RSA key but its public JWK has no modulus (n)`,
      );
    }
    const bits = rsaModulusBitLength(jwk.n);
    if (bits < minRsaModulusBits) {
      throw new Error(
        `Signing key "${keyId}" has a ${bits}-bit RSA modulus; minimum allowed is ${minRsaModulusBits} bits (NIST SP 800-131A Rev.2)`,
      );
    }
    return;
  }

  if (jwk.kty === 'EC') {
    if (!jwk.crv || !allowedCurves.includes(jwk.crv)) {
      throw new Error(
        `Signing key "${keyId}" uses unsupported EC curve "${jwk.crv ?? '(missing)'}"; allowed curves: ${allowedCurves.join(', ')}`,
      );
    }
    return;
  }

  throw new Error(
    `Signing key "${keyId}" uses unsupported key type "${jwk.kty ?? '(missing)'}"`,
  );
}

/**
 * A JWK as this module handles it. `kid` (RFC 7517 §4.5) is part of every JWK we
 * publish, but Node's `webcrypto.JsonWebKey` does not declare it.
 */
type SigningJwk = webcrypto.JsonWebKey & { kid?: string };

/** JWK members that carry private key material and must never be published. */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;
/** JWK members that constrain WebCrypto import and are re-derived on our side. */
const IMPORT_ONLY_JWK_MEMBERS = ['key_ops', 'ext'] as const;

/**
 * Build a `SigningKeyProvider` from a *persisted* private JWK.
 *
 * Generating a key pair at startup gives every process, isolate, or machine its
 * own key material. When the `kid` is a fixed string, the OP then publishes a
 * different key under the same name from every instance, and a relying party
 * that fetched `jwks_uri` from one instance cannot verify an ID Token signed by
 * another — RFC 7515 §4.1.4 has it select the verification key by `kid`, and
 * RFC 7517 §4.5 has distinct keys use distinct `kid`s. OIDC Core 1.0 §10.1
 * assumes the `kid` → key material mapping is stable across the whole OP, and
 * lets relying parties cache the JWK Set. Loading the key from a secret store
 * restores that assumption: every instance signs with the same key, and tokens
 * stay verifiable across restarts and redeploys.
 *
 * Validation runs synchronously so a misconfigured key fails at startup rather
 * than on the first token request. Only the WebCrypto `importKey` call is
 * deferred, and its result is memoized.
 *
 * @param jwk Private JWK, either as a JSON string (e.g. read from an
 *   environment variable) or as an already-parsed object.
 * @param keyId Overrides / pins the `kid`. When the JWK also carries a `kid`,
 *   the two must agree — a silent mismatch would publish the key under a name
 *   it was not signed with.
 * @param strengthPolicy Passed to the same strength rules as
 *   {@link assertKeyStrength}; defaults to RSA >= 2048 bits and P-256/384/521.
 * @throws when the JSON is malformed, the key type is unsupported, the `kid` is
 *   missing or conflicting, the private key material is absent, or the key is
 *   below the strength policy.
 */
export function createJwkSigningKeyProvider(
  jwk: string | webcrypto.JsonWebKey,
  keyId?: string,
  strengthPolicy?: KeyStrengthPolicy,
): SigningKeyProvider {
  const parsed = parsePrivateJwk(jwk);
  const resolvedKid = resolveKeyId(parsed, keyId);

  const publicJwk = toPublicJwk(parsed, resolvedKid);
  assertJwkStrength(
    publicJwk,
    resolvedKid,
    strengthPolicy?.minRsaModulusBits ?? DEFAULT_MIN_RSA_MODULUS_BITS,
    strengthPolicy?.allowedCurves ?? DEFAULT_ALLOWED_CURVES,
  );

  // RSA and EC private JWKs both carry the private exponent in `d` (RFC 7518
  // §6.3.2.1 / §6.2.2.1). Without it the key can only verify, not sign.
  if (!parsed.d) {
    throw new Error(
      `Signing key JWK "${resolvedKid}" has no private key material (d)`,
    );
  }

  const importParams = extractAlgorithmParamsFromJwk(publicJwk);
  const privateJwk: SigningJwk = { ...parsed, alg: publicJwk.alg, kid: resolvedKid };
  for (const member of IMPORT_ONLY_JWK_MEMBERS) {
    delete (privateJwk as Record<string, unknown>)[member];
  }

  // The key is imported once and reused; `extractable: false` keeps the private
  // material from being read back out of the CryptoKey.
  const keyPromise = crypto.subtle
    .importKey('jwk', privateJwk, importParams, false, ['sign'])
    .then((privateKey): SigningKey => ({ privateKey, publicJwk, keyId: resolvedKid }));
  // Mark the rejection as handled so an import failure surfaces on await instead
  // of as an unhandled rejection at module evaluation time.
  keyPromise.catch(() => undefined);

  return {
    async getSigningKey(): Promise<SigningKey> {
      return keyPromise;
    },
    async getSigningKeys(): Promise<SigningKey[]> {
      return [await keyPromise];
    },
  };
}

/**
 * Options for {@link resolveSigningKeyProvider}.
 */
export interface ResolveSigningKeyProviderOptions {
  /**
   * Persisted private JWK, typically read from a secret (e.g. an environment
   * variable). An empty or absent value selects the ephemeral fallback.
   */
  jwk?: string | webcrypto.JsonWebKey;
  /** Configured `kid`. Pins the persisted key's kid and names the fallback key. */
  keyId?: string;
  /** `kid` used for the ephemeral fallback when `keyId` is not configured. */
  fallbackKeyId: string;
  /**
   * Appended to the fallback warning to tell the operator how to configure a
   * persisted key (the env var name differs per deployment). Kept out of core's
   * own wording so core stays agnostic of the host application's config names.
   */
  persistenceHint?: string;
  /** Receives the fallback warning. Defaults to `console.warn`. */
  onEphemeralFallback?: (message: string) => void;
  /** Strength policy applied to the persisted key; see {@link assertKeyStrength}. */
  strengthPolicy?: KeyStrengthPolicy;
}

const EPHEMERAL_FALLBACK_WARNING_SUFFIX =
  'The key material differs between instances and changes on every restart, so tokens signed here fail verification against another instance’s JWKS.';

/**
 * Pick the signing key provider for a deployment: the persisted JWK when one is
 * configured, otherwise a per-process ephemeral RS256 key plus a warning.
 *
 * The ephemeral branch exists so a sample or local run works with zero
 * configuration, but it is only safe for a single process. Once more than one
 * instance serves the OP — Cloudflare Workers isolates, several Fly machines,
 * serverless instances — each one generates its own key under the same `kid`,
 * and RFC 7515 §4.1.4 `kid`-based key selection then hands a relying party the
 * wrong key. See {@link createJwkSigningKeyProvider} for the persisted path.
 *
 * @throws when a persisted JWK is configured but invalid — a misconfigured
 *   secret must fail at startup rather than at the first token request.
 */
export function resolveSigningKeyProvider(
  options: ResolveSigningKeyProviderOptions,
): SigningKeyProvider {
  const { jwk, keyId, fallbackKeyId, persistenceHint, strengthPolicy } = options;
  const hasPersistedJwk = typeof jwk === 'string' ? jwk.trim().length > 0 : jwk !== undefined;

  if (hasPersistedJwk) {
    return createJwkSigningKeyProvider(jwk!, keyId, strengthPolicy);
  }

  const ephemeralKeyId = keyId ?? fallbackKeyId;
  const warn = options.onEphemeralFallback ?? ((message: string) => console.warn(message));
  warn(
    `No persisted signing key is configured, so an ephemeral RS256 key was generated for this process (kid "${ephemeralKeyId}"). ${EPHEMERAL_FALLBACK_WARNING_SUFFIX}${
      persistenceHint ? ` ${persistenceHint}` : ''
    }`,
  );
  return createEphemeralRs256KeyProvider(ephemeralKeyId);
}

/**
 * Generate an RS256 key pair for this process and expose it as a provider.
 *
 * Development-only: the key exists for the lifetime of one process/isolate and
 * is never shared with another instance, so it must not be used anywhere a
 * relying party can reach a second instance's `jwks_uri`. Kept private to this
 * module so the ephemeral path is only reachable through the warning in
 * {@link resolveSigningKeyProvider}.
 */
function createEphemeralRs256KeyProvider(keyId: string): SigningKeyProvider {
  const keyPromise = (async (): Promise<SigningKey> => {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: DEFAULT_MIN_RSA_MODULUS_BITS,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = (await crypto.subtle.exportKey(
      'jwk',
      keyPair.publicKey,
    )) as SigningJwk;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    publicJwk.kid = keyId;
    return { privateKey: keyPair.privateKey, publicJwk, keyId };
  })();
  keyPromise.catch(() => undefined);

  return {
    async getSigningKey(): Promise<SigningKey> {
      return keyPromise;
    },
    async getSigningKeys(): Promise<SigningKey[]> {
      return [await keyPromise];
    },
  };
}

function parsePrivateJwk(jwk: string | webcrypto.JsonWebKey): SigningJwk {
  if (typeof jwk !== 'string') {
    return jwk as SigningJwk;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jwk);
  } catch (cause) {
    throw new Error('Signing key JWK is not valid JSON', { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Signing key JWK must be a JSON object');
  }
  return parsed as SigningJwk;
}

function resolveKeyId(jwk: SigningJwk, keyId: string | undefined): string {
  const jwkKid = jwk.kid;
  if (keyId && jwkKid && keyId !== jwkKid) {
    throw new Error(
      `Signing key JWK kid "${jwkKid}" does not match the configured key id "${keyId}"`,
    );
  }
  const resolved = keyId ?? jwkKid;
  // RFC 7517 §4.5: a persisted key is identified by its kid, and the whole point
  // of persisting it is that the kid keeps resolving to the same key material.
  if (!resolved) {
    throw new Error('Signing key JWK must carry a kid, or a key id must be supplied');
  }
  return resolved;
}

/**
 * Derive the JWK published at `jwks_uri` from a private JWK: drop every private
 * member (RFC 7517 §4 — a JWK Set of public keys) and pin `alg` / `use` / `kid`.
 */
function toPublicJwk(jwk: SigningJwk, keyId: string): SigningJwk {
  const publicJwk: SigningJwk = { ...jwk };
  for (const member of [...PRIVATE_JWK_MEMBERS, ...IMPORT_ONLY_JWK_MEMBERS]) {
    delete (publicJwk as Record<string, unknown>)[member];
  }
  publicJwk.alg = jwk.alg ?? defaultAlgForJwk(jwk);
  publicJwk.use = 'sig';
  publicJwk.kid = keyId;
  return publicJwk;
}

/**
 * Fill in `alg` for JWKs exported without it (WebCrypto's `exportKey` omits it).
 * OIDC Core 1.0 §15.1 makes RS256 the mandatory RSA algorithm, and RFC 7518 §3.4
 * pairs each EC curve with exactly one ECDSA algorithm.
 */
function defaultAlgForJwk(jwk: webcrypto.JsonWebKey): string | undefined {
  if (jwk.kty === 'RSA') return 'RS256';
  if (jwk.kty === 'EC') {
    if (jwk.crv === 'P-256') return 'ES256';
    if (jwk.crv === 'P-384') return 'ES384';
    if (jwk.crv === 'P-521') return 'ES512';
  }
  return undefined;
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
