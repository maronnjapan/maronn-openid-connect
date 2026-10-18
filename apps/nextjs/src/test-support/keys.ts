/**
 * Signing keys for the tests: generated once per key id and reused, because
 * an RSA key pair takes a moment to generate.
 */
import type { SigningKey } from '@maronn-openid-connect/core';
import type { ProviderSigningKeys, SigningKeySet } from '../app/_oidc-provider/provider';

const rs256Keys = new Map<string, Promise<SigningKey>>();
const es256Keys = new Map<string, Promise<SigningKey>>();

/** An RS256 signing key with the given key id. */
export function rs256Key(keyId = 'test-rs256-key'): Promise<SigningKey> {
  let key = rs256Keys.get(keyId);
  if (!key) {
    key = generateKey(keyId, 'RS256', {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    });
    rs256Keys.set(keyId, key);
  }
  return key;
}

/** An ES256 signing key with the given key id. */
export function es256Key(keyId = 'test-es256-key'): Promise<SigningKey> {
  let key = es256Keys.get(keyId);
  if (!key) {
    key = generateKey(keyId, 'ES256', { name: 'ECDSA', namedCurve: 'P-256' });
    es256Keys.set(keyId, key);
  }
  return key;
}

/** The signing keys of provider.ts with the same key set for every purpose. */
export function providerSigningKeys(...keys: SigningKeySet): ProviderSigningKeys {
  return { general: keys, idToken: keys, userinfo: keys };
}

async function generateKey(
  keyId: string,
  alg: 'RS256' | 'ES256',
  algorithm: RsaHashedKeyGenParams | EcKeyGenParams,
): Promise<SigningKey> {
  const keyPair = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey & {
    alg?: string;
    use?: string;
    kid?: string;
  };
  publicJwk.alg = alg;
  publicJwk.use = 'sig';
  publicJwk.kid = keyId;
  return { privateKey: keyPair.privateKey, publicJwk, keyId };
}
