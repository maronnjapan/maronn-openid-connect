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

/** A database with the test client registered for the response types of the Implicit Flow. */
async function providerWithImplicitClient() {
  const db = createEmptyDatabase();
  await registerTestClient(db, { grantTypes: ['implicit'], responseTypes: ['id_token token', 'id_token'] });
  return { db, stores: createProviderStores(db) };
}

/** The parameters of a valid Implicit Flow request (no PKCE: there is no code), with the given changes. */
function implicitParams(overrides: Record<string, string> = {}): Record<string, string> {
  const { code_challenge: _challenge, code_challenge_method: _method, ...params } = authorizationParams({
    response_type: 'id_token token',
    ...overrides,
  });
  return params;
}

/** Assert that the outcome redirects to the client and return the target and the parameters of its fragment. */
function fragmentRedirectOf(outcome: unknown): { target: string; params: Record<string, string> } {
  expect(outcome).toMatchObject({ kind: 'authorization_response', response: { method: 'redirect', location: expect.any(String) } });
  const url = new URL((outcome as { response: { location: string } }).response.location);
  return { target: url.origin + url.pathname + url.search, params: Object.fromEntries(new URLSearchParams(url.hash.slice(1))) };
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

  // OAuth 2.0 Form Post Response Mode §2
  describe('response_mode=form_post', () => {
    it('should post the code, state and iss to the redirect_uri for SSO with prior consent', async () => {
      const { db, stores } = await providerWithClient();
      const cookie = await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      const outcome = await authorize(db, authorizationParams({ response_mode: 'form_post' }), { cookie });

      expect(outcome).toEqual({
        kind: 'authorization_response',
        response: {
          method: 'form_post',
          action: REDIRECT_URI,
          fields: { code: [...db.codes.keys()][0], state: STATE, iss: TEST_ISSUER },
        },
      });
    });

    // RFC 6749 §4.1.2.1: a redirectable error goes back in the same response mode.
    it('should post a validation error to the redirect_uri', async () => {
      const { db } = await providerWithClient();

      const outcome = await authorize(db, authorizationParams({ response_mode: 'form_post', scope: 'profile' }));

      expect(outcome).toEqual({
        kind: 'authorization_response',
        response: {
          method: 'form_post',
          action: REDIRECT_URI,
          fields: {
            error: 'invalid_scope',
            error_description: 'scope must include openid',
            state: STATE,
            iss: TEST_ISSUER,
          },
        },
      });
    });

    // The response mode is recorded so /consent answers in it (restoreResponseMode()).
    it('should record form_post on the transaction it continues on the login screen with', async () => {
      const { db } = await providerWithClient();

      await authorize(db, authorizationParams({ response_mode: 'form_post' }));

      const [transactionId] = transactionIdsOf(db);
      expect(db.transactions.get('auth_txn:' + transactionId)?.value).toMatchObject({ responseMode: 'form_post' });
    });
  });

  // OIDC Core 1.0 §3.2: the ID Token (and the access token) come from the
  // authorization endpoint, in the fragment (OAuth 2.0 Multiple Response Type
  // Encoding Practices §3 / §5).
  describe('Implicit Flow', () => {
    it('should redirect with the tokens, the state and iss in the fragment for SSO with prior consent', async () => {
      const { db, stores } = await providerWithImplicitClient();
      const cookie = await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      const outcome = await authorize(db, implicitParams(), { cookie });

      const { target, params } = fragmentRedirectOf(outcome);
      expect(target).toBe(REDIRECT_URI);
      expect(params).toEqual({
        access_token: [...db.accessTokens.keys()][0],
        token_type: 'Bearer',
        expires_in: '3600',
        scope: 'openid',
        id_token: expect.any(String),
        state: STATE,
        iss: TEST_ISSUER,
      });
      expect(jwtClaimsOf(params['id_token']!)).toMatchObject({ sub: SUBJECT, aud: CLIENT_ID, nonce: NONCE });
      expect(db.codes.size).toBe(0);
      expect(db.transactions.size).toBe(0);
    });

    // OIDC Core 1.0 §3.2.2.6: errors go back in the fragment too.
    it('should redirect login_required in the fragment for prompt=none without a session', async () => {
      const { db } = await providerWithImplicitClient();

      const outcome = await authorize(db, implicitParams({ response_type: 'id_token', prompt: 'none' }));

      expect(fragmentRedirectOf(outcome)).toEqual({
        target: REDIRECT_URI,
        params: {
          error: 'login_required',
          error_description: 'No active session found. Silent authentication failed.',
          state: STATE,
          iss: TEST_ISSUER,
        },
      });
    });

    // The response mode is recorded so /consent answers in it (restoreResponseMode()).
    it('should record the fragment on the transaction it continues on the login screen with', async () => {
      const { db } = await providerWithImplicitClient();

      const outcome = await authorize(db, implicitParams());

      const [transactionId] = transactionIdsOf(db);
      expect(outcome).toEqual({ kind: 'login', cookies: [transactionCookie(transactionId!)] });
      const transaction = db.transactions.get('auth_txn:' + transactionId)?.value;
      expect(transaction).toMatchObject({ responseType: 'id_token token', responseMode: 'fragment', nonce: NONCE });
      expect(transaction).not.toHaveProperty('codeChallenge');
    });

    // OAuth 2.0 Form Post Response Mode §2: the tokens are posted when the request asks for it.
    it('should post the ID Token, the state and iss for response_mode=form_post', async () => {
      const { db, stores } = await providerWithImplicitClient();
      const cookie = await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      const outcome = await authorize(db, implicitParams({ response_type: 'id_token', response_mode: 'form_post' }), { cookie });

      expect(outcome).toEqual({
        kind: 'authorization_response',
        response: {
          method: 'form_post',
          action: REDIRECT_URI,
          fields: { id_token: expect.any(String), state: STATE, iss: TEST_ISSUER },
        },
      });
    });

    // OIDC Core 1.0 §3.2.2.1: nonce is REQUIRED.
    it('should redirect invalid_request in the fragment for a request without nonce and store no transaction', async () => {
      const { db } = await providerWithImplicitClient();
      const { nonce: _nonce, ...params } = implicitParams();

      expect(fragmentRedirectOf(await authorize(db, params)).params).toEqual({
        error: 'invalid_request',
        error_description: 'Missing required parameter: nonce',
        state: STATE,
        iss: TEST_ISSUER,
      });
      expect(db.transactions.size).toBe(0);
    });

    // OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5: never the query.
    it('should redirect invalid_request in the fragment for response_mode=query', async () => {
      const { db } = await providerWithImplicitClient();

      const outcome = await authorize(db, implicitParams({ response_mode: 'query' }));

      expect(fragmentRedirectOf(outcome).params).toEqual({
        error: 'invalid_request',
        error_description: 'response_mode=query must not be used with the Implicit Flow',
        state: STATE,
        iss: TEST_ISSUER,
      });
    });

    // JARM §2.3.1: query.jwt would carry the tokens in the query.
    it('should redirect invalid_request in the fragment for response_mode=query.jwt', async () => {
      const { db } = await providerWithImplicitClient();

      const outcome = await authorize(db, implicitParams({ response_mode: 'query.jwt' }));

      expect(fragmentRedirectOf(outcome).params).toEqual({
        error: 'invalid_request',
        error_description: 'Unsupported response_mode: query.jwt',
        state: STATE,
        iss: TEST_ISSUER,
      });
    });

    // RFC 6749 §4.2.2.1: a client must be registered for the response type.
    it('should redirect unauthorized_client in the fragment for a client registered only for code', async () => {
      const { db } = await providerWithClient();

      const outcome = await authorize(db, implicitParams({ response_type: 'id_token' }));

      expect(fragmentRedirectOf(outcome).params).toEqual({
        error: 'unauthorized_client',
        error_description: 'Client is not authorized to use response_type: id_token',
        state: STATE,
        iss: TEST_ISSUER,
      });
    });

    // OIDC Core 1.0 §3.2.2.1 names id_token and id_token token, not token alone.
    it('should redirect unsupported_response_type in the fragment for response_type=token', async () => {
      const { db } = await providerWithImplicitClient();

      const outcome = await authorize(db, implicitParams({ response_type: 'token' }));

      expect(fragmentRedirectOf(outcome).params).toEqual({
        error: 'unsupported_response_type',
        error_description: 'Unsupported response_type: token',
        state: STATE,
        iss: TEST_ISSUER,
      });
    });
  });

  // OAuth 2.0 Multiple Response Type Encoding Practices §2.1
  describe('response_mode=fragment', () => {
    it('should redirect the code, the state and iss in the fragment when the request asks for it', async () => {
      const { db, stores } = await providerWithClient();
      const cookie = await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      const outcome = await authorize(db, authorizationParams({ response_mode: 'fragment' }), { cookie });

      expect(fragmentRedirectOf(outcome)).toEqual({
        target: REDIRECT_URI,
        params: { code: [...db.codes.keys()][0], state: STATE, iss: TEST_ISSUER },
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
