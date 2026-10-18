/**
 * Signing keys for the tests: generated once per key id and reused, because
 * an RSA key pair takes a moment to generate.
 */
import type { SigningKey, SigningKeyProvider } from '@maronn-openid-connect/core';

const keys = new Map<string, Promise<SigningKey>>();

/** An RS256 signing key with the given key id. */
export function rs256Key(keyId = 'test-rs256-key'): Promise<SigningKey> {
  let key = keys.get(keyId);
  if (!key) {
    key = generateRs256Key(keyId);
    keys.set(keyId, key);
  }
  return key;
}

/** A SigningKeyProvider that returns the given keys. */
export function staticKeyProvider(...signingKeys: SigningKey[]): SigningKeyProvider {
  return {
    async getSigningKeys() {
      return signingKeys;
    },
  };
}

async function generateRs256Key(keyId: string): Promise<SigningKey> {
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
