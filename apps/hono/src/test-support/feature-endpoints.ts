/**
 * Helpers for the tests of the feature endpoints (PAR, introspection,
 * revocation) and of the features that sign or verify JWTs (JARM, the JWT
 * introspection response, Request Objects).
 *
 * providerApp() is the provider of createApp() on an in-memory database of the
 * test, so a request goes through the middleware and the routes exactly as in
 * the running provider. The JWT helpers sign and read compact JWS with the Web
 * Crypto API, independently of the code under test.
 */
import type { AccessTokenInfo, RefreshTokenInfo, SigningKey } from '@maronn-openid-connect/core';
import { createApp, type OidcProviderOptions } from '../oidc-provider/app.js';
import { createClientKeyResolver, createClientResolver } from '../oidc-provider/db/memory/clients.js';
import type { MemoryDatabase } from '../oidc-provider/db/memory/database.js';
import { createProviderStores } from '../oidc-provider/db/memory/stores.js';
import type { ProviderStores } from '../oidc-provider/store.js';
import { TEST_ISSUER } from './context.js';
import { rs256Key, staticKeyProvider } from './keys.js';

/** A PKCE S256 code_challenge (RFC 7636 Appendix B). */
export const TEST_CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

export interface ProviderApp {
  app: ReturnType<typeof createApp>;
  stores: ProviderStores;
  signingKey: SigningKey;
}

/** The provider app of createApp(), on the given in-memory database. */
export async function providerApp(
  db: MemoryDatabase,
  options: Partial<OidcProviderOptions> = {},
): Promise<ProviderApp> {
  const stores = createProviderStores(db);
  const signingKey = await rs256Key();
  const app = createApp({
    signingKeyProvider: staticKeyProvider(signingKey),
    storage: stores,
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    ...options,
    config: { issuer: TEST_ISSUER, ...options.config },
  });
  return { app, stores, signingKey };
}

/** The Authorization header of client_secret_basic (RFC 6749 §2.3.1). */
export function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`;
}

/** The current Unix time in seconds. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** An access token record, valid for an hour unless overridden. */
export function accessTokenInfo(overrides: Partial<AccessTokenInfo> = {}): AccessTokenInfo {
  return {
    sub: 'user-1',
    scope: ['openid'],
    clientId: 'client-1',
    expiresAt: nowSeconds() + 3600,
    ...overrides,
  };
}

/** An unused refresh token record, valid for an hour unless overridden. */
export function refreshTokenInfo(overrides: Partial<RefreshTokenInfo> = {}): RefreshTokenInfo {
  const now = nowSeconds();
  return {
    subject: 'user-1',
    clientId: 'client-1',
    scope: ['openid'],
    expiresAt: now + 3600,
    used: false,
    grantId: 'grant-1',
    originalIssuedAt: now,
    authTime: now,
    ...overrides,
  };
}

/** The decoded JOSE header and payload of a compact JWS. */
export function decodeJwt(jwt: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [header = '', payload = ''] = jwt.split('.');
  return { header: decodeJsonSegment(header), payload: decodeJsonSegment(payload) };
}

/** Whether the RS256 signature of a compact JWS verifies with the public key. */
export async function verifyRs256Jwt(jwt: string, publicJwk: JsonWebKey): Promise<boolean> {
  const [header = '', payload = '', signature = ''] = jwt.split('.');
  const key = await crypto.subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

/** A compact JWS of the payload, signed with RS256 and the key's kid. */
export async function signRs256Jwt(payload: Record<string, unknown>, signingKey: SigningKey): Promise<string> {
  const signingInput = `${base64UrlJson({ alg: 'RS256', kid: signingKey.keyId })}.${base64UrlJson(payload)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** An unsigned JWT (alg none, empty signature: RFC 7515 §6 / RFC 7519 §6). */
export function unsignedJwt(payload: Record<string, unknown>): string {
  return `${base64UrlJson({ alg: 'none' })}.${base64UrlJson(payload)}.`;
}

const es256Keys = new Map<string, Promise<SigningKey>>();

/** An ES256 signing key with the given key id, generated once and reused. */
export function es256Key(keyId = 'test-es256-key'): Promise<SigningKey> {
  let key = es256Keys.get(keyId);
  if (!key) {
    key = generateEs256Key(keyId);
    es256Keys.set(keyId, key);
  }
  return key;
}

async function generateEs256Key(keyId: string): Promise<SigningKey> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey & {
    alg?: string;
    use?: string;
    kid?: string;
  };
  publicJwk.alg = 'ES256';
  publicJwk.use = 'sig';
  publicJwk.kid = keyId;
  return { privateKey: keyPair.privateKey, publicJwk, keyId };
}

function base64UrlJson(value: Record<string, unknown>): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as Record<string, unknown>;
}
