/**
 * The signing keys of this sample, and their rotation while it runs (OIDC Core
 * 1.0 §10.1.1, the oidcc-server-rotate-keys module of the Dynamic OP plan).
 *
 * The generated _oidc-provider/provider.ts signs with the SigningKeyProvider
 * it finds on globalThis.__oidcSigningKeyProvider, and creates one there only
 * when there is none. instrumentation.ts puts the provider of this file there
 * before the server handles a request, and proxy.ts rotates it at
 * POST /operator/signing-keys/rotate. Next.js loads instrumentation.ts,
 * proxy.ts and the Route Handlers as separate bundles of one Node.js process,
 * so the keys are kept on globalThis, not in this module.
 */
import { createCachedSigningKeyProvider, type CachedSigningKeyProvider, type SigningKey } from '@maronn-openid-connect/core';

interface SampleSigningKeys {
  keys: Array<Promise<SigningKey>>;
  provider: CachedSigningKeyProvider;
}

const registry = globalThis as typeof globalThis & {
  __oidcSigningKeyProvider?: unknown;
  __sampleSigningKeys?: SampleSigningKeys;
};

/** The key id of the first key: OIDC_SIGNING_KEY_ID, as the generated provider.ts uses. */
const signingKeyId = process.env.OIDC_SIGNING_KEY_ID || 'nextjs-rs256-key';

/**
 * Generates the first RS256 key and puts a provider of the keys on
 * globalThis.__oidcSigningKeyProvider, where the generated provider.ts takes
 * it from. The provider caches the keys for 60 seconds, and a rotation drops
 * the cache. Calling it again keeps the keys it made the first time.
 */
export function installSigningKeys(): void {
  if (registry.__sampleSigningKeys !== undefined) return;
  const keys = [generateSigningKey(signingKeyId)];
  const provider = createCachedSigningKeyProvider({ getSigningKeys: () => Promise.all(keys) }, 60_000);
  registry.__sampleSigningKeys = { keys, provider };
  registry.__oidcSigningKeyProvider = provider;
}

/**
 * Generates a new RS256 key with a kid of its own, puts it first (new tokens
 * are signed with it), keeps the earlier ones after it (still in the JWKS) and
 * drops the cached keys so the next request uses it. Answers the kids in JWKS
 * order.
 *
 * @throws {Error} When installSigningKeys() has not run (instrumentation.ts)
 */
export async function rotateSigningKey(): Promise<{ kid: string; kids: string[] }> {
  const signingKeys = registry.__sampleSigningKeys;
  if (signingKeys === undefined) {
    throw new Error('The signing keys are not installed (instrumentation.ts)');
  }
  const key = await generateSigningKey(`${signingKeyId}-rotated-${signingKeys.keys.length}`);
  signingKeys.keys.unshift(Promise.resolve(key));
  signingKeys.provider.invalidate();
  return { kid: key.keyId, kids: (await Promise.all(signingKeys.keys)).map((current) => current.keyId) };
}

/** A 2048-bit RS256 key pair, its public JWK with alg RS256, use sig and the kid keyId. */
async function generateSigningKey(keyId: string): Promise<SigningKey> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey & {
    alg?: string;
    use?: string;
    kid?: string;
  };
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  publicJwk.kid = keyId;
  return { privateKey: keyPair.privateKey, publicJwk, keyId };
}
