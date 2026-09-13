import { describe, it, expect } from 'vitest';
import {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  createCachedSigningKeyProvider,
  createJwkSigningKeyProvider,
  getRegisteredSigningKeys,
  resolveSigningKeyProvider,
  selectSigningKeyByAlg,
} from './signing-key.js';
import type { SigningKeyProvider, SigningKey } from './signing-key.js';
import { generateIdToken } from './id-token.js';
import { extractAlgorithmParamsFromJwk } from './crypto-utils.js';

async function generateRsaKeyPair(hash: 'SHA-256' | 'SHA-384' | 'SHA-512' = 'SHA-256') {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash,
    },
    true,
    ['sign', 'verify'],
  );
}

async function generateEcKeyPair(curve: 'P-256' | 'P-384' | 'P-521' = 'P-256') {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: curve },
    true,
    ['sign', 'verify'],
  );
}

function makeStubProvider(key: SigningKey): SigningKeyProvider & { callCount: number } {
  const provider = {
    callCount: 0,
    async getSigningKey(): Promise<SigningKey> {
      provider.callCount++;
      return key;
    },
  };
  return provider;
}

const stubKey: SigningKey = {
  privateKey: {} as CryptoKey,
  publicJwk: { kty: 'RSA' },
  keyId: 'test-key',
};

describe('createCachedSigningKeyProvider', () => {
  it('should return a provider with getSigningKey method', () => {
    const cached = createCachedSigningKeyProvider(makeStubProvider(stubKey), 1000);
    expect(typeof cached.getSigningKey).toBe('function');
  });

  it('should call the base provider on first call', async () => {
    const base = makeStubProvider(stubKey);
    const cached = createCachedSigningKeyProvider(base, 60000);
    expect(base.callCount).toBe(0);
    await cached.getSigningKey();
    expect(base.callCount).toBe(1);
  });

  it('should return the cached key within TTL without calling base again', async () => {
    const base = makeStubProvider(stubKey);
    const cached = createCachedSigningKeyProvider(base, 60000);
    await cached.getSigningKey();
    await cached.getSigningKey();
    expect(base.callCount).toBe(1);
  });

  it('should return the key from the base provider', async () => {
    const base = makeStubProvider(stubKey);
    const cached = createCachedSigningKeyProvider(base, 60000);
    const key = await cached.getSigningKey();
    expect(key).toBe(stubKey);
  });

  it('should re-fetch from base provider after TTL expires', async () => {
    const base = makeStubProvider(stubKey);
    // Negative TTL guarantees the cache is always expired
    const cached = createCachedSigningKeyProvider(base, -1);
    await cached.getSigningKey();
    await cached.getSigningKey();
    expect(base.callCount).toBe(2);
  });
});

describe('createCachedSigningKeyProvider with getSigningKeys', () => {
  function makeMultiProvider(
    current: SigningKey,
    registered: SigningKey[],
  ): SigningKeyProvider & { getCalls: number; getKeysCalls: number } {
    const provider = {
      getCalls: 0,
      getKeysCalls: 0,
      async getSigningKey(): Promise<SigningKey> {
        provider.getCalls++;
        return current;
      },
      async getSigningKeys(): Promise<SigningKey[]> {
        provider.getKeysCalls++;
        return registered;
      },
    };
    return provider;
  }

  it('should call base getSigningKeys on first call', async () => {
    const base = makeMultiProvider(stubKey, [stubKey]);
    const cached = createCachedSigningKeyProvider(base, 60000);
    expect(cached.getSigningKeys).toBeDefined();
    await cached.getSigningKeys!();
    expect(base.getKeysCalls).toBe(1);
  });

  it('should return cached registered keys within TTL without calling base again', async () => {
    const base = makeMultiProvider(stubKey, [stubKey]);
    const cached = createCachedSigningKeyProvider(base, 60000);
    await cached.getSigningKeys!();
    await cached.getSigningKeys!();
    expect(base.getKeysCalls).toBe(1);
  });

  it('should re-fetch registered keys after TTL expires', async () => {
    const base = makeMultiProvider(stubKey, [stubKey]);
    const cached = createCachedSigningKeyProvider(base, -1);
    await cached.getSigningKeys!();
    await cached.getSigningKeys!();
    expect(base.getKeysCalls).toBe(2);
  });

  it('should provide getSigningKeys even when base does not implement it (fallback to [getSigningKey()])', async () => {
    const base = makeStubProvider(stubKey);
    const cached = createCachedSigningKeyProvider(base, 60000);
    expect(cached.getSigningKeys).toBeDefined();
    const keys = await cached.getSigningKeys!();
    expect(keys).toEqual([stubKey]);
    expect(base.callCount).toBe(1);
  });
});

describe('getRegisteredSigningKeys', () => {
  it('should return getSigningKeys() result when implemented', async () => {
    const k1: SigningKey = { ...stubKey, keyId: 'k1' };
    const k2: SigningKey = { ...stubKey, keyId: 'k2' };
    const provider: SigningKeyProvider = {
      async getSigningKey() {
        return k2;
      },
      async getSigningKeys() {
        return [k1, k2];
      },
    };
    const keys = await getRegisteredSigningKeys(provider);
    expect(keys).toEqual([k1, k2]);
  });

  it('should fall back to [getSigningKey()] when getSigningKeys is not implemented', async () => {
    const provider: SigningKeyProvider = {
      async getSigningKey() {
        return stubKey;
      },
    };
    const keys = await getRegisteredSigningKeys(provider);
    expect(keys).toEqual([stubKey]);
  });
});

describe('selectSigningKeyByAlg', () => {
  // OIDC Dynamic Client Registration §2: id_token_signed_response_alg
  // Default to RS256 when client did not request a specific algorithm.
  it('should pick the RS256 key when requestedAlg is undefined (default)', async () => {
    const rsa = await generateRsaKeyPair('SHA-256');
    const ec = await generateEcKeyPair('P-256');
    const rsaSigningKey: SigningKey = { privateKey: rsa.privateKey, publicJwk: { kty: 'RSA' }, keyId: 'rsa' };
    const ecSigningKey: SigningKey = { privateKey: ec.privateKey, publicJwk: { kty: 'EC' }, keyId: 'ec' };
    const picked = selectSigningKeyByAlg([rsaSigningKey, ecSigningKey], undefined);
    expect(picked.keyId).toBe('rsa');
  });

  it('should pick the matching key when requestedAlg is RS256', async () => {
    const rsa = await generateRsaKeyPair('SHA-256');
    const ec = await generateEcKeyPair('P-256');
    const rsaSigningKey: SigningKey = { privateKey: rsa.privateKey, publicJwk: { kty: 'RSA' }, keyId: 'rsa' };
    const ecSigningKey: SigningKey = { privateKey: ec.privateKey, publicJwk: { kty: 'EC' }, keyId: 'ec' };
    const picked = selectSigningKeyByAlg([rsaSigningKey, ecSigningKey], 'RS256');
    expect(picked.keyId).toBe('rsa');
  });

  it('should pick the matching key when requestedAlg is ES256', async () => {
    const rsa = await generateRsaKeyPair('SHA-256');
    const ec = await generateEcKeyPair('P-256');
    const rsaSigningKey: SigningKey = { privateKey: rsa.privateKey, publicJwk: { kty: 'RSA' }, keyId: 'rsa' };
    const ecSigningKey: SigningKey = { privateKey: ec.privateKey, publicJwk: { kty: 'EC' }, keyId: 'ec' };
    const picked = selectSigningKeyByAlg([rsaSigningKey, ecSigningKey], 'ES256');
    expect(picked.keyId).toBe('ec');
  });

  it('should throw when no key matches the requested alg', async () => {
    const rsa = await generateRsaKeyPair('SHA-256');
    const rsaSigningKey: SigningKey = { privateKey: rsa.privateKey, publicJwk: { kty: 'RSA' }, keyId: 'rsa' };
    expect(() => selectSigningKeyByAlg([rsaSigningKey], 'ES256')).toThrow();
  });

  it('should throw when keys array is empty', () => {
    expect(() => selectSigningKeyByAlg([], 'RS256')).toThrow();
  });

  it('should pick the latest matching key when multiple keys share the same alg (rotation)', async () => {
    // 配列順は古い → 新しい。同一 alg の鍵が複数ある場合は最新（末尾）を新規署名に使う。
    const rsa1 = await generateRsaKeyPair('SHA-256');
    const rsa2 = await generateRsaKeyPair('SHA-256');
    const old: SigningKey = { privateKey: rsa1.privateKey, publicJwk: { kty: 'RSA' }, keyId: 'old' };
    const recent: SigningKey = { privateKey: rsa2.privateKey, publicJwk: { kty: 'RSA' }, keyId: 'recent' };
    const picked = selectSigningKeyByAlg([old, recent], 'RS256');
    expect(picked.keyId).toBe('recent');
  });
});

describe('assertHasRs256Key', () => {
  // OIDC Core 1.0 §15.1: RS256 MUST be supported.
  // The check is satisfied when at least one RS256-capable key is registered;
  // additional keys with other algorithms (e.g. ES256) are allowed.
  it('should not throw when an RS256 key is included', async () => {
    const rsa = await generateRsaKeyPair('SHA-256');
    expect(() => assertHasRs256Key([rsa.privateKey])).not.toThrow();
  });

  it('should not throw when an RS256 key is mixed with an ES256 key', async () => {
    const rsa = await generateRsaKeyPair('SHA-256');
    const ec = await generateEcKeyPair('P-256');
    expect(() => assertHasRs256Key([rsa.privateKey, ec.privateKey])).not.toThrow();
  });

  it('should throw when no RS256 key is included (only ES256)', async () => {
    const ec = await generateEcKeyPair('P-256');
    expect(() => assertHasRs256Key([ec.privateKey])).toThrow();
  });

  it('should throw when an RSA key uses a non-SHA-256 hash (e.g. RS384)', async () => {
    const rsa = await generateRsaKeyPair('SHA-384');
    expect(() => assertHasRs256Key([rsa.privateKey])).toThrow();
  });

  it('should throw when key set is empty', () => {
    expect(() => assertHasRs256Key([])).toThrow();
  });
});

describe('assertKidStrategyConsistent', () => {
  function key(keyId: string): SigningKey {
    return { privateKey: {} as CryptoKey, publicJwk: { kty: 'RSA' }, keyId };
  }

  it('should accept a single key even when its kid is empty', () => {
    expect(() => assertKidStrategyConsistent([key('')])).not.toThrow();
  });

  it('should accept multiple keys with distinct non-empty kids', () => {
    expect(() => assertKidStrategyConsistent([key('a'), key('b')])).not.toThrow();
  });

  it('should throw when multiple keys include an empty kid', () => {
    expect(() => assertKidStrategyConsistent([key('a'), key('')])).toThrow(
      'Multiple signing keys are published but a key has an empty kid (RFC 7517 §4.5)',
    );
  });

  it('should throw when two keys share the same kid', () => {
    expect(() => assertKidStrategyConsistent([key('dup'), key('dup')])).toThrow(
      'Duplicate kid in signing key set: dup (RFC 7517 §4.5)',
    );
  });

  it('should accept an empty key set', () => {
    expect(() => assertKidStrategyConsistent([])).not.toThrow();
  });
});

describe('assertKeyStrength', () => {
  // Build a SigningKey whose publicJwk carries the real modulus/curve so the
  // strength check can inspect `n` / `crv`. We do not mock — keys are generated
  // via Web Crypto and exported to JWK.
  async function makeRsaSigningKey(
    modulusLength: number,
    keyId = 'rsa',
  ): Promise<SigningKey> {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return { privateKey: pair.privateKey, publicJwk, keyId };
  }

  async function makeEcSigningKey(
    curve: 'P-256' | 'P-384' | 'P-521',
    keyId = 'ec',
  ): Promise<SigningKey> {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: curve },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return { privateKey: pair.privateKey, publicJwk, keyId };
  }

  describe('RSA modulus strength', () => {
    // NIST SP 800-131A Rev.2: RSA 1024-bit is disallowed; >= 2048-bit required.
    it('should not throw when an RSA key has a 2048-bit modulus', async () => {
      const key = await makeRsaSigningKey(2048);
      expect(() => assertKeyStrength([key])).not.toThrow();
    });

    it('should throw when an RSA key has a 1024-bit modulus', async () => {
      const key = await makeRsaSigningKey(1024);
      expect(() => assertKeyStrength([key])).toThrow();
    });

    it('should include the offending kid in the error message', async () => {
      const key = await makeRsaSigningKey(1024, 'weak-rsa-key');
      expect(() => assertKeyStrength([key])).toThrow(/weak-rsa-key/);
    });

    it('should reject a weak RSA key even when a strong key is also present', async () => {
      const strong = await makeRsaSigningKey(2048, 'strong');
      const weak = await makeRsaSigningKey(1024, 'weak');
      expect(() => assertKeyStrength([strong, weak])).toThrow(/weak/);
    });

    it('should respect a custom minimum RSA modulus bit length', async () => {
      const key = await makeRsaSigningKey(2048);
      expect(() => assertKeyStrength([key], { minRsaModulusBits: 4096 })).toThrow();
    });

    it('should throw when an RSA JWK is missing its modulus (n)', () => {
      const key: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'RSA' },
        keyId: 'no-modulus',
      };
      expect(() => assertKeyStrength([key])).toThrow();
    });
  });

  describe('EC curve approval', () => {
    // NIST-approved curves for signing: P-256 / P-384 / P-521.
    it('should not throw when an EC key uses the P-256 curve', async () => {
      const key = await makeEcSigningKey('P-256');
      expect(() => assertKeyStrength([key])).not.toThrow();
    });

    it('should not throw when an EC key uses the P-521 curve', async () => {
      const key = await makeEcSigningKey('P-521');
      expect(() => assertKeyStrength([key])).not.toThrow();
    });

    it('should throw when an EC key uses a non-approved curve (P-192)', () => {
      // Web Crypto cannot generate P-192, so build the JWK directly; the check
      // only inspects kty/crv, not the actual point.
      const key: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'EC', crv: 'P-192', x: 'AAAA', y: 'AAAA' },
        keyId: 'weak-ec-key',
      };
      expect(() => assertKeyStrength([key])).toThrow(/weak-ec-key/);
    });

    it('should respect a custom allowed-curve policy', async () => {
      const key = await makeEcSigningKey('P-256');
      expect(() =>
        assertKeyStrength([key], { allowedCurves: ['P-384', 'P-521'] }),
      ).toThrow();
    });
  });

  describe('mixed and edge cases', () => {
    it('should not throw for an empty key set', () => {
      expect(() => assertKeyStrength([])).not.toThrow();
    });

    it('should not throw when a strong RSA key and an approved EC key coexist', async () => {
      const rsa = await makeRsaSigningKey(2048);
      const ec = await makeEcSigningKey('P-256');
      expect(() => assertKeyStrength([rsa, ec])).not.toThrow();
    });

    it('should throw for an unsupported key type', () => {
      const key: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'oct' },
        keyId: 'symmetric',
      };
      expect(() => assertKeyStrength([key])).toThrow();
    });
  });
});

/**
 * Helpers for the persistent (JWK-loaded) signing key provider.
 *
 * A "private JWK" here is the full RSA private key in JWK form — the shape a
 * deployment stores in a secret and hands to `createJwkSigningKeyProvider`.
 */
async function generatePrivateRsaJwk(
  kid: string,
  modulusLength = 2048,
): Promise<JsonWebKey & { kid?: string; alg?: string; use?: string }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey & {
    kid?: string;
    alg?: string;
    use?: string;
  };
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  jwk.kid = kid;
  // key_ops/ext come from the export and would over-constrain importKey('jwk', …, ['sign']).
  delete (jwk as { key_ops?: string[] }).key_ops;
  delete (jwk as { ext?: boolean }).ext;
  return jwk;
}

/**
 * Verify a compact JWS the way a relying party does: read the `kid` from the
 * JOSE Header, pick the matching JWK from the published set, and verify.
 * Returns false when no key matches or the signature does not check out.
 */
async function verifyJwtAgainstJwks(
  jwt: string,
  jwks: readonly SigningKey[],
): Promise<boolean> {
  const [headerB64, payloadB64, signatureB64] = jwt.split('.');
  const header = JSON.parse(
    new TextDecoder().decode(base64UrlToBytes(headerB64!)),
  ) as { kid?: string };
  const match = jwks.find((key) => key.keyId === header.kid);
  if (!match) return false;
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    match.publicJwk,
    extractAlgorithmParamsFromJwk(match.publicJwk),
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    publicKey.algorithm.name,
    publicKey,
    base64UrlToBytes(signatureB64!),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function idTokenPayload() {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'http://localhost:3000',
    sub: 'user-1',
    aud: 'example-client',
    exp: now + 3600,
    iat: now,
  };
}

/**
 * Regression guard for the ephemeral key generation the samples used to rely on.
 *
 * OIDC Core 1.0 §10.1 / RFC 7515 §4.1.4: a relying party selects the verifying
 * key by `kid`. Generating a fresh key pair per process while pinning `kid` to a
 * constant breaks that contract — every instance publishes a different key under
 * the same name, so verification fails intermittently depending on which
 * instance served `jwks_uri` and which one signed the token.
 */
describe('signing keys that share a kid but not key material', () => {
  it('should fail ID Token verification when the JWKS comes from a different instance', async () => {
    const instanceA = createJwkSigningKeyProvider(
      await generatePrivateRsaJwk('shared-kid'),
    );
    const instanceB = createJwkSigningKeyProvider(
      await generatePrivateRsaJwk('shared-kid'),
    );

    const signingKey = await instanceA.getSigningKey();
    const idToken = await generateIdToken({
      payload: idTokenPayload(),
      privateKey: signingKey.privateKey,
      keyId: signingKey.keyId,
    });

    const jwksFromB = await getRegisteredSigningKeys(instanceB);
    expect(await verifyJwtAgainstJwks(idToken, jwksFromB)).toBe(false);
  });
});

describe('createJwkSigningKeyProvider', () => {
  describe('Key material stability', () => {
    it('should return the same public JWK from two providers built from the same JWK', async () => {
      const jwk = await generatePrivateRsaJwk('persistent-key');
      const first = createJwkSigningKeyProvider(jwk);
      const second = createJwkSigningKeyProvider(JSON.stringify(jwk));

      const firstKey = await first.getSigningKey();
      const secondKey = await second.getSigningKey();

      expect(secondKey.publicJwk).toEqual(firstKey.publicJwk);
    });

    it('should use the kid carried by the JWK as the keyId', async () => {
      const provider = createJwkSigningKeyProvider(
        await generatePrivateRsaJwk('persistent-key'),
      );
      const key = await provider.getSigningKey();
      expect(key.keyId).toBe('persistent-key');
    });

    it('should use the explicit keyId when the JWK carries no kid', async () => {
      const jwk = await generatePrivateRsaJwk('unused');
      delete jwk.kid;
      const provider = createJwkSigningKeyProvider(jwk, 'explicit-key');
      const key = await provider.getSigningKey();
      expect(key.keyId).toBe('explicit-key');
    });

    it('should publish exactly one key through getSigningKeys', async () => {
      const provider = createJwkSigningKeyProvider(
        await generatePrivateRsaJwk('persistent-key'),
      );
      const keys = await getRegisteredSigningKeys(provider);
      expect(keys.map((key) => key.keyId)).toEqual(['persistent-key']);
    });
  });

  describe('Published JWK', () => {
    // RFC 7517 §4: the JWK Set published at jwks_uri contains public keys only.
    it('should strip RSA private parameters from the published JWK', async () => {
      const provider = createJwkSigningKeyProvider(
        await generatePrivateRsaJwk('persistent-key'),
      );
      const key = await provider.getSigningKey();
      expect(Object.keys(key.publicJwk).sort()).toEqual([
        'alg',
        'e',
        'kid',
        'kty',
        'n',
        'use',
      ]);
    });

    // OIDC Core 1.0 §10.1: the published JWK declares the algorithm and intended use.
    it('should publish the JWK as an RS256 signature key', async () => {
      const provider = createJwkSigningKeyProvider(
        await generatePrivateRsaJwk('persistent-key'),
      );
      const key = await provider.getSigningKey();
      expect(key.publicJwk).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    });

    it('should publish the resolved kid in the JWK', async () => {
      const jwk = await generatePrivateRsaJwk('unused');
      delete jwk.kid;
      const provider = createJwkSigningKeyProvider(jwk, 'explicit-key');
      const key = await provider.getSigningKey();
      expect(key.publicJwk.kid).toBe('explicit-key');
    });
  });

  describe('Signing', () => {
    it('should sign an ID Token that verifies against its own JWKS', async () => {
      const provider = createJwkSigningKeyProvider(
        await generatePrivateRsaJwk('persistent-key'),
      );
      const signingKey = await provider.getSigningKey();
      const idToken = await generateIdToken({
        payload: idTokenPayload(),
        privateKey: signingKey.privateKey,
        keyId: signingKey.keyId,
      });

      const jwks = await getRegisteredSigningKeys(provider);
      expect(await verifyJwtAgainstJwks(idToken, jwks)).toBe(true);
    });

    it('should sign an ID Token that verifies against a JWKS loaded from the same JWK', async () => {
      const jwk = await generatePrivateRsaJwk('persistent-key');
      const signingInstance = createJwkSigningKeyProvider(jwk);
      const jwksInstance = createJwkSigningKeyProvider(JSON.stringify(jwk));

      const signingKey = await signingInstance.getSigningKey();
      const idToken = await generateIdToken({
        payload: idTokenPayload(),
        privateKey: signingKey.privateKey,
        keyId: signingKey.keyId,
      });

      const jwks = await getRegisteredSigningKeys(jwksInstance);
      expect(await verifyJwtAgainstJwks(idToken, jwks)).toBe(true);
    });

    it('should set the JOSE Header alg to RS256', async () => {
      const provider = createJwkSigningKeyProvider(
        await generatePrivateRsaJwk('persistent-key'),
      );
      const signingKey = await provider.getSigningKey();
      const idToken = await generateIdToken({
        payload: idTokenPayload(),
        privateKey: signingKey.privateKey,
        keyId: signingKey.keyId,
      });
      const header = JSON.parse(
        new TextDecoder().decode(base64UrlToBytes(idToken.split('.')[0]!)),
      ) as { alg: string; kid: string };
      expect(header).toMatchObject({ alg: 'RS256', kid: 'persistent-key' });
    });
  });

  describe('Startup validation', () => {
    it('should reject a malformed JWK JSON string', async () => {
      expect(() => createJwkSigningKeyProvider('{ not json')).toThrow(
        'Signing key JWK is not valid JSON',
      );
    });

    it('should reject a JSON string that is not an object', async () => {
      expect(() => createJwkSigningKeyProvider('"a string"')).toThrow(
        'Signing key JWK must be a JSON object',
      );
    });

    it('should reject a JWK whose kid conflicts with the explicit keyId', async () => {
      const jwk = await generatePrivateRsaJwk('kid-in-jwk');
      expect(() => createJwkSigningKeyProvider(jwk, 'different-kid')).toThrow(
        'Signing key JWK kid "kid-in-jwk" does not match the configured key id "different-kid"',
      );
    });

    it('should reject a JWK with neither a kid nor an explicit keyId', async () => {
      const jwk = await generatePrivateRsaJwk('unused');
      delete jwk.kid;
      expect(() => createJwkSigningKeyProvider(jwk)).toThrow(
        'Signing key JWK must carry a kid',
      );
    });

    // NIST SP 800-131A Rev.2 via assertKeyStrength: RSA below 2048 bits is rejected.
    it('should reject an RSA key whose modulus is below 2048 bits', async () => {
      const jwk = await generatePrivateRsaJwk('weak-key', 1024);
      expect(() => createJwkSigningKeyProvider(jwk)).toThrow(
        'Signing key "weak-key" has a 1024-bit RSA modulus; minimum allowed is 2048 bits (NIST SP 800-131A Rev.2)',
      );
    });

    it('should reject a public-only JWK that cannot sign', async () => {
      const jwk = await generatePrivateRsaJwk('public-only');
      delete (jwk as { d?: string }).d;
      expect(() => createJwkSigningKeyProvider(jwk)).toThrow(
        'Signing key JWK "public-only" has no private key material (d)',
      );
    });

    it('should reject an unsupported key type', async () => {
      expect(() =>
        createJwkSigningKeyProvider({ kty: 'oct', k: 'AAAA', kid: 'symmetric' }),
      ).toThrow('Signing key "symmetric" uses unsupported key type "oct"');
    });

    it('should accept a weak key when the strength policy allows it', async () => {
      const jwk = await generatePrivateRsaJwk('weak-key', 1024);
      const provider = createJwkSigningKeyProvider(jwk, undefined, {
        minRsaModulusBits: 1024,
      });
      const key = await provider.getSigningKey();
      expect(key.keyId).toBe('weak-key');
    });
  });
});

describe('resolveSigningKeyProvider', () => {
  function collectWarnings(): { messages: string[]; onEphemeralFallback: (m: string) => void } {
    const messages: string[] = [];
    return { messages, onEphemeralFallback: (message) => messages.push(message) };
  }

  describe('Persisted JWK configured', () => {
    it('should load the key from the persisted JWK', async () => {
      const jwk = await generatePrivateRsaJwk('persisted-key');
      const warnings = collectWarnings();
      const provider = resolveSigningKeyProvider({
        jwk: JSON.stringify(jwk),
        fallbackKeyId: 'fallback-key',
        onEphemeralFallback: warnings.onEphemeralFallback,
      });

      const key = await provider.getSigningKey();
      expect(key.keyId).toBe('persisted-key');
    });

    it('should not warn when a persisted JWK is configured', async () => {
      const jwk = await generatePrivateRsaJwk('persisted-key');
      const warnings = collectWarnings();
      resolveSigningKeyProvider({
        jwk: JSON.stringify(jwk),
        fallbackKeyId: 'fallback-key',
        onEphemeralFallback: warnings.onEphemeralFallback,
      });

      expect(warnings.messages).toEqual([]);
    });

    it('should return the same public JWK across two resolutions of the same key', async () => {
      const jwk = JSON.stringify(await generatePrivateRsaJwk('persisted-key'));
      const first = resolveSigningKeyProvider({ jwk, fallbackKeyId: 'fallback-key' });
      const second = resolveSigningKeyProvider({ jwk, fallbackKeyId: 'fallback-key' });

      const firstKey = await first.getSigningKey();
      const secondKey = await second.getSigningKey();

      expect(secondKey.publicJwk).toEqual(firstKey.publicJwk);
    });

    it('should pin the kid to the configured keyId', async () => {
      const jwk = await generatePrivateRsaJwk('unused');
      delete jwk.kid;
      const provider = resolveSigningKeyProvider({
        jwk: JSON.stringify(jwk),
        keyId: 'configured-key',
        fallbackKeyId: 'fallback-key',
      });

      const key = await provider.getSigningKey();
      expect(key.keyId).toBe('configured-key');
    });

    it('should surface startup validation errors from the persisted JWK', () => {
      expect(() =>
        resolveSigningKeyProvider({ jwk: '{ not json', fallbackKeyId: 'fallback-key' }),
      ).toThrow('Signing key JWK is not valid JSON');
    });
  });

  describe('Ephemeral fallback', () => {
    it('should fall back to an ephemeral key when no JWK is configured', async () => {
      const provider = resolveSigningKeyProvider({
        fallbackKeyId: 'fallback-key',
        onEphemeralFallback: () => undefined,
      });

      const key = await provider.getSigningKey();
      expect(key.keyId).toBe('fallback-key');
    });

    it('should treat an empty JWK string as not configured', async () => {
      const warnings = collectWarnings();
      const provider = resolveSigningKeyProvider({
        jwk: '',
        fallbackKeyId: 'fallback-key',
        onEphemeralFallback: warnings.onEphemeralFallback,
      });

      const key = await provider.getSigningKey();
      expect(key.keyId).toBe('fallback-key');
    });

    it('should prefer the configured keyId over the fallback kid', async () => {
      const provider = resolveSigningKeyProvider({
        keyId: 'configured-key',
        fallbackKeyId: 'fallback-key',
        onEphemeralFallback: () => undefined,
      });

      const key = await provider.getSigningKey();
      expect(key.keyId).toBe('configured-key');
    });

    it('should warn once that the key is per-process', () => {
      const warnings = collectWarnings();
      resolveSigningKeyProvider({
        fallbackKeyId: 'fallback-key',
        onEphemeralFallback: warnings.onEphemeralFallback,
      });

      expect(warnings.messages).toEqual([
        'No persisted signing key is configured, so an ephemeral RS256 key was generated for this process (kid "fallback-key"). The key material differs between instances and changes on every restart, so tokens signed here fail verification against another instance’s JWKS.',
      ]);
    });

    it('should append the persistence hint to the warning', () => {
      const warnings = collectWarnings();
      resolveSigningKeyProvider({
        fallbackKeyId: 'fallback-key',
        persistenceHint: 'Set OIDC_SIGNING_KEY_JWK.',
        onEphemeralFallback: warnings.onEphemeralFallback,
      });

      expect(warnings.messages).toEqual([
        'No persisted signing key is configured, so an ephemeral RS256 key was generated for this process (kid "fallback-key"). The key material differs between instances and changes on every restart, so tokens signed here fail verification against another instance’s JWKS. Set OIDC_SIGNING_KEY_JWK.',
      ]);
    });

    it('should publish the ephemeral key as an RS256 signature key', async () => {
      const provider = resolveSigningKeyProvider({
        fallbackKeyId: 'fallback-key',
        onEphemeralFallback: () => undefined,
      });

      const key = await provider.getSigningKey();
      expect(key.publicJwk).toMatchObject({
        kty: 'RSA',
        alg: 'RS256',
        use: 'sig',
        kid: 'fallback-key',
      });
    });

    it('should publish exactly one ephemeral key through getSigningKeys', async () => {
      const provider = resolveSigningKeyProvider({
        fallbackKeyId: 'fallback-key',
        onEphemeralFallback: () => undefined,
      });

      const keys = await getRegisteredSigningKeys(provider);
      expect(keys.map((key) => key.keyId)).toEqual(['fallback-key']);
    });

    it('should return the same key on repeated calls within one process', async () => {
      const provider = resolveSigningKeyProvider({
        fallbackKeyId: 'fallback-key',
        onEphemeralFallback: () => undefined,
      });

      const first = await provider.getSigningKey();
      const second = await provider.getSigningKey();
      expect(second.publicJwk).toEqual(first.publicJwk);
    });

    // This is the hazard the persisted key removes: same kid, different key material.
    it('should generate different key material for each fallback resolution', async () => {
      const first = resolveSigningKeyProvider({
        fallbackKeyId: 'fallback-key',
        onEphemeralFallback: () => undefined,
      });
      const second = resolveSigningKeyProvider({
        fallbackKeyId: 'fallback-key',
        onEphemeralFallback: () => undefined,
      });

      const firstKey = await first.getSigningKey();
      const secondKey = await second.getSigningKey();
      expect(secondKey.publicJwk.n === firstKey.publicJwk.n).toBe(false);
    });

    it('should sign an ID Token that verifies against its own JWKS', async () => {
      const provider = resolveSigningKeyProvider({
        fallbackKeyId: 'fallback-key',
        onEphemeralFallback: () => undefined,
      });

      const signingKey = await provider.getSigningKey();
      const idToken = await generateIdToken({
        payload: idTokenPayload(),
        privateKey: signingKey.privateKey,
        keyId: signingKey.keyId,
      });

      expect(await verifyJwtAgainstJwks(idToken, await getRegisteredSigningKeys(provider))).toBe(
        true,
      );
    });
  });
});
