import { createAuthTransaction, type AuthorizationResponseType } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt } from '../../../../test-support/jwt';
import type { AuthorizationResponse, AuthorizationResponseMode } from '../../../authorize/response-mode';
import type { RegisteredClient } from '../../config';
import { buildClearedTransactionCookie } from '../../cookies';
import { createDatabase, registerClient } from '../../db';
import { clientResolver, resolvers, stores } from '../../provider';
import { issueImplicitConsentResponse } from './consent';
import { createFragmentResponseMode } from './response-mode';

// provider.ts keeps its clients and stores in the key-value store of db/ (in
// memory for the tests, vitest.config.ts) for the whole file, so every test
// uses a transaction and an End-User of its own.

const ISSUER = 'https://op.example.com';
const REDIRECT_URI = 'https://rp.example.com/callback';
const CLIENT_ID = 'implicit-consent-client';
/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW = 1767225600;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Store a transaction of the response type, sign the End-User in for it and approve it. */
async function approve(
  input: {
    transactionId: string;
    subject: string;
    responseType: AuthorizationResponseType;
    responseMode?: AuthorizationResponseMode;
  },
) {
  await registerClient(createDatabase(), {
    clientId: CLIENT_ID,
    redirectUris: [REDIRECT_URI],
    responseTypes: ['id_token token', 'id_token'],
  });
  const transaction = createAuthTransaction(
    {
      responseType: input.responseType,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      redirectUriExplicit: true,
      scope: ['openid', 'profile'],
      state: 'state-1',
      nonce: 'nonce-1',
    },
    'csrf-1',
  );
  const session = { subject: input.subject, authTime: NOW - 30, sessionId: 'session-1' };
  await stores.transactionStore.put('auth_txn:' + input.transactionId, transaction, 600);
  await stores.authSessionStore.set(input.transactionId, session);
  const response = await issueImplicitConsentResponse({
    transactionId: input.transactionId,
    transaction,
    session,
    responseMode: input.responseMode ?? createFragmentResponseMode({ issuer: ISSUER }),
  });
  return { response };
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

describe('issueImplicitConsentResponse', () => {
  // OIDC Core 1.0 §3.2.2.5 / RFC 9207 §2: the tokens, the state and iss in
  // the fragment; the transaction cookie is cleared.
  it('should redirect with the tokens, the state and iss in the fragment and clear the transaction cookie', async () => {
    const { response } = await approve({ transactionId: 'consent-txn-1', subject: 'consent-user-1', responseType: 'id_token token' });

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
    expect(decodeJwt(params['id_token'] ?? '').payload).toMatchObject({ sub: 'consent-user-1', nonce: 'nonce-1' });
    expect(response?.headers.get('Set-Cookie')).toBe(buildClearedTransactionCookie());
  });

  // OIDC Core 1.0 §3.1.2.1: a later prompt=none finds the consent; the
  // transaction and the login hand-off are over.
  it('should record the consent, finish the transaction and discard the login hand-off', async () => {
    await approve({ transactionId: 'consent-txn-2', subject: 'consent-user-2', responseType: 'id_token' });

    expect(await resolvers.consentResolver.hasConsent('consent-user-2', CLIENT_ID, ['openid', 'profile'])).toBe(true);
    expect(await stores.transactionStore.get('auth_txn:consent-txn-2')).toBeNull();
    expect(await stores.authSessionStore.get('consent-txn-2')).toBeUndefined();
  });

  // OAuth 2.0 Form Post Response Mode §2: the response mode the request asked for.
  it('should hand the tokens and the state to the response mode the request asked for', async () => {
    const posted: AuthorizationResponse = { method: 'redirect', location: 'https://rp.example.com/callback?response=recorded' };
    const respond = vi.fn(async () => posted);

    const { response } = await approve({
      transactionId: 'consent-txn-3',
      subject: 'consent-user-3',
      responseType: 'id_token',
      responseMode: { name: 'form_post', respond },
    });

    expect(response?.headers.get('Location')).toBe('https://rp.example.com/callback?response=recorded');
    expect(respond.mock.calls).toEqual([[REDIRECT_URI, { id_token: expect.any(String), state: 'state-1' }]]);
  });

  // OIDC Core 1.0 §3.2.2.6: the error goes back to the client in the fragment.
  it('should answer server_error in the fragment, recording no consent, when no ID Token signing key has the registered alg', async () => {
    vi.spyOn(clientResolver, 'findClient').mockResolvedValue({
      clientId: CLIENT_ID,
      redirectUris: [REDIRECT_URI],
      idTokenSignedResponseAlg: 'ES256',
    } as RegisteredClient);

    const { response } = await approve({ transactionId: 'consent-txn-4', subject: 'consent-user-4', responseType: 'id_token' });

    expect(fragmentOf(response).params).toEqual({
      error: 'server_error',
      error_description: 'No ID Token signing key registered for alg ES256',
      state: 'state-1',
      iss: ISSUER,
    });
    expect(await resolvers.consentResolver.hasConsent('consent-user-4', CLIENT_ID, ['openid'])).toBe(false);
  });

  // The blocks after this one issue the code.
  it('should return undefined and keep the transaction of response_type=code', async () => {
    const { response } = await approve({ transactionId: 'consent-txn-5', subject: 'consent-user-5', responseType: 'code' });

    expect(response).toBeUndefined();
    expect(await stores.transactionStore.get('auth_txn:consent-txn-5')).toMatchObject({ responseType: 'code' });
  });
});
