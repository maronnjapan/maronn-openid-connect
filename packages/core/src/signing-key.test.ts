import { describe, it, expect } from 'vitest';
import {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  createCachedSigningKeyProvider,
  getRegisteredSigningKeys,
  selectSigningKeyByAlg,
} from './signing-key.js';
import type { SigningKeyProvider, SigningKey } from './signing-key.js';

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
