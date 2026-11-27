/**
 * Helpers for the tests of the dpop extension: a client's DPoP key pairs and
 * the JWS it signs with them (RFC 9449 §4.2).
 */
import { encodeBase64Url } from '../oidc-provider/features/dpop/base64url.js';
import type { DpopPublicJwk, DpopSigningAlg } from '../oidc-provider/features/dpop/jwk.js';

/** A DPoP key pair of a client for alg. */
export interface TestDpopKey {
  alg: DpopSigningAlg;
  privateKey: CryptoKey;
  publicJwk: DpopPublicJwk;
}

const RSA = { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };

/** Generate a key pair for alg and return its private key and its public JWK (public members only). */
export async function generateDpopKey(alg: DpopSigningAlg = 'ES256'): Promise<TestDpopKey> {
  const params = keyGenParamsOf(alg);
  const pair = (await crypto.subtle.generateKey(params as never, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, unknown>;
  const publicJwk: Record<string, unknown> = { kty: jwk.kty };
  for (const member of ['crv', 'n', 'e', 'x', 'y']) {
    if (jwk[member] !== undefined) publicJwk[member] = jwk[member];
  }
  return { alg, privateKey: pair.privateKey, publicJwk: publicJwk as unknown as DpopPublicJwk };
}

function keyGenParamsOf(alg: DpopSigningAlg): Record<string, unknown> {
  if (alg.startsWith('RS')) return { name: 'RSASSA-PKCS1-v1_5', hash: `SHA-${alg.slice(2)}`, ...RSA };
  if (alg.startsWith('PS')) return { name: 'RSA-PSS', hash: `SHA-${alg.slice(2)}`, ...RSA };
  if (alg === 'ES256') return { name: 'ECDSA', namedCurve: 'P-256' };
  if (alg === 'ES384') return { name: 'ECDSA', namedCurve: 'P-384' };
  if (alg === 'ES512') return { name: 'ECDSA', namedCurve: 'P-521' };
  return { name: 'Ed25519' };
}

function signParamsOf(alg: DpopSigningAlg): Record<string, unknown> {
  if (alg.startsWith('RS')) return { name: 'RSASSA-PKCS1-v1_5' };
  if (alg.startsWith('PS')) return { name: 'RSA-PSS', saltLength: Number(alg.slice(2)) / 8 };
  if (alg.startsWith('ES')) return { name: 'ECDSA', hash: `SHA-${alg.slice(2)}` };
  return { name: 'Ed25519' };
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * A DPoP proof signed with key: header typ dpop+jwt, alg of the key and its
 * public jwk, then the overrides of header (a member set to undefined is left
 * out), over the claims.
 */
export async function signDpopProof(
  key: TestDpopKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const fullHeader: Record<string, unknown> = { typ: 'dpop+jwt', alg: key.alg, jwk: key.publicJwk, ...header };
  for (const name of Object.keys(fullHeader)) {
    if (fullHeader[name] === undefined) delete fullHeader[name];
  }
  const signingInput = `${encodeJson(fullHeader)}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    signParamsOf(key.alg) as never,
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(signature)}`;
}
