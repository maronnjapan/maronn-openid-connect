import {
  createAuthTransaction,
  type AuthorizationRequestParams,
  type AuthorizationResponseType,
  type ClientInfo,
} from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt } from '../../../../test-support/jwt';
import type { AuthorizationResponseMode } from '../../../authorize/response-mode';
import { createDatabase, registerClient } from '../../db';
import { resolvers, stores } from '../../provider';
import { issueImplicitResponse, resolveFragmentResponseContext, validateImplicitRequest } from './authorize';
import { createFragmentResponseMode } from './response-mode';

// provider.ts keeps its clients and stores in the key-value store of db/ (in
// memory for the tests, vitest.config.ts) for the whole file, so every test
// uses a transaction of its own.

const ISSUER = 'https://op.example.com';
const REDIRECT_URI = 'https://rp.example.com/callback';
const LOOPBACK_REDIRECT_URI = 'http://127.0.0.1:8080/callback';
const CLIENT_ID = 'implicit-client';
/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW = 1767225600;

const client: ClientInfo = {
  clientId: CLIENT_ID,
  clientType: 'confidential',
  redirectUris: [REDIRECT_URI],
  responseTypes: ['id_token token', 'id_token'],
};

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

/** The parts of a validated Implicit Flow request validateImplicitRequest() reads, with the given changes. */
function requestOf(overrides: Partial<Parameters<typeof validateImplicitRequest>[0]> = {}) {
  return { responseType: 'id_token token', nonce: 'nonce-1', redirectUri: REDIRECT_URI, state: 'state-1', ...overrides };
}

describe('resolveFragmentResponseContext', () => {
  // OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5: the default
  // of a response type that returns an ID Token or an access token.
  it('should answer response_type=id_token in the fragment, adding the iss of the issuer', async () => {
    const mode = resolveFragmentResponseContext(paramsWith('id_token'), ISSUER);

    expect(mode?.name).toBe('fragment');
    expect(await mode?.respond(REDIRECT_URI, { id_token: 'id-token-1' })).toEqual({
      method: 'redirect',
      location: 'https://rp.example.com/callback#id_token=id-token-1&iss=https%3A%2F%2Fop.example.com',
    });
  });

  // The order of the values does not matter (§5), and an unsupported value
  // such as token alone gets its error in the fragment too (§2.1).
  it('should answer every response type that returns a token in the fragment', () => {
    const names = ['id_token token', 'token id_token', 'token', 'code id_token'].map(
      (responseType) => resolveFragmentResponseContext(paramsWith(responseType), ISSUER)?.name,
    );

    expect(names).toEqual(['fragment', 'fragment', 'fragment', 'fragment']);
  });

  // OAuth 2.0 Multiple Response Type Encoding Practices §2.1: a code can be
  // asked for in the fragment; its default is the query.
  it('should answer response_type=code in the fragment only when the request asks for it', () => {
    expect(resolveFragmentResponseContext(paramsWith('code', 'fragment'), ISSUER)?.name).toBe('fragment');
    expect(resolveFragmentResponseContext(paramsWith('code'), ISSUER)).toBeUndefined();
    expect(resolveFragmentResponseContext(paramsWith('code', 'FRAGMENT'), ISSUER)).toBeUndefined();
    expect(resolveFragmentResponseContext(paramsWith(undefined), ISSUER)).toBeUndefined();
  });
});

describe('validateImplicitRequest', () => {
  // OIDC Core 1.0 §3.2.2.1: nonce, an https redirect_uri and the default
  // response mode (the fragment) make a valid request; the code flow needs
  // none of it.
  it('should accept a request of the Implicit Flow with a nonce and leave the code flow alone', () => {
    expect(validateImplicitRequest(requestOf(), paramsWith('id_token token'), client, fragment)).toBeUndefined();
    expect(
      validateImplicitRequest(
        requestOf({ responseType: 'code', nonce: undefined, redirectUri: 'http://rp.example.com/callback' }),
        paramsWith('code', 'query'),
        client,
        undefined,
      ),
    ).toBeUndefined();
  });

  // OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5: the tokens
  // must not travel in the query.
  it('should reject response_mode=query with invalid_request', () => {
    expect(() => validateImplicitRequest(requestOf(), paramsWith('id_token token', 'query'), client, fragment)).toThrow(
      expect.objectContaining({
        error: 'invalid_request',
        errorDescription: 'response_mode=query must not be used with the Implicit Flow',
        redirectUri: REDIRECT_URI,
        state: 'state-1',
      }),
    );
  });

  // OAuth 2.0 Multiple Response Type Encoding Practices §2.1: a value the OP
  // does not answer this request in is refused, not replaced.
  it('should reject a response_mode the request is not answered in with invalid_request', () => {
    expect(() =>
      validateImplicitRequest(requestOf(), paramsWith('id_token token', 'query.jwt'), client, fragment),
    ).toThrow(
      expect.objectContaining({ error: 'invalid_request', errorDescription: 'Unsupported response_mode: query.jwt' }),
    );
  });

  // OIDC Core 1.0 §3.2.2.1: nonce is REQUIRED in the Implicit Flow.
  it('should reject a request without nonce with invalid_request', () => {
    expect(() =>
      validateImplicitRequest(requestOf({ nonce: undefined }), paramsWith('id_token'), client, fragment),
    ).toThrow(expect.objectContaining({ error: 'invalid_request', errorDescription: 'Missing required parameter: nonce' }));
  });

  // OIDC Core 1.0 §3.2.2.1: http only for a native client on a loopback host.
  it('should reject an http redirect_uri of a confidential client and accept it on a loopback host of a public client', () => {
    const request = requestOf({ redirectUri: LOOPBACK_REDIRECT_URI });

    expect(() => validateImplicitRequest(request, paramsWith('id_token'), client, fragment)).toThrow(
      expect.objectContaining({
        error: 'invalid_request',
        errorDescription:
          'redirect_uri of the Implicit Flow must use https, or http on a loopback host for a public client',
        redirectUri: LOOPBACK_REDIRECT_URI,
      }),
    );
    expect(
      validateImplicitRequest(request, paramsWith('id_token'), { ...client, clientType: 'public' }, fragment),
    ).toBeUndefined();
  });
});

describe('issueImplicitResponse', () => {
  /** Store a transaction of the response type for the client and answer it for the End-User. */
  async function respond(
    transactionId: string,
    responseType: AuthorizationResponseType,
    responseMode: AuthorizationResponseMode | undefined = fragment,
  ) {
    await registerClient(createDatabase(), {
      clientId: CLIENT_ID,
      redirectUris: [REDIRECT_URI],
      responseTypes: ['id_token token', 'id_token'],
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
      },
      'csrf-1',
    );
    await stores.transactionStore.put('auth_txn:' + transactionId, transaction, 600);
    const response = await issueImplicitResponse({
      transactionId,
      transaction,
      session: { subject: 'implicit-user', authTime: NOW - 30, sessionId: 'session-1' },
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

  // OIDC Core 1.0 §3.2.2.5 / RFC 9207 §2: the tokens, the state and iss in
  // the fragment; the transaction is finished.
  it('should redirect with the tokens, the state and iss in the fragment and finish the transaction', async () => {
    const { response } = await respond('implicit-txn-1', 'id_token token');

    const { target, params } = fragmentOf(response);
    expect(target).toBe(REDIRECT_URI);
    expect(params).toEqual({
      access_token: expect.any(String),
      token_type: 'Bearer',
      expires_in: '3600',
      scope: 'openid profile',
      id_token: expect.any(String),
      state: 'state-1',
      iss: ISSUER,
    });
    expect(decodeJwt(params['id_token'] ?? '').payload).toMatchObject({
      sub: 'implicit-user',
      aud: CLIENT_ID,
      nonce: 'nonce-1',
      auth_time: NOW - 30,
    });
    expect(await stores.transactionStore.get('auth_txn:implicit-txn-1')).toBeNull();
  });

  // Withdrawing the consent revokes the access token of the grant.
  it('should record the grant of the tokens under the consent of the End-User to the client', async () => {
    const recordGrant = vi.spyOn(resolvers.consentResolver, 'recordGrant');

    const { response } = await respond('implicit-txn-2', 'id_token token');

    const accessToken = fragmentOf(response).params['access_token'] ?? '';
    const record = await stores.accessTokenStore.get(accessToken);
    expect(recordGrant.mock.calls).toEqual([['implicit-user', CLIENT_ID, record?.grantId]]);
  });

  // OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5: never the
  // query, even when no response mode was set.
  it('should answer in the fragment when no response mode was set', async () => {
    const { response } = await respond('implicit-txn-3', 'id_token', undefined);

    expect(Object.keys(fragmentOf(response).params)).toEqual(['id_token', 'state', 'iss']);
  });

  // The issue-authorization-code block answers the code flow.
  it('should return undefined and keep the transaction of response_type=code', async () => {
    const { response } = await respond('implicit-txn-4', 'code');

    expect(response).toBeUndefined();
    expect(await stores.transactionStore.get('auth_txn:implicit-txn-4')).toMatchObject({ responseType: 'code' });
  });
});
