import {
  createAuthTransaction,
  type AuthorizationRequestParams,
  type AuthorizationResponseType,
} from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt } from '../../../../test-support/jwt';
import type { AuthorizationResponseMode } from '../../../authorize/response-mode';
import { createDatabase, registerClient } from '../../db';
import { resolvers, stores } from '../../provider';
import { createFragmentResponseMode } from '../implicit-flow/response-mode';
import { issueHybridResponse, validateHybridRequest } from './authorize';

// provider.ts keeps its clients and stores in the key-value store of db/ (in
// memory for the tests, vitest.config.ts) for the whole file, so every test
// uses a transaction of its own.

const ISSUER = 'https://op.example.com';
const REDIRECT_URI = 'https://rp.example.com/callback';
const CLIENT_ID = 'hybrid-client';
/** RFC 7636 Appendix B: the S256 code_challenge of its example code_verifier. */
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW = 1767225600;

const fragment = createFragmentResponseMode({ issuer: ISSUER });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function paramsWith(responseType: string | undefined, responseMode?: string): AuthorizationRequestParams {
  return {
    client_id: CLIENT_ID,
    ...(responseType === undefined ? {} : { response_type: responseType }),
    ...(responseMode === undefined ? {} : { response_mode: responseMode }),
  } as AuthorizationRequestParams;
}

/** The parts of a validated Hybrid Flow request validateHybridRequest() reads, with the given changes. */
function requestOf(overrides: Partial<Parameters<typeof validateHybridRequest>[0]> = {}) {
  return { responseType: 'code id_token token', nonce: 'nonce-1', redirectUri: REDIRECT_URI, state: 'state-1', ...overrides };
}

describe('validateHybridRequest', () => {
  // OIDC Core 1.0 §3.3.2.1 / §3.3.2.11: a nonce and the default response mode
  // (the fragment) make a valid request; the code flow and the Implicit Flow
  // pass untouched.
  it('should accept a request of the Hybrid Flow with a nonce and leave the other flows alone', () => {
    expect(validateHybridRequest(requestOf(), paramsWith('code id_token token'), fragment)).toBeUndefined();
    expect(
      validateHybridRequest(requestOf({ responseType: 'code', nonce: undefined }), paramsWith('code', 'query'), undefined),
    ).toBeUndefined();
    expect(
      validateHybridRequest(requestOf({ responseType: 'id_token', nonce: undefined }), paramsWith('id_token', 'query'), fragment),
    ).toBeUndefined();
  });

  // OAuth 2.0 Multiple Response Type Encoding Practices §5: the tokens must
  // not travel in the query.
  it('should reject response_mode=query with invalid_request', () => {
    expect(() => validateHybridRequest(requestOf(), paramsWith('code id_token token', 'query'), fragment)).toThrow(
      expect.objectContaining({
        error: 'invalid_request',
        errorDescription: 'response_mode=query must not be used with the Hybrid Flow',
        redirectUri: REDIRECT_URI,
        state: 'state-1',
      }),
    );
  });

  // OAuth 2.0 Multiple Response Type Encoding Practices §2.1: a value the OP
  // does not answer this request in is refused, not replaced.
  it('should reject a response_mode the request is not answered in with invalid_request', () => {
    expect(() =>
      validateHybridRequest(requestOf(), paramsWith('code id_token token', 'query.jwt'), fragment),
    ).toThrow(
      expect.objectContaining({ error: 'invalid_request', errorDescription: 'Unsupported response_mode: query.jwt' }),
    );
  });

  // OIDC Core 1.0 §3.3.2.11: nonce is REQUIRED when the authorization endpoint
  // returns an ID Token, and stays optional for code token.
  it('should reject code id_token without nonce with invalid_request and accept code token without nonce', () => {
    expect(() =>
      validateHybridRequest(requestOf({ responseType: 'code id_token', nonce: undefined }), paramsWith('code id_token'), fragment),
    ).toThrow(expect.objectContaining({ error: 'invalid_request', errorDescription: 'Missing required parameter: nonce' }));
    expect(
      validateHybridRequest(requestOf({ responseType: 'code token', nonce: undefined }), paramsWith('code token'), fragment),
    ).toBeUndefined();
  });
});

describe('issueHybridResponse', () => {
  /** Store a transaction of the response type for the client and answer it for the End-User. */
  async function respond(
    transactionId: string,
    responseType: AuthorizationResponseType,
    responseMode: AuthorizationResponseMode | undefined = fragment,
  ) {
    await registerClient(createDatabase(), {
      clientId: CLIENT_ID,
      redirectUris: [REDIRECT_URI],
      responseTypes: ['code id_token token', 'code id_token', 'code token'],
    });
    const transaction = createAuthTransaction(
      {
        responseType,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        redirectUriExplicit: true,
        scope: ['openid', 'profile'],
        state: 'state-1',
        nonce: 'nonce-1',
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: 'S256',
      },
      'csrf-1',
    );
    await stores.transactionStore.put('auth_txn:' + transactionId, transaction, 600);
    const response = await issueHybridResponse({
      transactionId,
      transaction,
      session: { subject: 'hybrid-user', authTime: NOW - 30, sessionId: 'session-1' },
      responseMode,
    });
    return { response, transaction };
  }

  /** The redirect target and the parameters in the fragment of a 302. */
  function fragmentOf(response: Response | undefined): { target: string; params: Record<string, string> } {
    expect(response?.status).toBe(302);
    const location = new URL(response?.headers.get('Location') ?? '');
    return {
      target: location.origin + location.pathname,
      params: Object.fromEntries(new URLSearchParams(location.hash.slice(1))),
    };
  }

  // OIDC Core 1.0 §3.3.2.5 / RFC 9207 §2: the code, the tokens, the state and
  // iss in the fragment; the transaction is finished.
  it('should redirect with the code, the tokens, the state and iss in the fragment and finish the transaction', async () => {
    const { response } = await respond('hybrid-txn-1', 'code id_token token');

    const { target, params } = fragmentOf(response);
    expect(target).toBe(REDIRECT_URI);
    expect(params).toEqual({
      code: expect.any(String),
      access_token: expect.any(String),
      token_type: 'Bearer',
      expires_in: '3600',
      scope: 'openid profile',
      id_token: expect.any(String),
      state: 'state-1',
      iss: ISSUER,
    });
    expect(decodeJwt(params['id_token'] ?? '').payload).toMatchObject({
      sub: 'hybrid-user',
      aud: CLIENT_ID,
      nonce: 'nonce-1',
      auth_time: NOW - 30,
      c_hash: expect.any(String),
      at_hash: expect.any(String),
    });
    expect(await stores.transactionStore.get('auth_txn:hybrid-txn-1')).toBeNull();
  });

  // The code carries the request to the token endpoint, and shares its grant
  // with the access token (OAuth 2.1 §4.1.2): withdrawing the consent revokes both.
  it('should store the code with the request and record the one grant of the code and the access token', async () => {
    const recordGrant = vi.spyOn(resolvers.consentResolver, 'recordGrant');

    const { response } = await respond('hybrid-txn-2', 'code id_token token');

    const { params } = fragmentOf(response);
    const code = await stores.authCodeStore.get(params['code'] ?? '');
    const accessToken = await stores.accessTokenStore.get(params['access_token'] ?? '');
    expect(code).toMatchObject({
      clientId: CLIENT_ID,
      subject: 'hybrid-user',
      scope: ['openid', 'profile'],
      nonce: 'nonce-1',
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: 'S256',
      sessionId: 'session-1',
      used: false,
    });
    expect(accessToken?.grantId).toBe(code?.grantId);
    expect(recordGrant.mock.calls).toEqual([['hybrid-user', CLIENT_ID, code?.grantId]]);
  });

  // OAuth 2.0 Multiple Response Type Encoding Practices §5: never the
  // query, even when no response mode was set.
  it('should answer in the fragment when no response mode was set', async () => {
    const { response } = await respond('hybrid-txn-3', 'code id_token', undefined);

    expect(Object.keys(fragmentOf(response).params)).toEqual(['code', 'id_token', 'state', 'iss']);
  });

  it('should redirect with the code and the access token without an ID Token for code token', async () => {
    const { response } = await respond('hybrid-txn-4', 'code token');

    expect(Object.keys(fragmentOf(response).params)).toEqual([
      'code',
      'access_token',
      'token_type',
      'expires_in',
      'scope',
      'state',
      'iss',
    ]);
  });

  // The issue-authorization-code block answers the code flow.
  it('should return undefined and keep the transaction of response_type=code', async () => {
    const { response } = await respond('hybrid-txn-5', 'code');

    expect(response).toBeUndefined();
    expect(await stores.transactionStore.get('auth_txn:hybrid-txn-5')).toMatchObject({ responseType: 'code' });
  });
});
