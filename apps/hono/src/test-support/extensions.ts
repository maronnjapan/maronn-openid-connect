/**
 * Helpers for the tests of the features (id-jag, token-exchange,
 * dynamic-client-registration, google-login): JWTs signed with a test key,
 * the parts of a JWT, authorization transactions stored the way /authorize
 * stores them, and the HTML of a view.
 */
import { signJwt, type AuthTransaction, type SigningKey } from '@maronn-openid-connect/core';
import type { ProviderStores } from '../oidc-provider/store.js';
import { renderView, type ViewResult } from '../oidc-provider/views.js';

/** A compact JWS over payload, signed with key (alg RS256, kid of the key, plus header). */
export function signTestJwt(
  key: SigningKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  return signJwt({ alg: 'RS256', kid: key.keyId, ...header }, payload, key.privateKey);
}

/** The JOSE header and the payload of a compact JWS, without verifying it. */
export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [header = '', payload = ''] = token.split('.');
  return { header: decodeSegment(header), payload: decodeSegment(payload) };
}

function decodeSegment(segment: string): Record<string, unknown> {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/** The current time in Unix seconds. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Store an authorization transaction under transactionId, the way /authorize
 * stores it (core's 'auth_txn:' key), open for ten minutes.
 */
export async function storeTransaction(
  stores: ProviderStores,
  transactionId: string,
  overrides: Partial<AuthTransaction> = {},
): Promise<AuthTransaction> {
  const now = Date.now();
  const transaction: AuthTransaction = {
    clientId: 'rp-1',
    redirectUri: 'https://rp.example.com/callback',
    redirectUriExplicit: true,
    responseType: 'code',
    scope: 'openid',
    csrfToken: `csrf-${transactionId}`,
    createdAt: now,
    expiresAt: now + 600_000,
    failedAttempts: 0,
    ...overrides,
  };
  await stores.transactionStore.put(`auth_txn:${transactionId}`, transaction, 600);
  return transaction;
}

/** The HTML a view renders to. */
export function htmlOf(view: ViewResult): Promise<string> {
  return renderView(view).text();
}
