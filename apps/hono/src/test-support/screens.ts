/**
 * Helpers for the tests of the login and consent screens and of the app:
 * an authorization transaction stored the way /authorize stores it, the
 * transaction cookie that names it, the provider app on an in-memory
 * database, an ES256 key and a JWT decoder.
 */
import type { AuthTransaction, SigningKey } from '@maronn-openid-connect/core';
import { createApp, type OidcProviderOptions } from '../oidc-provider/app.js';
import { TRANSACTION_COOKIE_NAME } from '../oidc-provider/cookies.js';
import { createClientKeyResolver, createClientResolver } from '../oidc-provider/db/memory/clients.js';
import type { MemoryDatabase } from '../oidc-provider/db/memory/database.js';
import { createProviderStores } from '../oidc-provider/db/memory/stores.js';
import { TEST_ISSUER } from './context.js';
import { rs256Key, staticKeyProvider } from './keys.js';

/** The id of the transaction storeTransaction() stores by default. */
export const TRANSACTION_ID = 'txn-1';

/** The csrf_token of sampleTransaction(). */
export const CSRF_TOKEN = 'csrf-token-1';

/** The redirect_uri of sampleTransaction(). */
export const REDIRECT_URI = 'https://rp.example.com/callback';

/** An authorization transaction as /authorize creates it, valid for ten more minutes. */
export function sampleTransaction(overrides: Partial<AuthTransaction> = {}): AuthTransaction {
  const now = Date.now();
  return {
    clientId: 'client-1',
    redirectUri: REDIRECT_URI,
    redirectUriExplicit: true,
    responseType: 'code',
    scope: 'openid profile',
    state: 'state-1',
    csrfToken: CSRF_TOKEN,
    createdAt: now,
    expiresAt: now + 600_000,
    failedAttempts: 0,
    ...overrides,
  };
}

/**
 * Store a transaction under the key /authorize uses ('auth_txn:' + id) and
 * return it.
 */
export async function storeTransaction(
  db: MemoryDatabase,
  transaction: AuthTransaction = sampleTransaction(),
  transactionId: string = TRANSACTION_ID,
  ttlSeconds = 600,
): Promise<AuthTransaction> {
  await createProviderStores(db).transactionStore.put('auth_txn:' + transactionId, transaction, ttlSeconds);
  return transaction;
}

/** The Cookie header value that names the transaction (the cookie /authorize sets). */
export function transactionCookie(transactionId: string = TRANSACTION_ID): string {
  return `${TRANSACTION_COOKIE_NAME}=${transactionId}`;
}

/** createApp() on the in-memory database db, with the test signing key and issuer. */
export async function providerApp(db: MemoryDatabase, options: Partial<OidcProviderOptions> = {}) {
  const signingKey = await rs256Key();
  return createApp({
    signingKeyProvider: staticKeyProvider(signingKey),
    storage: createProviderStores(db),
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    ...options,
    config: { issuer: TEST_ISSUER, ...options.config },
  });
}

const es256Keys = new Map<string, Promise<SigningKey>>();

/** An ES256 signing key with the given key id, generated once per id. */
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

/** The header and payload of a compact JWS, without verifying it. */
export function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [header = '', payload = ''] = jwt.split('.');
  return { header: decodeSegment(header), payload: decodeSegment(payload) };
}

/** Whether the RS256 signature of a compact JWS verifies with the public half of key. */
export async function verifiesWithRs256(jwt: string, key: SigningKey): Promise<boolean> {
  const [header = '', payload = '', signature = ''] = jwt.split('.');
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    key.publicJwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    base64UrlToBytes(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
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
