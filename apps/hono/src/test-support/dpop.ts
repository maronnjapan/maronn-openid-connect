/**
 * Helpers for the tests of the dpop extension: a client's DPoP key pair, the
 * DPoP proofs it signs (RFC 9449 §4.2), and the thumbprint and ath the
 * provider computes from them.
 */
import { computeDpopAccessTokenHash, computeJwkThumbprint, type DpopPublicJwk } from '@maronn-openid-connect/dpop';

/** A DPoP key pair of a client (ES256). */
export interface DpopKey {
  privateKey: CryptoKey;
  publicJwk: DpopPublicJwk;
  /** The JWK Thumbprint of the public key (RFC 7638), the jkt of cnf. */
  jkt: string;
}

/** A new ES256 DPoP key pair and its thumbprint. */
export async function dpopKey(): Promise<DpopKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const { kty, crv, x, y } = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, string>;
  const publicJwk = { kty, crv, x, y } as DpopPublicJwk;
  return { privateKey: pair.privateKey, publicJwk, jkt: await computeJwkThumbprint(publicJwk) };
}

function encodeSegment(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeBytes(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let proofCount = 0;

/**
 * A DPoP proof of key for a request: htm and htu as given, iat now (Date.now,
 * so fake timers apply), a fresh jti, ath of the access token when one is
 * given, then the claims of overrides (undefined leaves a claim out).
 */
export async function dpopProof(
  key: DpopKey,
  request: { htm: string; htu: string; accessToken?: string },
  overrides: Record<string, unknown> = {},
): Promise<string> {
  proofCount += 1;
  const claims: Record<string, unknown> = {
    jti: `proof-${proofCount}-${crypto.randomUUID()}`,
    htm: request.htm,
    htu: request.htu,
    iat: Math.floor(Date.now() / 1000),
    ...(request.accessToken === undefined ? {} : { ath: await computeDpopAccessTokenHash(request.accessToken) }),
    ...overrides,
  };
  for (const name of Object.keys(claims)) {
    if (claims[name] === undefined) delete claims[name];
  }
  const signingInput = `${encodeSegment({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk })}.${encodeSegment(claims)}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${encodeBytes(signature)}`;
}
