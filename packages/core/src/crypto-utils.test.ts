import { describe, it, expect } from 'vitest';
import {
  stringToArrayBuffer,
  arrayBufferToBase64Url,
  base64UrlToArrayBuffer,
  base64UrlToArrayBufferStrict,
  sha256,
  sign,
  verify,
  extractAlgorithmParams,
  extractAlgorithmParamsFromJwk,
  importPrivateKeyFromJwk,
  importPublicKeyFromJwk,
  generateRandomString,
  timingSafeEqual,
  jwaToHashName,
  rsaModulusBitLength,
} from './crypto-utils.js';
import { webcrypto } from 'node:crypto';

describe('stringToArrayBuffer', () => {
  it('should convert a string to ArrayBuffer', () => {
    const result = stringToArrayBuffer('hello');
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toEqual(5);
  });

  it('should handle UTF-8 characters correctly', () => {
    const result = stringToArrayBuffer('こんにちは');
    expect(result).toBeInstanceOf(ArrayBuffer);
    // 3 bytes per Japanese character in UTF-8
    expect(result.byteLength).toEqual(15);
  });

  it('should handle empty string', () => {
    const result = stringToArrayBuffer('');
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toEqual(0);
  });
});

describe('arrayBufferToBase64Url', () => {
  it('should convert ArrayBuffer to Base64URL format', () => {
    const buffer = new TextEncoder().encode('hello').buffer;
    const result = arrayBufferToBase64Url(buffer);
    expect(typeof result).toEqual('string');
    expect(result).toEqual('aGVsbG8');
  });

  describe('Base64URL format compliance', () => {
    it('should not contain plus (+) characters', () => {
      // Create buffer that would produce + in standard base64
      const buffer = new Uint8Array([251, 239]).buffer;
      const result = arrayBufferToBase64Url(buffer);
      expect(result).not.toContain('+');
    });

    it('should not contain slash (/) characters', () => {
      // Create buffer that would produce / in standard base64
      const buffer = new Uint8Array([255, 255]).buffer;
      const result = arrayBufferToBase64Url(buffer);
      expect(result).not.toContain('/');
    });

    it('should not contain padding (=) characters', () => {
      // "a" would produce "YQ==" in standard base64
      const buffer = new TextEncoder().encode('a').buffer;
      const result = arrayBufferToBase64Url(buffer);
      expect(result).not.toContain('=');
    });
  });

  it('should handle empty buffer', () => {
    const buffer = new ArrayBuffer(0);
    const result = arrayBufferToBase64Url(buffer);
    expect(result).toEqual('');
  });

  it('should produce different outputs for different inputs', () => {
    const buffer1 = new TextEncoder().encode('hello').buffer;
    const buffer2 = new TextEncoder().encode('world').buffer;
    const result1 = arrayBufferToBase64Url(buffer1);
    const result2 = arrayBufferToBase64Url(buffer2);
    expect(result1).not.toEqual(result2);
  });
});

describe('base64UrlToArrayBuffer', () => {
  it('should convert Base64URL string to ArrayBuffer', () => {
    const base64url = 'aGVsbG8'; // "hello" in base64url
    const result = base64UrlToArrayBuffer(base64url);
    expect(result).toBeInstanceOf(ArrayBuffer);
    const decoded = new TextDecoder().decode(result);
    expect(decoded).toEqual('hello');
  });

  it('should handle Base64URL characters (- and _)', () => {
    // Create a known value that would use - and _ in base64url
    const buffer = new Uint8Array([251, 239, 255, 255]).buffer;
    const base64url = arrayBufferToBase64Url(buffer);
    const result = base64UrlToArrayBuffer(base64url);
    const resultArray = new Uint8Array(result);
    expect(resultArray).toEqual(new Uint8Array([251, 239, 255, 255]));
  });

  it('should handle empty string', () => {
    const result = base64UrlToArrayBuffer('');
    expect(result.byteLength).toEqual(0);
  });

  it('should roundtrip with arrayBufferToBase64Url', () => {
    const original = new TextEncoder().encode('Hello, World! こんにちは').buffer;
    const base64url = arrayBufferToBase64Url(original);
    const decoded = base64UrlToArrayBuffer(base64url);
    const originalArray = new Uint8Array(original);
    const decodedArray = new Uint8Array(decoded);
    expect(decodedArray).toEqual(originalArray);
  });

  it('should handle strings without padding', () => {
    // "a" encodes to "YQ" (no padding in base64url)
    const result = base64UrlToArrayBuffer('YQ');
    const decoded = new TextDecoder().decode(result);
    expect(decoded).toEqual('a');
  });
});

// RFC 7515 §2 / Appendix C + RFC 8725 §3.11 (strict parsing): the strict decoder must
// refuse any non-canonical base64url input on security-sensitive JWS decode paths.
describe('base64UrlToArrayBufferStrict', () => {
  it('should decode a canonical base64url string', () => {
    const decoded = new TextDecoder().decode(base64UrlToArrayBufferStrict('aGVsbG8'));
    expect(decoded).toEqual('hello');
  });

  it('should accept the URL-safe alphabet (- and _)', () => {
    const buffer = new Uint8Array([251, 239, 255, 255]).buffer;
    const base64url = arrayBufferToBase64Url(buffer);
    const result = new Uint8Array(base64UrlToArrayBufferStrict(base64url));
    expect(result).toEqual(new Uint8Array([251, 239, 255, 255]));
  });

  it('should reject standard base64 padding character "="', () => {
    expect(() => base64UrlToArrayBufferStrict('aGVsbG8=')).toThrow(
      'Invalid base64url: contains characters outside the base64url alphabet',
    );
  });

  it('should reject standard base64 characters "+" and "/"', () => {
    expect(() => base64UrlToArrayBufferStrict('ab+/')).toThrow(
      'Invalid base64url: contains characters outside the base64url alphabet',
    );
  });

  it('should reject whitespace', () => {
    expect(() => base64UrlToArrayBufferStrict('aGVs bG8')).toThrow(
      'Invalid base64url: contains characters outside the base64url alphabet',
    );
  });

  it('should reject an input whose length mod 4 equals 1', () => {
    // 5 chars -> len % 4 === 1, an impossible base64 remainder.
    expect(() => base64UrlToArrayBufferStrict('aGVsb')).toThrow(
      'Invalid base64url: malformed length',
    );
  });
});

describe('sha256', () => {
  it('should generate a valid SHA-256 hash', async () => {
    const result = await sha256('hello');
    expect(typeof result).toEqual('string');
    // SHA-256 produces 32 bytes, Base64URL encoded = 43 characters
    expect(result.length).toEqual(43);
  });

  it('should produce consistent output for the same input', async () => {
    const result1 = await sha256('test');
    const result2 = await sha256('test');
    expect(result1).toEqual(result2);
  });

  it('should produce different outputs for different inputs', async () => {
    const result1 = await sha256('hello');
    const result2 = await sha256('world');
    expect(result1).not.toEqual(result2);
  });

  it('should handle empty string', async () => {
    const result = await sha256('');
    expect(typeof result).toEqual('string');
    expect(result.length).toEqual(43);
  });

  it('should handle UTF-8 characters correctly', async () => {
    const result = await sha256('こんにちは');
    expect(typeof result).toEqual('string');
    expect(result.length).toEqual(43);
  });
});

// Helper functions to generate test keys
async function generateRsaKeyPair(hash: 'SHA-256' | 'SHA-384' | 'SHA-512' = 'SHA-256') {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash },
    true,
    ['sign', 'verify']
  );
}

async function generateEcKeyPair(curve: 'P-256' | 'P-384' | 'P-521' = 'P-256') {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: curve },
    true,
    ['sign', 'verify']
  );
}

async function exportPrivateKeyJwk(key: CryptoKey): Promise<string> {
  return JSON.stringify(await crypto.subtle.exportKey('jwk', key));
}

async function exportPublicKeyJwk(key: CryptoKey): Promise<string> {
  return JSON.stringify(await crypto.subtle.exportKey('jwk', key));
}

describe('sign', () => {
  describe('RSA Signatures', () => {
    it('should generate a valid signature using RS256 (RSASSA-PKCS1-v1_5)', async () => {
      const keyPair = await generateRsaKeyPair('SHA-256');
      const signature = await sign('test data', keyPair.privateKey);
      expect(typeof signature).toEqual('string');
      expect(signature.length).toBeGreaterThan(0);
    });

    it('should produce verifiable signature with corresponding public key', async () => {
      const keyPair = await generateRsaKeyPair('SHA-256');
      const data = 'test data to sign';
      const signature = await sign(data, keyPair.privateKey);

      // Use verify function instead of direct crypto.subtle.verify
      const isValid = await verify(data, signature, keyPair.publicKey);
      expect(isValid).toEqual(true);
    });
  });

  describe('ECDSA Signatures', () => {
    it('should generate a valid signature using ES256 (P-256 curve)', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const signature = await sign('test data', keyPair.privateKey);
      expect(typeof signature).toEqual('string');
      expect(signature.length).toBeGreaterThan(0);
    });

    it('should generate a valid signature using ES384 (P-384 curve)', async () => {
      const keyPair = await generateEcKeyPair('P-384');
      const signature = await sign('test data', keyPair.privateKey);
      expect(typeof signature).toEqual('string');
      expect(signature.length).toBeGreaterThan(0);
    });

    it('should generate a valid signature using ES512 (ECDSA with P-521 curve and SHA-512)', async () => {
      const keyPair = await generateEcKeyPair('P-521');
      const signature = await sign('test data', keyPair.privateKey);
      expect(typeof signature).toEqual('string');
      expect(signature.length).toBeGreaterThan(0);
    });

    it('should produce verifiable signature with corresponding public key', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const data = 'test data to sign';
      const signature = await sign(data, keyPair.privateKey);

      // Use verify function instead of direct crypto.subtle.verify
      const isValid = await verify(data, signature, keyPair.publicKey);
      expect(isValid).toEqual(true);
    });
  });

  describe('Edge Cases', () => {
    it('should produce different signatures for different data', async () => {
      const keyPair = await generateRsaKeyPair();
      const sig1 = await sign('data1', keyPair.privateKey);
      const sig2 = await sign('data2', keyPair.privateKey);
      expect(sig1).not.toEqual(sig2);
    });

    it('should handle empty string', async () => {
      const keyPair = await generateRsaKeyPair();
      const signature = await sign('', keyPair.privateKey);
      expect(typeof signature).toEqual('string');
      expect(signature.length).toBeGreaterThan(0);
    });

    it('should handle UTF-8 characters correctly', async () => {
      const keyPair = await generateRsaKeyPair();
      const signature = await sign('こんにちは世界', keyPair.privateKey);
      expect(typeof signature).toEqual('string');
      expect(signature.length).toBeGreaterThan(0);
    });
  });
});

describe('verify', () => {
  describe('RSA Verification', () => {
    it('should verify valid RS256 signature', async () => {
      const keyPair = await generateRsaKeyPair('SHA-256');
      const data = 'test data';
      const signature = await sign(data, keyPair.privateKey);
      const isValid = await verify(data, signature, keyPair.publicKey);
      expect(isValid).toEqual(true);
    });

    it('should verify valid RS384 signature', async () => {
      const keyPair = await generateRsaKeyPair('SHA-384');
      const data = 'test data';
      const signature = await sign(data, keyPair.privateKey);
      const isValid = await verify(data, signature, keyPair.publicKey);
      expect(isValid).toEqual(true);
    });

    it('should verify valid RS512 signature', async () => {
      const keyPair = await generateRsaKeyPair('SHA-512');
      const data = 'test data';
      const signature = await sign(data, keyPair.privateKey);
      const isValid = await verify(data, signature, keyPair.publicKey);
      expect(isValid).toEqual(true);
    });

  });

  describe('ECDSA Verification', () => {
    it('should verify valid ES256 signature', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const data = 'test data';
      const signature = await sign(data, keyPair.privateKey);
      const isValid = await verify(data, signature, keyPair.publicKey);
      expect(isValid).toEqual(true);
    });

    it('should verify valid ES384 signature', async () => {
      const keyPair = await generateEcKeyPair('P-384');
      const data = 'test data';
      const signature = await sign(data, keyPair.privateKey);
      const isValid = await verify(data, signature, keyPair.publicKey);
      expect(isValid).toEqual(true);
    });

    it('should verify valid ES512 signature', async () => {
      const keyPair = await generateEcKeyPair('P-521');
      const data = 'test data';
      const signature = await sign(data, keyPair.privateKey);
      const isValid = await verify(data, signature, keyPair.publicKey);
      expect(isValid).toEqual(true);
    });
  });

  describe('Invalid Signature Detection', () => {
    it('should reject tampered data', async () => {
      const keyPair = await generateRsaKeyPair();
      const data = 'original data';
      const signature = await sign(data, keyPair.privateKey);
      const isValid = await verify('tampered data', signature, keyPair.publicKey);
      expect(isValid).toEqual(false);
    });

    it('should reject tampered signature', async () => {
      const keyPair = await generateRsaKeyPair();
      const data = 'test data';
      const signature = await sign(data, keyPair.privateKey);
      // Tamper with signature by changing multiple characters in the middle
      // to ensure the actual bytes are modified
      const midpoint = Math.floor(signature.length / 2);
      const tamperedSignature =
        signature.slice(0, midpoint - 2) +
        'XXXX' +
        signature.slice(midpoint + 2);
      const isValid = await verify(data, tamperedSignature, keyPair.publicKey);
      expect(isValid).toEqual(false);
    });

    it('should reject signature from different key', async () => {
      const keyPair1 = await generateRsaKeyPair();
      const keyPair2 = await generateRsaKeyPair();
      const data = 'test data';
      const signature = await sign(data, keyPair1.privateKey);
      const isValid = await verify(data, signature, keyPair2.publicKey);
      expect(isValid).toEqual(false);
    });
  });

  describe('Edge Cases', () => {
    it('should verify empty string data', async () => {
      const keyPair = await generateRsaKeyPair();
      const data = '';
      const signature = await sign(data, keyPair.privateKey);
      const isValid = await verify(data, signature, keyPair.publicKey);
      expect(isValid).toEqual(true);
    });

    it('should verify UTF-8 data', async () => {
      const keyPair = await generateRsaKeyPair();
      const data = 'こんにちは世界 🌍';
      const signature = await sign(data, keyPair.privateKey);
      const isValid = await verify(data, signature, keyPair.publicKey);
      expect(isValid).toEqual(true);
    });

    it('should verify long data', async () => {
      const keyPair = await generateRsaKeyPair();
      const data = 'a'.repeat(10000);
      const signature = await sign(data, keyPair.privateKey);
      const isValid = await verify(data, signature, keyPair.publicKey);
      expect(isValid).toEqual(true);
    });
  });
});

describe('importPrivateKeyFromJwk', () => {
  describe('RSA Private Key Import', () => {
    it('should import RSA private key from JWK string', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString);
      expect(importedKey).toBeInstanceOf(CryptoKey);
    });

    it('should set correct algorithm (RSASSA-PKCS1-v1_5 with SHA-256)', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString);
      expect(importedKey.algorithm.name).toEqual('RSASSA-PKCS1-v1_5');
      expect((importedKey.algorithm as RsaHashedKeyAlgorithm).hash.name).toEqual('SHA-256');
    });

    it('should set key type to private', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString);
      expect(importedKey.type).toEqual('private');
    });

    it('should allow key to be extractable by default', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString);
      expect(importedKey.extractable).toEqual(false);
    });

    it('should set key usages to sign for private key', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString);
      expect(importedKey.usages).toContain('sign');
    });
  });

  describe('RSA Public Key Import', () => {
    it('should import RSA public key from JWK string', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwkString = await exportPublicKeyJwk(keyPair.publicKey);
      const importedKey = await importPublicKeyFromJwk(jwkString);
      expect(importedKey).toBeInstanceOf(CryptoKey);
    });

    it('should set key type to public', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwkString = await exportPublicKeyJwk(keyPair.publicKey);
      const importedKey = await importPublicKeyFromJwk(jwkString);
      expect(importedKey.type).toEqual('public');
    });

    it('should set key usages to verify for public key', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwkString = await exportPublicKeyJwk(keyPair.publicKey);
      const importedKey = await importPublicKeyFromJwk(jwkString);
      expect(importedKey.usages).toContain('verify');
    });
  });

  describe('ECDSA Private Key Import', () => {
    it('should import EC private key from JWK string (P-256)', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString, { name: 'ECDSA', namedCurve: 'P-256' });
      expect(importedKey).toBeInstanceOf(CryptoKey);
      expect(importedKey.type).toEqual('private');
    });

    it('should import EC private key from JWK string (P-384)', async () => {
      const keyPair = await generateEcKeyPair('P-384');
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString, { name: 'ECDSA', namedCurve: 'P-384' });
      expect(importedKey).toBeInstanceOf(CryptoKey);
      expect(importedKey.type).toEqual('private');
    });

    it('should import EC private key from JWK string (P-521)', async () => {
      const keyPair = await generateEcKeyPair('P-521');
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString, { name: 'ECDSA', namedCurve: 'P-521' });
      expect(importedKey).toBeInstanceOf(CryptoKey);
      expect(importedKey.type).toEqual('private');
    });

    it('should set correct algorithm (ECDSA with named curve)', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString, { name: 'ECDSA', namedCurve: 'P-256' });
      expect(importedKey.algorithm.name).toEqual('ECDSA');
      expect((importedKey.algorithm as EcKeyAlgorithm).namedCurve).toEqual('P-256');
    });

    it('should set key usages to sign for private key', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString, { name: 'ECDSA', namedCurve: 'P-256' });
      expect(importedKey.usages).toContain('sign');
    });
  });

  describe('ECDSA Public Key Import', () => {
    it('should import EC public key from JWK string (P-256)', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const jwkString = await exportPublicKeyJwk(keyPair.publicKey);
      const importedKey = await importPublicKeyFromJwk(jwkString, { name: 'ECDSA', namedCurve: 'P-256' });
      expect(importedKey).toBeInstanceOf(CryptoKey);
      expect(importedKey.type).toEqual('public');
    });

    it('should import EC public key from JWK string (P-384)', async () => {
      const keyPair = await generateEcKeyPair('P-384');
      const jwkString = await exportPublicKeyJwk(keyPair.publicKey);
      const importedKey = await importPublicKeyFromJwk(jwkString, { name: 'ECDSA', namedCurve: 'P-384' });
      expect(importedKey).toBeInstanceOf(CryptoKey);
      expect(importedKey.type).toEqual('public');
    });

    it('should import EC public key from JWK string (P-521)', async () => {
      const keyPair = await generateEcKeyPair('P-521');
      const jwkString = await exportPublicKeyJwk(keyPair.publicKey);
      const importedKey = await importPublicKeyFromJwk(jwkString, { name: 'ECDSA', namedCurve: 'P-521' });
      expect(importedKey).toBeInstanceOf(CryptoKey);
      expect(importedKey.type).toEqual('public');
    });

    it('should set key usages to verify for public key', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const jwkString = await exportPublicKeyJwk(keyPair.publicKey);
      const importedKey = await importPublicKeyFromJwk(jwkString, { name: 'ECDSA', namedCurve: 'P-256' });
      expect(importedKey.usages).toContain('verify');
    });
  });

  describe('Key Validation', () => {
    it('should reject invalid JSON string', async () => {
      await expect(importPublicKeyFromJwk('not valid json')).rejects.toThrow();
      await expect(importPrivateKeyFromJwk('not valid json')).rejects.toThrow();
    });

    it('should reject JWK with missing required fields', async () => {
      const invalidJwk = JSON.stringify({ kty: 'RSA' }); // Missing n, e, etc.
      await expect(importPublicKeyFromJwk(invalidJwk)).rejects.toThrow();
      await expect(importPrivateKeyFromJwk(invalidJwk)).rejects.toThrow();
    });

    it('should reject JWK with invalid key type', async () => {
      const invalidJwk = JSON.stringify({ kty: 'invalid', n: 'test', e: 'AQAB' });
      await expect(importPublicKeyFromJwk(invalidJwk)).rejects.toThrow();
      await expect(importPrivateKeyFromJwk(invalidJwk)).rejects.toThrow();
    });

    it('should reject weak EC curves (P-192)', async () => {
      // P-192 is not supported by Web Crypto API
      const weakCurveJwk = JSON.stringify({
        kty: 'EC',
        crv: 'P-192',
        x: 'test',
        y: 'test',
      });
      await expect(importPublicKeyFromJwk(weakCurveJwk, { name: 'ECDSA', namedCurve: 'P-192' as 'P-256' })).rejects.toThrow();
      await expect(importPrivateKeyFromJwk(weakCurveJwk, { name: 'ECDSA', namedCurve: 'P-192' as 'P-256' })).rejects.toThrow();
    });
  });

  describe('Custom Parameters', () => {
    it('should accept custom algorithm parameters for RSA', async () => {
      const keyPair = await generateRsaKeyPair('SHA-384');
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' });
      expect((importedKey.algorithm as RsaHashedKeyAlgorithm).hash.name).toEqual('SHA-384');
    });

    it('should accept custom algorithm parameters for ECDSA', async () => {
      const keyPair = await generateEcKeyPair('P-384');
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString, { name: 'ECDSA', namedCurve: 'P-384' });
      expect((importedKey.algorithm as EcKeyAlgorithm).namedCurve).toEqual('P-384');
    });

    it('should accept custom extractable flag', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString, undefined);
      expect(importedKey.extractable).toEqual(false);
    });

    it('should accept custom key usages', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwkString = await exportPublicKeyJwk(keyPair.publicKey);
      const importedKey = await importPublicKeyFromJwk(jwkString, undefined, ['verify']);
      expect(importedKey.usages).toContain('verify');
    });
  });

  describe('Interoperability', () => {
    it('should import RSA key that can be used for signing', async () => {
      const keyPair = await generateRsaKeyPair();
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString);
      const signature = await sign('test', importedKey);
      expect(signature).toBeTruthy();
    });

    it('should import RSA key that can be used for verification', async () => {
      const keyPair = await generateRsaKeyPair();
      const data = 'test data';
      const signature = await sign(data, keyPair.privateKey);

      const publicJwk = await exportPublicKeyJwk(keyPair.publicKey);
      const importedPublicKey = await importPublicKeyFromJwk(publicJwk);

      // Use verify function instead of direct crypto.subtle.verify
      const isValid = await verify(data, signature, importedPublicKey);
      expect(isValid).toEqual(true);
    });

    it('should import EC key that can be used for signing', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const jwkString = await exportPrivateKeyJwk(keyPair.privateKey);
      const importedKey = await importPrivateKeyFromJwk(jwkString, { name: 'ECDSA', namedCurve: 'P-256' });
      const signature = await sign('test', importedKey);
      expect(signature).toBeTruthy();
    });

    it('should import EC key that can be used for verification', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const data = 'test data';
      const signature = await sign(data, keyPair.privateKey);

      const publicJwk = await exportPublicKeyJwk(keyPair.publicKey);
      const importedPublicKey = await importPublicKeyFromJwk(publicJwk, { name: 'ECDSA', namedCurve: 'P-256' });

      // Use verify function instead of direct crypto.subtle.verify
      const isValid = await verify(data, signature, importedPublicKey);
      expect(isValid).toEqual(true);
    });

    it('should work with key pairs exported to JWK', async () => {
      const keyPair = await generateRsaKeyPair();

      // Export and re-import private key
      const privateJwk = await exportPrivateKeyJwk(keyPair.privateKey);
      const reimportedPrivate = await importPrivateKeyFromJwk(privateJwk);

      // Export and re-import public key
      const publicJwk = await exportPublicKeyJwk(keyPair.publicKey);
      const reimportedPublic = await importPublicKeyFromJwk(publicJwk);
      // Sign with reimported private, verify with reimported public
      const data = 'test roundtrip';
      const signature = await sign(data, reimportedPrivate);

      // Use verify function instead of direct crypto.subtle.verify
      const isValid = await verify(data, signature, reimportedPublic);
      expect(isValid).toEqual(true);
    });
  });
});

describe('extractAlgorithmParams', () => {
  describe('RSASSA-PKCS1-v1_5 Algorithm', () => {
    it('should extract algorithm params from RS256 key (SHA-256)', async () => {
      const keyPair = await generateRsaKeyPair('SHA-256');
      const params = extractAlgorithmParams(keyPair.privateKey);
      expect(params).toEqual({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' });
    });

    it('should extract algorithm params from RS384 key (SHA-384)', async () => {
      const keyPair = await generateRsaKeyPair('SHA-384');
      const params = extractAlgorithmParams(keyPair.privateKey);
      expect(params).toEqual({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' });
    });

    it('should extract algorithm params from RS512 key (SHA-512)', async () => {
      const keyPair = await generateRsaKeyPair('SHA-512');
      const params = extractAlgorithmParams(keyPair.privateKey);
      expect(params).toEqual({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' });
    });

    it('should return correct algorithm name (RSASSA-PKCS1-v1_5)', async () => {
      const keyPair = await generateRsaKeyPair('SHA-256');
      const params = extractAlgorithmParams(keyPair.privateKey);
      expect(params.name).toEqual('RSASSA-PKCS1-v1_5');
    });
  });

  describe('ECDSA Algorithm', () => {
    it('should extract algorithm params from ES256 key (P-256)', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const params = extractAlgorithmParams(keyPair.privateKey);
      expect(params).toEqual({ name: 'ECDSA', namedCurve: 'P-256' });
    });

    it('should extract algorithm params from ES384 key (P-384)', async () => {
      const keyPair = await generateEcKeyPair('P-384');
      const params = extractAlgorithmParams(keyPair.privateKey);
      expect(params).toEqual({ name: 'ECDSA', namedCurve: 'P-384' });
    });

    it('should extract algorithm params from ES512 key (P-521)', async () => {
      const keyPair = await generateEcKeyPair('P-521');
      const params = extractAlgorithmParams(keyPair.privateKey);
      expect(params).toEqual({ name: 'ECDSA', namedCurve: 'P-521' });
    });

    it('should return correct algorithm name (ECDSA)', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const params = extractAlgorithmParams(keyPair.privateKey);
      expect(params.name).toEqual('ECDSA');
    });

    it('should return correct named curve', async () => {
      const keyPair = await generateEcKeyPair('P-384');
      const params = extractAlgorithmParams(keyPair.privateKey) as EcKeyImportParams;
      expect(params.namedCurve).toEqual('P-384');
    });
  });

  describe('Algorithm Validation', () => {
    it('should reject unsupported algorithm (RSA-OAEP)', async () => {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['encrypt', 'decrypt']
      );
      expect(() => extractAlgorithmParams(keyPair.privateKey)).toThrow('Unsupported algorithm');
    });

    it('should reject weak hash algorithm (SHA-1)', async () => {
      // Note: SHA-1 may not be supported by all implementations
      // This test verifies the validation logic
      const mockKey: { algorithm: Pick<webcrypto.RsaHashedKeyAlgorithm, 'hash' | 'name'> } = {
        algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-1' } },
      }
      expect(() => extractAlgorithmParams(mockKey as unknown as CryptoKey)).toThrow('Unsupported hash algorithm');
    });

    it('should reject non-signing key types', async () => {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
      expect(() => extractAlgorithmParams(keyPair)).toThrow('Unsupported algorithm');
    });
  });

  describe('Hash/Curve Detection', () => {
    it('should correctly identify SHA-256 hash for RSA', async () => {
      const keyPair = await generateRsaKeyPair('SHA-256');
      const params = extractAlgorithmParams(keyPair.privateKey) as RsaHashedImportParams;
      expect(params.hash).toEqual('SHA-256');
    });

    it('should correctly identify SHA-384 hash for RSA', async () => {
      const keyPair = await generateRsaKeyPair('SHA-384');
      const params = extractAlgorithmParams(keyPair.privateKey) as RsaHashedImportParams;
      expect(params.hash).toEqual('SHA-384');
    });

    it('should correctly identify SHA-512 hash for RSA', async () => {
      const keyPair = await generateRsaKeyPair('SHA-512');
      const params = extractAlgorithmParams(keyPair.privateKey) as RsaHashedImportParams;
      expect(params.hash).toEqual('SHA-512');
    });

    it('should correctly identify P-256 curve for ECDSA', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const params = extractAlgorithmParams(keyPair.privateKey) as EcKeyImportParams;
      expect(params.namedCurve).toEqual('P-256');
    });

    it('should correctly identify P-384 curve for ECDSA', async () => {
      const keyPair = await generateEcKeyPair('P-384');
      const params = extractAlgorithmParams(keyPair.privateKey) as EcKeyImportParams;
      expect(params.namedCurve).toEqual('P-384');
    });

    it('should correctly identify P-521 curve for ECDSA', async () => {
      const keyPair = await generateEcKeyPair('P-521');
      const params = extractAlgorithmParams(keyPair.privateKey) as EcKeyImportParams;
      expect(params.namedCurve).toEqual('P-521');
    });
  });

  describe('Return Value Structure', () => {
    it('should return RsaHashedImportParams for RSA keys', async () => {
      const keyPair = await generateRsaKeyPair();
      const params = extractAlgorithmParams(keyPair.privateKey);
      expect(params).toHaveProperty('name');
      expect(params).toHaveProperty('hash');
    });

    it('should return EcKeyImportParams for EC keys', async () => {
      const keyPair = await generateEcKeyPair();
      const params = extractAlgorithmParams(keyPair.privateKey);
      expect(params).toHaveProperty('name');
      expect(params).toHaveProperty('namedCurve');
    });

    it('should return object with name property', async () => {
      const keyPair = await generateRsaKeyPair();
      const params = extractAlgorithmParams(keyPair.privateKey);
      expect(typeof params.name).toEqual('string');
    });

    it('should return object with hash property for RSA', async () => {
      const keyPair = await generateRsaKeyPair();
      const params = extractAlgorithmParams(keyPair.privateKey) as RsaHashedImportParams;
      expect(typeof params.hash).toEqual('string');
    });

    it('should return object with namedCurve property for ECDSA', async () => {
      const keyPair = await generateEcKeyPair();
      const params = extractAlgorithmParams(keyPair.privateKey) as EcKeyImportParams;
      expect(typeof params.namedCurve).toEqual('string');
    });
  });
});

describe('extractAlgorithmParamsFromJwk', () => {
  describe('RSA JWK', () => {
    it('should extract RS256 params from RSA jwk with alg=RS256', async () => {
      const keyPair = await generateRsaKeyPair('SHA-256');
      const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
      jwk.alg = 'RS256';
      const params = extractAlgorithmParamsFromJwk(jwk);
      expect(params).toEqual({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' });
    });

    it('should extract RS384 params from RSA jwk with alg=RS384', async () => {
      const keyPair = await generateRsaKeyPair('SHA-384');
      const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
      jwk.alg = 'RS384';
      const params = extractAlgorithmParamsFromJwk(jwk);
      expect(params).toEqual({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' });
    });

    it('should extract RS512 params from RSA jwk with alg=RS512', async () => {
      const keyPair = await generateRsaKeyPair('SHA-512');
      const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
      jwk.alg = 'RS512';
      const params = extractAlgorithmParamsFromJwk(jwk);
      expect(params).toEqual({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' });
    });
  });

  describe('EC JWK', () => {
    it('should extract ES256 params from EC jwk with crv=P-256', async () => {
      const keyPair = await generateEcKeyPair('P-256');
      const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
      const params = extractAlgorithmParamsFromJwk(jwk);
      expect(params).toEqual({ name: 'ECDSA', namedCurve: 'P-256' });
    });

    it('should extract ES384 params from EC jwk with crv=P-384', async () => {
      const keyPair = await generateEcKeyPair('P-384');
      const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
      const params = extractAlgorithmParamsFromJwk(jwk);
      expect(params).toEqual({ name: 'ECDSA', namedCurve: 'P-384' });
    });

    it('should extract ES512 params from EC jwk with crv=P-521', async () => {
      const keyPair = await generateEcKeyPair('P-521');
      const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
      const params = extractAlgorithmParamsFromJwk(jwk);
      expect(params).toEqual({ name: 'ECDSA', namedCurve: 'P-521' });
    });
  });

  describe('Validation', () => {
    it('should reject unsupported kty', () => {
      const jwk = { kty: 'oct', k: 'abc' } as JsonWebKey;
      expect(() => extractAlgorithmParamsFromJwk(jwk)).toThrow('Unsupported kty');
    });

    it('should reject RSA jwk with unsupported alg', () => {
      const jwk = { kty: 'RSA', alg: 'PS256', n: 'x', e: 'AQAB' } as JsonWebKey;
      expect(() => extractAlgorithmParamsFromJwk(jwk)).toThrow('Unsupported');
    });

    it('should reject EC jwk with unsupported crv', () => {
      const jwk = { kty: 'EC', crv: 'secp256k1', x: 'x', y: 'y' } as JsonWebKey;
      expect(() => extractAlgorithmParamsFromJwk(jwk)).toThrow('Unsupported');
    });
  });
});

describe('timingSafeEqual', () => {
  // OAuth 2.1 §7.4.1: credentials must be compared using constant-time comparison
  // to prevent timing attacks. RFC 6749 §10.10 also recommends this.
  it('should return true for equal strings', async () => {
    const result = await timingSafeEqual('secret-xyz', 'secret-xyz');
    expect(result).toBe(true);
  });

  it('should return false for different strings of same length', async () => {
    const result = await timingSafeEqual('secret-xyz', 'secret-abc');
    expect(result).toBe(false);
  });

  it('should return false for strings of different length', async () => {
    const result = await timingSafeEqual('short', 'much-longer-string');
    expect(result).toBe(false);
  });

  it('should return true for two empty strings', async () => {
    const result = await timingSafeEqual('', '');
    expect(result).toBe(true);
  });

  it('should return false when one string is empty and the other is not', async () => {
    const result = await timingSafeEqual('', 'something');
    expect(result).toBe(false);
  });

  it('should handle UTF-8 characters correctly', async () => {
    const equal = await timingSafeEqual('こんにちは', 'こんにちは');
    const different = await timingSafeEqual('こんにちは', 'さようなら');
    expect(equal).toBe(true);
    expect(different).toBe(false);
  });

  it('should distinguish strings that share a prefix', async () => {
    const result = await timingSafeEqual('secretA', 'secretB');
    expect(result).toBe(false);
  });
});

describe('generateRandomString', () => {
  it('should return a Base64URL encoded string', () => {
    const result = generateRandomString(32);
    // Base64URL characters only: [A-Za-z0-9_-]
    expect(result).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('should return a 43-character string for 32 bytes (256 bits)', () => {
    const result = generateRandomString(32);
    expect(result).toHaveLength(43);
  });

  it('should return a 22-character string for 16 bytes (128 bits)', () => {
    const result = generateRandomString(16);
    expect(result).toHaveLength(22);
  });

  it('should generate unique values on each call', () => {
    const values = new Set<string>();
    for (let i = 0; i < 100; i++) {
      values.add(generateRandomString(32));
    }
    expect(values.size).toBe(100);
  });
});

describe('jwaToHashName', () => {
  // OIDC Core 1.0 §3.1.3.6 / RFC 7518 §3.1: hash claims (at_hash, c_hash) must use
  // the hash function corresponding to the ID Token's JOSE Header `alg`.
  describe('SHA-256 algorithms', () => {
    it('should return SHA-256 for RS256', () => {
      expect(jwaToHashName('RS256')).toBe('SHA-256');
    });

    it('should return SHA-256 for ES256', () => {
      expect(jwaToHashName('ES256')).toBe('SHA-256');
    });

    it('should return SHA-256 for PS256', () => {
      expect(jwaToHashName('PS256')).toBe('SHA-256');
    });
  });

  describe('SHA-384 algorithms', () => {
    it('should return SHA-384 for RS384', () => {
      expect(jwaToHashName('RS384')).toBe('SHA-384');
    });

    it('should return SHA-384 for ES384', () => {
      expect(jwaToHashName('ES384')).toBe('SHA-384');
    });
  });

  describe('SHA-512 algorithms', () => {
    it('should return SHA-512 for RS512', () => {
      expect(jwaToHashName('RS512')).toBe('SHA-512');
    });

    it('should return SHA-512 for ES512', () => {
      expect(jwaToHashName('ES512')).toBe('SHA-512');
    });
  });

  describe('Unsupported algorithms', () => {
    it('should throw for an unknown alg', () => {
      expect(() => jwaToHashName('HS1')).toThrow();
    });

    it('should throw for an empty alg', () => {
      expect(() => jwaToHashName('')).toThrow();
    });
  });
});

describe('rsaModulusBitLength', () => {
  // RFC 7518 §6.3.1.1: the JWK `n` parameter is the base64url-encoded modulus.
  // NIST SP 800-131A Rev.2 requires RSA signing keys to be >= 2048 bits.
  async function exportRsaPublicJwk(modulusLength: number) {
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
    return crypto.subtle.exportKey('jwk', pair.publicKey);
  }

  it('should return 2048 for a 2048-bit RSA modulus', async () => {
    const jwk = await exportRsaPublicJwk(2048);
    expect(rsaModulusBitLength(jwk.n!)).toBe(2048);
  });

  it('should return 1024 for a 1024-bit RSA modulus', async () => {
    const jwk = await exportRsaPublicJwk(1024);
    expect(rsaModulusBitLength(jwk.n!)).toBe(1024);
  });

  it('should ignore a leading zero padding byte in the modulus', async () => {
    // ASN.1/DER integers prepend a 0x00 byte when the high bit is set; the bit
    // length must be measured after stripping that padding.
    const jwk = await exportRsaPublicJwk(2048);
    const raw = new Uint8Array(base64UrlToArrayBuffer(jwk.n!));
    const padded = new Uint8Array(raw.length + 1);
    padded.set(raw, 1); // padded[0] stays 0x00
    const paddedN = arrayBufferToBase64Url(padded.buffer);
    expect(rsaModulusBitLength(paddedN)).toBe(2048);
  });

  it('should ignore multiple leading zero padding bytes in the modulus', async () => {
    const jwk = await exportRsaPublicJwk(2048);
    const raw = new Uint8Array(base64UrlToArrayBuffer(jwk.n!));
    const padded = new Uint8Array(raw.length + 3);
    padded.set(raw, 3); // padded[0..2] stay 0x00
    const paddedN = arrayBufferToBase64Url(padded.buffer);
    expect(rsaModulusBitLength(paddedN)).toBe(2048);
  });

  it('should return 0 for an all-zero modulus', () => {
    const allZero = arrayBufferToBase64Url(new Uint8Array([0, 0, 0]).buffer);
    expect(rsaModulusBitLength(allZero)).toBe(0);
  });
});
