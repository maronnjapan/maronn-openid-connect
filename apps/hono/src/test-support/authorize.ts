/**
 * Fixtures for the tests of the authorization endpoint (endpoints/authorize/):
 * a registered client, a valid authorization request, a validated request and
 * the transaction made from it, a signed-in browser, an id_token_hint, and a
 * response mode that records what it was asked to carry.
 */
import {
  createAuthTransaction,
  generateIdToken,
  type AuthTransaction,
  type IdTokenPayload,
  type SigningKey,
  type ValidatedAuthorizationRequest,
} from '@maronn-openid-connect/core';
import { expect, vi } from 'vitest';
import type { ClientRegistration } from '../oidc-provider/config.js';
import { registerClient } from '../oidc-provider/db/memory/clients.js';
import type { MemoryDatabase } from '../oidc-provider/db/memory/database.js';
import type {
  AuthorizationResponse,
  AuthorizationResponseMode,
  AuthorizationResponseParameters,
} from '../oidc-provider/endpoints/authorize/response-mode.js';
import type { ProviderStores } from '../oidc-provider/store.js';
import { TEST_ISSUER } from './context.js';

export const CLIENT_ID = 'client-1';
export const REDIRECT_URI = 'https://rp.example.com/callback';
export const STATE = 'state-1';
export const NONCE = 'nonce-1';
export const TRANSACTION_ID = 'txn-1';
export const SESSION_ID = 'session-1';
export const SUBJECT = 'alice';

/** RFC 7636 Appendix B: the S256 code_challenge of its example code_verifier. */
export const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/** Register the test client (a confidential client with one redirect_uri) with the given changes. */
export function registerTestClient(
  db: MemoryDatabase,
  overrides: Partial<ClientRegistration> = {},
): Promise<void> {
  return registerClient(db, {
    clientId: CLIENT_ID,
    clientType: 'confidential',
    redirectUris: [REDIRECT_URI],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethods: ['client_secret_basic'],
    ...overrides,
  });
}

/** The parameters of a valid authorization request of the test client, with the given changes. */
export function authorizationParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state: STATE,
    nonce: NONCE,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    ...overrides,
  };
}

/** The /authorize path with the given query parameters. */
export function authorizePath(params: Record<string, string>): string {
  return '/authorize?' + new URLSearchParams(params).toString();
}

/** A validated authorization request of the test client, with the given changes. */
export function validatedRequestOf(
  overrides: Partial<ValidatedAuthorizationRequest> = {},
): ValidatedAuthorizationRequest {
  return {
    responseType: 'code',
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    redirectUriExplicit: true,
    scope: ['openid'],
    codeChallenge: CODE_CHALLENGE,
    codeChallengeMethod: 'S256',
    state: STATE,
    nonce: NONCE,
    ...overrides,
  };
}

/** The transaction made from validatedRequestOf(), with the given changes. */
export function transactionOf(overrides: Partial<AuthTransaction> = {}): AuthTransaction {
  return { ...createAuthTransaction(validatedRequestOf(), 'csrf-1'), ...overrides };
}

/** Put the transaction into the store under the id the endpoints use for it. */
export async function storeTransaction(
  stores: ProviderStores,
  transaction: AuthTransaction,
  transactionId = TRANSACTION_ID,
): Promise<void> {
  await stores.transactionStore.put('auth_txn:' + transactionId, transaction, 600);
}

/** The Unix time (seconds) this many seconds ago. */
export function secondsAgo(seconds: number): number {
  return Math.floor(Date.now() / 1000) - seconds;
}

/**
 * Open a browser session for the subject and return the Cookie header that
 * carries it.
 */
export async function signIn(
  stores: ProviderStores,
  session: { subject?: string; authTime?: number; sessionId?: string } = {},
): Promise<string> {
  const sessionId = session.sessionId ?? SESSION_ID;
  await stores.browserSessionStore.set(sessionId, {
    subject: session.subject ?? SUBJECT,
    authTime: session.authTime ?? secondsAgo(10),
  });
  return 'session_id=' + sessionId;
}

/** An ID Token the provider signed with signingKey, for use as id_token_hint. */
export function idTokenHintFor(signingKey: SigningKey, overrides: Partial<IdTokenPayload> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return generateIdToken({
    payload: { iss: TEST_ISSUER, sub: SUBJECT, aud: CLIENT_ID, iat: now, exp: now + 300, ...overrides },
    privateKey: signingKey.privateKey,
    keyId: signingKey.keyId,
  });
}

/** The redirect target (origin and path) of a URL, and its query parameters. */
export function redirectOf(location: string): { target: string; params: Record<string, string> } {
  const url = new URL(location);
  return { target: url.origin + url.pathname, params: Object.fromEntries(url.searchParams) };
}

/**
 * Assert that the outcome is an authorization response for the client and
 * return its redirect target and query parameters.
 */
export function authorizationRedirectOf(outcome: unknown): { target: string; params: Record<string, string> } {
  expect(outcome).toMatchObject({ kind: 'authorization_response', response: { method: 'redirect', location: expect.any(String) } });
  return redirectOf((outcome as { response: { location: string } }).response.location);
}

/** Assert that the authorization response is a redirect and return its location. */
export function locationOf(response: AuthorizationResponse): string {
  expect(response).toMatchObject({ method: 'redirect', location: expect.any(String) });
  return (response as { location: string }).location;
}

/** The redirect a response mode answered with, as the location the outcome would carry. */
export const RECORDED_RESPONSE = {
  method: 'redirect',
  location: 'https://rp.example.com/callback?response=recorded',
} as const;

/** The claims of a JWT, unverified. */
export function jwtClaimsOf(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1] ?? '';
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
}

/** A response mode that answers with a fixed redirect and records the parameters it was asked to carry. */
export function recordingResponseMode(name = 'test.mode') {
  const respond = vi.fn(
    async (_redirectUri: string, _parameters: AuthorizationResponseParameters): Promise<AuthorizationResponse> =>
      RECORDED_RESPONSE,
  );
  const responseMode: AuthorizationResponseMode = { name, respond };
  return { responseMode, respond };
}
