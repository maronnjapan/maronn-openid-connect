import { describe, it, expect } from 'vitest';
import { exportJwks, exportPublicJwk, signingKeysToJwkSet } from './jwks.js';
import type { SigningKey } from './signing-key.js';

/**
 * RSA鍵ペアを生成するヘルパー
 */
async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
}

/**
 * ECDSA鍵ペアを生成するヘルパー（P-256）
 */
async function generateEcKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify']
  );
}

describe('exportPublicJwk', () => {
  describe('RSA key', () => {
    it('should export RSA public key with kty set to RSA', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwk = await exportPublicJwk(keyPair.publicKey);
      expect(jwk.kty).toBe('RSA');
    });

    it('should include n and e parameters for RSA key', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwk = await exportPublicJwk(keyPair.publicKey);
      expect(jwk.n).toBeDefined();
      expect(jwk.e).toBeDefined();
    });

    it('should not include private key parameters (d, p, q, dp, dq, qi)', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwk = await exportPublicJwk(keyPair.publicKey);
      expect(jwk.d).toBeUndefined();
      expect(jwk.p).toBeUndefined();
      expect(jwk.q).toBeUndefined();
      expect(jwk.dp).toBeUndefined();
      expect(jwk.dq).toBeUndefined();
      expect(jwk.qi).toBeUndefined();
    });

    it('should set use to sig', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwk = await exportPublicJwk(keyPair.publicKey);
      expect(jwk.use).toBe('sig');
    });

    it('should set alg to RS256 for RSASSA-PKCS1-v1_5 with SHA-256', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwk = await exportPublicJwk(keyPair.publicKey);
      expect(jwk.alg).toBe('RS256');
    });

    it('should include kid when provided', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwk = await exportPublicJwk(keyPair.publicKey, 'my-key-id');
      expect(jwk.kid).toBe('my-key-id');
    });

    it('should not include kid when not provided', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwk = await exportPublicJwk(keyPair.publicKey);
      expect(jwk.kid).toBeUndefined();
    });

    it('should export public key from private key (extracting public portion)', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwkFromPublic = await exportPublicJwk(keyPair.publicKey);
      const jwkFromPrivate = await exportPublicJwk(keyPair.privateKey);
      expect(jwkFromPrivate.kty).toBe('RSA');
      expect(jwkFromPrivate.n).toBe(jwkFromPublic.n);
      expect(jwkFromPrivate.e).toBe(jwkFromPublic.e);
      expect(jwkFromPrivate.d).toBeUndefined();
    });
  });

  describe('ECDSA key', () => {
    it('should export ECDSA public key with kty set to EC', async () => {
      const keyPair = await generateEcKeyPair();
      const jwk = await exportPublicJwk(keyPair.publicKey);
      expect(jwk.kty).toBe('EC');
    });

    it('should include x, y, and crv parameters for EC key', async () => {
      const keyPair = await generateEcKeyPair();
      const jwk = await exportPublicJwk(keyPair.publicKey);
      expect(jwk.x).toBeDefined();
      expect(jwk.y).toBeDefined();
      expect(jwk.crv).toBe('P-256');
    });

    it('should not include private key parameter (d)', async () => {
      const keyPair = await generateEcKeyPair();
      const jwk = await exportPublicJwk(keyPair.publicKey);
      expect(jwk.d).toBeUndefined();
    });

    it('should set alg to ES256 for ECDSA with P-256', async () => {
      const keyPair = await generateEcKeyPair();
      const jwk = await exportPublicJwk(keyPair.publicKey);
      expect(jwk.alg).toBe('ES256');
    });

    it('should set use to sig', async () => {
      const keyPair = await generateEcKeyPair();
      const jwk = await exportPublicJwk(keyPair.publicKey);
      expect(jwk.use).toBe('sig');
    });

    it('should export public key from EC private key', async () => {
      const keyPair = await generateEcKeyPair();
      const jwkFromPublic = await exportPublicJwk(keyPair.publicKey);
      const jwkFromPrivate = await exportPublicJwk(keyPair.privateKey);
      expect(jwkFromPrivate.kty).toBe('EC');
      expect(jwkFromPrivate.x).toBe(jwkFromPublic.x);
      expect(jwkFromPrivate.y).toBe(jwkFromPublic.y);
      expect(jwkFromPrivate.d).toBeUndefined();
    });
  });

  describe('Unsupported algorithm', () => {
    it('should throw error for unsupported algorithm', async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        true,
        ['sign', 'verify']
      );
      await expect(exportPublicJwk(key)).rejects.toThrow('Unsupported algorithm');
    });
  });
});

describe('exportJwks', () => {
  it('should return object with keys array', async () => {
    const keyPair = await generateRsaKeyPair();
    const jwks = await exportJwks([{ publicKey: keyPair.publicKey }]);
    expect(jwks).toHaveProperty('keys');
    expect(Array.isArray(jwks.keys)).toBe(true);
  });

  it('should export single key in keys array', async () => {
    const keyPair = await generateRsaKeyPair();
    const jwks = await exportJwks([{ publicKey: keyPair.publicKey, keyId: 'key-1' }]);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kid).toBe('key-1');
    expect(jwks.keys[0]?.kty).toBe('RSA');
  });

  it('should export multiple keys in keys array', async () => {
    const rsaKeyPair = await generateRsaKeyPair();
    const ecKeyPair = await generateEcKeyPair();
    const jwks = await exportJwks([
      { publicKey: rsaKeyPair.publicKey, keyId: 'rsa-key' },
      { publicKey: ecKeyPair.publicKey, keyId: 'ec-key' },
    ]);
    expect(jwks.keys).toHaveLength(2);
    expect(jwks.keys[0]?.kid).toBe('rsa-key');
    expect(jwks.keys[0]?.kty).toBe('RSA');
    expect(jwks.keys[1]?.kid).toBe('ec-key');
    expect(jwks.keys[1]?.kty).toBe('EC');
  });

  it('should return empty keys array when no keys provided', async () => {
    const jwks = await exportJwks([]);
    expect(jwks.keys).toHaveLength(0);
  });

  it('should export keys without keyId', async () => {
    const keyPair = await generateRsaKeyPair();
    const jwks = await exportJwks([{ publicKey: keyPair.publicKey }]);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kid).toBeUndefined();
  });
});

/**
 * Build a SigningKey from a CryptoKeyPair: stores the public part as a raw JWK
 * (as a SigningKeyProvider would) so signingKeysToJwkSet must re-derive alg/kid/use.
 */
async function toSigningKey(pair: CryptoKeyPair, keyId: string): Promise<SigningKey> {
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk, keyId };
}

describe('signingKeysToJwkSet', () => {
  // validateIdTokenHint matches keys by kid and requires alg/use, so the public
  // JWK Set built from the OP's own signing keys must carry kid, alg and use.
  it('should derive kid, alg and use for an RSA signing key', async () => {
    const key = await toSigningKey(await generateRsaKeyPair(), 'rsa-1');
    const jwks = await signingKeysToJwkSet([key]);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kid: 'rsa-1',
      kty: 'RSA',
      alg: 'RS256',
      use: 'sig',
    });
  });

  it('should preserve order and kid for multiple signing keys', async () => {
    const rsa = await toSigningKey(await generateRsaKeyPair(), 'rsa-1');
    const ec = await toSigningKey(await generateEcKeyPair(), 'ec-1');
    const jwks = await signingKeysToJwkSet([rsa, ec]);
    expect(jwks.keys).toHaveLength(2);
    expect(jwks.keys[0]?.kid).toBe('rsa-1');
    expect(jwks.keys[0]?.alg).toBe('RS256');
    expect(jwks.keys[1]?.kid).toBe('ec-1');
    expect(jwks.keys[1]?.alg).toBe('ES256');
  });

  it('should never leak private key material into the JWK Set', async () => {
    const key = await toSigningKey(await generateRsaKeyPair(), 'rsa-1');
    const jwks = await signingKeysToJwkSet([key]);
    expect(jwks.keys[0]?.d).toBeUndefined();
  });

  it('should return an empty keys array when no signing keys are provided', async () => {
    const jwks = await signingKeysToJwkSet([]);
    expect(jwks.keys).toEqual([]);
  });
});
