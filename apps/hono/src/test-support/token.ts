/**
 * Records and helpers for the tests of the token endpoint and of the
 * refresh-token feature: an authorization code and a refresh token as the
 * stores keep them, the validated requests the grant steps produce, a client
 * registration, and JWT decoding.
 *
 * The times are fixed: a test that fakes Date sets the clock to NOW, so a
 * record built here is neither expired nor issued in the future.
 */
import type {
  AuthorizationCodeData,
  RefreshTokenInfo,
  SigningKey,
  ValidatedAuthorizationCodeRequest,
  ValidatedRefreshTokenRequest,
} from '@maronn-openid-connect/core';
import type { ClientRegistration } from '../oidc-provider/config.js';
import { TEST_ISSUER } from './context.js';

/** 2026-01-01T00:00:00Z in Unix seconds: the clock of the tests that fake Date. */
export const NOW = 1767225600;

export const CLIENT_ID = 'client-1';
export const CLIENT_SECRET = 'client-1-secret-value';
export const REDIRECT_URI = 'https://rp.example.com/callback';
export const SUBJECT = 'user-1';
/** When user-1 authenticated: ten minutes before NOW. */
export const AUTH_TIME = NOW - 600;

/** A confidential client registered for the authorization_code and refresh_token grants. */
export function confidentialClient(overrides: Partial<ClientRegistration> = {}): ClientRegistration {
  return {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethods: ['client_secret_basic'],
    ...overrides,
  };
}

/** An authorization code issued to client-1 for user-1, as the consent step stores it. */
export function storedAuthorizationCode(overrides: Partial<AuthorizationCodeData> = {}): AuthorizationCodeData {
  return {
    code: 'code-1',
    grantId: 'grant-1',
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    redirectUriExplicit: true,
    scope: ['openid', 'profile'],
    subject: SUBJECT,
    used: false,
    expiresAt: NOW + 300,
    authTime: AUTH_TIME,
    nonce: 'nonce-1',
    sessionId: 'session-1',
    ...overrides,
  };
}

/** A refresh token issued to client-1 for user-1, as the issue-refresh-token step stores it. */
export function storedRefreshToken(overrides: Partial<RefreshTokenInfo> = {}): RefreshTokenInfo {
  return {
    subject: SUBJECT,
    clientId: CLIENT_ID,
    scope: ['openid', 'profile', 'offline_access'],
    expiresAt: NOW + 86400,
    originalIssuedAt: NOW - 3600,
    used: false,
    grantId: 'grant-1',
    iat: NOW - 3600,
    issuer: TEST_ISSUER,
    audience: [`${TEST_ISSUER}/userinfo`],
    authTime: AUTH_TIME,
    ...overrides,
  };
}

/** What validateAuthorizationCodeGrant() returns for the code of storedAuthorizationCode(). */
export function authorizationCodeRequest(
  overrides: Partial<ValidatedAuthorizationCodeRequest> = {},
): ValidatedAuthorizationCodeRequest {
  return {
    grantType: 'authorization_code',
    clientId: CLIENT_ID,
    code: 'code-1',
    grantId: 'grant-1',
    redirectUri: REDIRECT_URI,
    scope: ['openid', 'profile'],
    nonce: 'nonce-1',
    sessionId: 'session-1',
    codeVerified: false,
    ...overrides,
  };
}

/** What validateRefreshTokenGrant() returns for the token of storedRefreshToken(). */
export function refreshTokenRequest(
  overrides: Partial<ValidatedRefreshTokenRequest> = {},
): ValidatedRefreshTokenRequest {
  return {
    grantType: 'refresh_token',
    clientId: CLIENT_ID,
    subject: SUBJECT,
    scope: ['openid', 'profile', 'offline_access'],
    grantId: 'grant-1',
    audience: [`${TEST_ISSUER}/userinfo`],
    authTime: AUTH_TIME,
    originalIssuedAt: NOW - 3600,
    hadOfflineAccess: true,
    ...overrides,
  };
}

/** The Authorization header of client_secret_basic (RFC 6749 §2.3.1). */
export function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`;
}

/** The JOSE header and the claims of a JWS compact serialization, unverified. */
export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [header = '', payload = ''] = token.split('.');
  return { header: decodeSegment(header), payload: decodeSegment(payload) };
}

/** Whether the RS256 or ES256 signature of a JWS verifies with the public key of the signing key. */
export async function verifiesWith(token: string, key: SigningKey): Promise<boolean> {
  const [header = '', payload = '', signature = ''] = token.split('.');
  const isEc = key.publicJwk.kty === 'EC';
  const algorithm = isEc
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const publicKey = await crypto.subtle.importKey('jwk', key.publicJwk, algorithm, false, ['verify']);
  return crypto.subtle.verify(
    isEc ? { name: 'ECDSA', hash: 'SHA-256' } : algorithm,
    publicKey,
    base64UrlToBytes(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

/** The left half of the SHA-256 hash of the value, base64url-encoded: at_hash for RS256 / ES256. */
export async function leftHalfSha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return bytesToBase64Url(digest.slice(0, digest.length / 2));
}

const ecKeys = new Map<string, Promise<SigningKey>>();

/** An ES256 signing key with the given key id, generated once per key id. */
export function es256Key(keyId = 'test-es256-key'): Promise<SigningKey> {
  let key = ecKeys.get(keyId);
  if (!key) {
    key = generateEs256Key(keyId);
    ecKeys.set(keyId, key);
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

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as Record<string, unknown>;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
