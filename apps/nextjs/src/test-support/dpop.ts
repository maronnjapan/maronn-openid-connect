/**
 * Helpers for the tests of the dpop extension: a client's DPoP key pairs, the
 * DPoP proofs it signs (RFC 9449 §4.2), and the thumbprint the provider
 * computes from them. The ath of a proof is computed here, not with
 * computeDpopAccessTokenHash() of proof.ts, so the tests of proof.ts compare
 * it with a computation of their own. It also keeps these helpers from
 * loading provider.ts, which proof.ts imports.
 */
import { encodeBase64Url } from '../app/_oidc-provider/features/dpop/base64url';
import { computeJwkThumbprint, type DpopPublicJwk, type DpopSigningAlg } from '../app/_oidc-provider/features/dpop/jwk';

/** A DPoP key pair of a client for alg. */
export interface TestDpopKey {
  alg: DpopSigningAlg;
  privateKey: CryptoKey;
  publicJwk: DpopPublicJwk;
}

/** A DPoP key pair of a client (ES256) with its thumbprint. */
export interface DpopKey extends TestDpopKey {
  /** The JWK Thumbprint of the public key (RFC 7638), the jkt of cnf. */
  jkt: string;
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

/** A new ES256 DPoP key pair and its thumbprint. */
export async function dpopKey(): Promise<DpopKey> {
  const key = await generateDpopKey('ES256');
  return { ...key, jkt: await computeJwkThumbprint(key.publicJwk) };
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

/** The ath of accessToken (RFC 9449 §4.2): the base64url of the SHA-256 of its ASCII. */
async function accessTokenHashOf(accessToken: string): Promise<string> {
  return encodeBase64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken)));
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
    ...(request.accessToken === undefined ? {} : { ath: await accessTokenHashOf(request.accessToken) }),
    ...overrides,
  };
  for (const name of Object.keys(claims)) {
    if (claims[name] === undefined) delete claims[name];
  }
  return signDpopProof(key, claims);
}
