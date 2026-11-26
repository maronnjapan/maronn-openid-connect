import { AuthorizationError, createAuthTransaction, type AuthorizationRequestParams } from '@maronn-openid-connect/core';
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, requestTo } from '../../../../test-support/context';
import { GET as authorize } from '../../../authorize/route';
import { POST as decide } from '../../../consent/decision/route';
import { createDatabase, registerClient } from '../../db';
import { stores } from '../../provider';
import { validateDpopJktParameter } from './authorize';

// provider.ts keeps its clients and stores in the key-value store of db/ (in
// memory for the tests, vitest.config.ts) for the whole file, so every test
// uses a transaction and a session of its own.

/** 2026-01-01T00:00:00Z in Unix seconds: every test runs on this clock. */
const NOW = 1767225600;
const CLIENT_ID = 'dpop-authorize-client';
const REDIRECT_URI = 'https://rp.example.com/callback';
const STATE = 'state-1';
/** RFC 7636 Appendix B: the S256 code_challenge of its example code_verifier. */
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
// RFC 7638 §3.1: the thumbprint of its example key.
const JKT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';

beforeAll(async () => {
  await registerClient(createDatabase(), {
    clientId: CLIENT_ID,
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethods: ['none'],
  });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

let sequence = 0;

/** A value of its own for each use, so the tests of the file do not share records. */
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/** The query of a valid authorization request of the client, with the given changes. */
function authorizationQuery(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state: STATE,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    ...overrides,
  };
}

/** GET /authorize with the query, and the browser's cookies when given. */
function authorizeRequest(query: Record<string, string>, cookie?: string): NextRequest {
  return new NextRequest(
    requestTo(`/authorize?${new URLSearchParams(query)}`, cookie === undefined ? {} : { headers: { Cookie: cookie } }),
  );
}

/** The cnf of every transaction /authorize stored while the spy watched. */
function storedConfirmations(put: { mock: { calls: unknown[][] } }): unknown[] {
  return put.mock.calls.map((call) => (call[1] as { cnf?: unknown }).cnf);
}

/** The cnf of the stored code the redirect authorization response carries. */
async function confirmationOfIssuedCode(response: Response): Promise<unknown> {
  const code = new URL(response.headers.get('Location') ?? '').searchParams.get('code') ?? '';
  return ((await stores.authCodeStore.get(code)) as { cnf?: unknown } | null | undefined)?.cnf;
}

describe('validateDpopJktParameter', () => {
  const request = { redirectUri: REDIRECT_URI, state: STATE };

  it('should return the confirmation of dpop_jkt, or nothing without it', () => {
    expect([
      validateDpopJktParameter(request, { client_id: CLIENT_ID, dpop_jkt: JKT } as AuthorizationRequestParams, undefined),
      validateDpopJktParameter(request, { client_id: CLIENT_ID }, undefined),
    ]).toEqual([{ jkt: JKT }, undefined]);
  });

  // OIDC Core 1.0 §6.1 / RFC 9101 §6.3: core does not copy dpop_jkt from the Request Object into the parameters.
  it('should take dpop_jkt from the Request Object over the query, and from the query when the Request Object has none', () => {
    const query = { client_id: CLIENT_ID, dpop_jkt: '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I' } as AuthorizationRequestParams;

    expect([
      validateDpopJktParameter(request, query, { dpop_jkt: JKT }),
      validateDpopJktParameter(request, { client_id: CLIENT_ID }, { dpop_jkt: JKT }),
      validateDpopJktParameter(request, query, { scope: 'openid' }),
    ]).toEqual([{ jkt: JKT }, { jkt: JKT }, { jkt: '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I' }]);
  });

  // RFC 9449 §10: dpop_jkt is a JWK Thumbprint; a malformed one is an invalid request.
  it('should throw an invalid_request the client is redirected to for a dpop_jkt that is not a thumbprint', () => {
    let thrown: unknown;
    try {
      validateDpopJktParameter(request, { client_id: CLIENT_ID, dpop_jkt: 'not-a-thumbprint' } as AuthorizationRequestParams, undefined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthorizationError);
    expect(thrown).toMatchObject({
      error: 'invalid_request',
      errorDescription: 'dpop_jkt must be a base64url SHA-256 JWK Thumbprint',
      redirectUri: REDIRECT_URI,
      state: STATE,
    });
  });

  it('should redirect invalid_request with the state for a dpop_jkt that is not a thumbprint', async () => {
    const response = await authorize(authorizeRequest(authorizationQuery({ dpop_jkt: 'not-a-thumbprint' })));
    const location = new URL(response.headers.get('Location') ?? '');

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(Object.fromEntries(location.searchParams)).toEqual({
      error: 'invalid_request',
      error_description: 'dpop_jkt must be a base64url SHA-256 JWK Thumbprint',
      state: STATE,
      iss: TEST_ISSUER,
    });
  });

  it('should keep the confirmation in the transaction the login and consent screens continue', async () => {
    const put = vi.spyOn(stores.transactionStore, 'put');

    const response = await authorize(authorizeRequest(authorizationQuery({ dpop_jkt: JKT })));

    expect(new URL(response.headers.get('Location') ?? '').pathname).toBe('/login');
    expect(storedConfirmations(put)).toEqual([{ jkt: JKT }]);
  });

  it('should store no confirmation for a request without dpop_jkt', async () => {
    const put = vi.spyOn(stores.transactionStore, 'put');

    await authorize(authorizeRequest(authorizationQuery()));

    expect(storedConfirmations(put)).toEqual([undefined]);
  });

  // RFC 9449 §10: the code issued at /authorize (SSO) carries the key to the token endpoint.
  it('should bind the code issued for SSO with prior consent to dpop_jkt', async () => {
    const subject = unique('dpop-sso-user');
    const sessionId = unique('dpop-session');
    await stores.browserSessionStore.set(sessionId, { subject, authTime: NOW - 60 });
    await stores.consentStore.grant(subject, CLIENT_ID, ['openid']);

    const response = await authorize(authorizeRequest(authorizationQuery({ dpop_jkt: JKT }), `session_id=${sessionId}`));

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toMatch(new RegExp(`^${REDIRECT_URI}\\?code=`));
    expect(await confirmationOfIssuedCode(response)).toEqual({ jkt: JKT });
  });

  it('should bind the code the consent screen issues to the confirmation of its transaction', async () => {
    const transactionId = unique('dpop-txn');
    const transaction = {
      ...createAuthTransaction(
        {
          responseType: 'code',
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          redirectUriExplicit: true,
          scope: ['openid'],
          state: STATE,
          codeChallenge: CODE_CHALLENGE,
          codeChallengeMethod: 'S256',
        },
        'csrf-1',
      ),
      cnf: { jkt: JKT },
    };
    await stores.transactionStore.put('auth_txn:' + transactionId, transaction, 600);
    await stores.authSessionStore.set(transactionId, { subject: unique('dpop-consent-user'), authTime: NOW - 60 });

    const response = await decide(
      new NextRequest(
        requestTo(`/consent/decision?transaction_id=${transactionId}`, {
          method: 'POST',
          headers: { Cookie: `__Host-oidc_txn=${transactionId}`, 'Sec-Fetch-Site': 'same-origin' },
          body: new URLSearchParams({ transaction_id: transactionId, csrf_token: 'csrf-1', action: 'approve' }),
        }),
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toMatch(new RegExp(`^${REDIRECT_URI}\\?code=`));
    expect(await confirmationOfIssuedCode(response)).toEqual({ jkt: JKT });
  });
});
