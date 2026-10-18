import { describe, expect, it } from 'vitest';
import {
  authorizationParams,
  authorizationRedirectOf,
  authorizePath,
  CLIENT_ID,
  CODE_CHALLENGE,
  idTokenHintFor,
  jwtClaimsOf,
  NONCE,
  REDIRECT_URI,
  registerTestClient,
  signIn,
  STATE,
  SUBJECT,
} from '../../../test-support/authorize.js';
import { providerContext, requestTo, TEST_ISSUER } from '../../../test-support/context.js';
import { rs256Key } from '../../../test-support/keys.js';
import type { OidcProviderOptions } from '../../app.js';
import { createEmptyDatabase, type MemoryDatabase } from '../../db/memory/database.js';
import { createProviderStores } from '../../db/memory/stores.js';
import { processAuthorizationRequest } from './pipeline.js';

/** A database with the test client registered, and stores on it to set up sessions and consent. */
async function providerWithClient() {
  const db = createEmptyDatabase();
  await registerTestClient(db);
  return { db, stores: createProviderStores(db) };
}

/** Run the authorization request through the pipeline as the provider does for GET /authorize. */
async function authorize(
  db: MemoryDatabase,
  params: Record<string, string>,
  input: { cookie?: string; options?: Partial<OidcProviderOptions> } = {},
) {
  const headers: Record<string, string> = input.cookie === undefined ? {} : { Cookie: input.cookie };
  const { c } = await providerContext({ db, request: requestTo(authorizePath(params), { headers }), options: input.options });
  return processAuthorizationRequest(c);
}

/** The ids of the stored transactions. */
function transactionIdsOf(db: MemoryDatabase): string[] {
  return [...db.transactions.keys()].map((key) => key.slice('auth_txn:'.length));
}

function transactionCookie(transactionId: string): string {
  return `__Host-oidc_txn=${transactionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
}

describe('processAuthorizationRequest', () => {
  describe('Interactive authentication', () => {
    // OIDC Core 1.0 §3.1.2.3: without a session the End-User authenticates on the login screen.
    it('should store the transaction and continue on the login screen with its cookie when no session is active', async () => {
      const { db } = await providerWithClient();

      const outcome = await authorize(db, authorizationParams());

      const [transactionId] = transactionIdsOf(db);
      expect(outcome).toEqual({ kind: 'login', cookies: [transactionCookie(transactionId!)] });
      expect(db.transactions.get('auth_txn:' + transactionId)?.value).toMatchObject({
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        redirectUriExplicit: true,
        responseType: 'code',
        scope: 'openid',
        state: STATE,
        nonce: NONCE,
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: 'S256',
      });
    });

    // OIDC Core 1.0 §3.1.2.1: a hint for another End-User does not reuse the session.
    it('should continue on the login screen when id_token_hint names another End-User than the session', async () => {
      const { db, stores } = await providerWithClient();
      const cookie = await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);
      const hint = await idTokenHintFor(await rs256Key(), { sub: 'bob' });

      const outcome = await authorize(db, authorizationParams({ id_token_hint: hint }), { cookie });

      expect(outcome).toEqual({ kind: 'login', cookies: [transactionCookie(transactionIdsOf(db)[0]!)] });
      expect(db.codes.size).toBe(0);
    });
  });

  // OIDC Core 1.0 §3.1.2.3: an active session is reused instead of the login screen.
  describe('Single Sign-On', () => {
    it('should issue a code when the End-User already consented to the requested scopes', async () => {
      const { db, stores } = await providerWithClient();
      const cookie = await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      const outcome = await authorize(db, authorizationParams(), { cookie });

      expect(authorizationRedirectOf(outcome)).toEqual({
        target: REDIRECT_URI,
        params: { code: [...db.codes.keys()][0], state: STATE, iss: TEST_ISSUER },
      });
      expect(db.transactions.size).toBe(0);
    });

    it('should continue on the consent screen with the transaction cookie when consent is missing', async () => {
      const { db, stores } = await providerWithClient();
      const cookie = await signIn(stores);

      const outcome = await authorize(db, authorizationParams(), { cookie });

      const [transactionId] = transactionIdsOf(db);
      expect(outcome).toEqual({ kind: 'consent', cookies: [transactionCookie(transactionId!)] });
      expect(db.authSessions.get(transactionId!)).toMatchObject({ subject: SUBJECT });
    });
  });

  // OIDC Core 1.0 §3.1.2.1
  describe('prompt=none', () => {
    it('should issue a code without interaction for an active session with prior consent', async () => {
      const { db, stores } = await providerWithClient();
      const cookie = await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      const outcome = await authorize(db, authorizationParams({ prompt: 'none' }), { cookie });

      expect(authorizationRedirectOf(outcome)).toEqual({
        target: REDIRECT_URI,
        params: { code: [...db.codes.keys()][0], state: STATE, iss: TEST_ISSUER },
      });
    });

    it('should redirect login_required and keep no transaction when no session is active', async () => {
      const { db } = await providerWithClient();

      const outcome = await authorize(db, authorizationParams({ prompt: 'none' }));

      expect(authorizationRedirectOf(outcome)).toEqual({
        target: REDIRECT_URI,
        params: {
          error: 'login_required',
          error_description: 'No active session found. Silent authentication failed.',
          state: STATE,
          iss: TEST_ISSUER,
        },
      });
      expect(db.transactions.size).toBe(0);
    });

    // JARM §2.3.1 / §2.1: with response_mode=query.jwt the error members travel in the response JWT.
    it('should answer in the JARM response JWT when the request asks for response_mode=query.jwt', async () => {
      const { db } = await providerWithClient();

      const outcome = await authorize(db, authorizationParams({ prompt: 'none', response_mode: 'query.jwt' }));

      const { target, params } = authorizationRedirectOf(outcome);
      expect(target).toBe(REDIRECT_URI);
      expect(Object.keys(params)).toEqual(['response']);
      expect(jwtClaimsOf(params['response']!)).toMatchObject({
        error: 'login_required',
        error_description: 'No active session found. Silent authentication failed.',
        state: STATE,
        iss: TEST_ISSUER,
        aud: CLIENT_ID,
      });
    });
  });

  describe('Errors', () => {
    it('should answer bad_request for a request without client_id', async () => {
      const { db } = await providerWithClient();
      const params = authorizationParams();
      delete params['client_id'];

      expect(await authorize(db, params)).toEqual({
        kind: 'bad_request',
        error: 'invalid_request',
        errorDescription: 'Missing required parameter: client_id',
      });
    });

    // OIDC Core 1.0 §3.1.2.2: without a trusted redirect_uri the error stays on the OP.
    it('should keep an unknown client_id on the OP', async () => {
      const { db } = await providerWithClient();

      expect(await authorize(db, authorizationParams({ client_id: 'unknown-client' }))).toEqual({
        kind: 'error',
        error: 'invalid_request',
        errorDescription: 'Unknown client_id',
      });
    });

    // OIDC Core 1.0 §3.1.2.2 / RFC 6749 §4.1.2.1: never redirect to an unregistered URI.
    it('should keep an unregistered redirect_uri on the OP instead of redirecting to it', async () => {
      const { db } = await providerWithClient();

      expect(await authorize(db, authorizationParams({ redirect_uri: 'https://attacker.example.com/callback' }))).toEqual({
        kind: 'error',
        error: 'invalid_request',
        errorDescription: 'redirect_uri not registered',
      });
    });

    // RFC 6749 §4.1.2.1 / RFC 9207 §2: once redirect_uri is verified, errors go back to the client.
    it('should redirect a validation error to the client with state and iss and store no transaction', async () => {
      const { db } = await providerWithClient();
      const params = authorizationParams();
      delete params['code_challenge'];
      delete params['code_challenge_method'];

      const outcome = await authorize(db, params);

      expect(authorizationRedirectOf(outcome)).toEqual({
        target: REDIRECT_URI,
        params: {
          error: 'invalid_request',
          error_description: 'Missing required parameter: code_challenge',
          state: STATE,
          iss: TEST_ISSUER,
        },
      });
      expect(db.transactions.size).toBe(0);
    });

    it('should answer server_error when a step fails with an unexpected error', async () => {
      const { db } = await providerWithClient();
      const clientResolver = {
        async findClient(): Promise<null> {
          throw new Error('client database is unavailable');
        },
      };

      expect(await authorize(db, authorizationParams(), { options: { clientResolver } })).toEqual({ kind: 'server_error' });
    });
  });
});
