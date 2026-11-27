import { AuthorizationError, type AuthorizationRequestParams, type Jwk } from '@maronn-openid-connect/core';
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, requestTo } from '../../../../test-support/context';
import { dpopKey, dpopProof } from '../../../../test-support/dpop';
import { decodeJwt, signRs256Jwt } from '../../../../test-support/jwt';
import { rs256Key } from '../../../../test-support/keys';
import { POST as push } from '../../../(par)/par/route';
import { GET as authorize } from '../../../authorize/route';
import { POST as decide } from '../../../consent/decision/route';
import { POST as token } from '../../../token/route';
import { SESSION_COOKIE_NAME } from '../../cookies';
import { createDatabase, registerClient } from '../../db';
import { config, stores } from '../../provider';
import { validateDpopJktParameter } from './authorize';

// provider.ts keeps its clients and stores in the key-value store of db/ (in
// memory for the tests, vitest.config.ts) for the whole file, so every test
// uses a transaction, a session and a client of its own.

/** 2026-01-01T00:00:00Z in Unix seconds: the clock of the tests that do not replay RFC 9449. */
const NOW = 1767225600;
const CLIENT_ID = 'dpop-authorize-client';
const CLIENT_SECRET = 'dpop-authorize-client-secret';
const REDIRECT_URI = 'https://rp.example.com/callback';
const STATE = 'state-1';
/** RFC 7636 Appendix B: the S256 code_challenge of its example code_verifier. */
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
/** The dpop_jkt of the authorization request of RFC 9449 Figure 25 (the thumbprint of RFC 7638 §3.1). */
const JKT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';
/** The JWK Thumbprint of the key of the DPoP proofs of RFC 9449 §5, the cnf.jkt of RFC 9449 Figure 9. */
const RFC9449_JKT = '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I';
const INVALID_DPOP_JKT = 'dpop_jkt must be a base64url SHA-256 JWK Thumbprint';
const REQUEST_OBJECT_KEY_ID = 'dpop-authorize-request-object-key';

/** The authorization server of the examples of RFC 9449. */
const RFC9449_ISSUER = 'https://server.example.com';
/** The DPoP proof of the token request of RFC 9449 Figure 5 (the proof of Figure 2): ES256, htm POST, htu https://server.example.com/token. */
const FIGURE_5_PROOF =
  'eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwieCI6Imw4dEZyaHgtMzR0VjNoUklDUkRZOXpDa0RscEJoRjQyVVFVZldWQVdCRnMiLCJ5IjoiOVZFNGpmX09rX282NHpiVFRsY3VOSmFqSG10NnY5VERWclUwQ2R2R1JEQSIsImNydiI6IlAtMjU2In19' +
  '.eyJqdGkiOiItQndDM0VTYzZhY2MybFRjIiwiaHRtIjoiUE9TVCIsImh0dSI6Imh0dHBzOi8vc2VydmVyLmV4YW1wbGUuY29tL3Rva2VuIiwiaWF0IjoxNTYyMjYyNjE2fQ' +
  '.2-GxA6T8lP4vfrg8v-FdWP0A0zdrj8igiMLvqRMUvwnQg4PtFLbdLXiOSsX0x7NVY-FNyJK70nfbV37xRZT3Lg';
/** The iat of FIGURE_5_PROOF. */
const FIGURE_5_IAT = 1_562_262_616;
/** The public client of RFC 9449 Figure 5, which sends its client_id and no credential. */
const RFC9449_CLIENT_ID = 's6BhdRkqt';
const RFC9449_REDIRECT_URI = 'https://client.example.com/cb';
/** The code_verifier of RFC 9449 Figure 5 and its S256 code_challenge (RFC 7636 §4.2). */
const RFC9449_CODE_VERIFIER = 'bEaL42izcC-o-xBk0K2vuJ6U-y1p9r_wW2dFWIWgjz-';
const RFC9449_CODE_CHALLENGE = 'HtPJkE32DJkowXxFcEC5nnFXgv1Z97Cn_krX96qwH0E';

const SAVED_ISSUER = config.issuer;

beforeAll(async () => {
  const requestObjectKey = await rs256Key(REQUEST_OBJECT_KEY_ID);
  await registerClient(createDatabase(), {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethods: ['client_secret_basic'],
    keys: { request_object: { keys: [requestObjectKey.publicJwk as Jwk] } },
  });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  config.issuer = SAVED_ISSUER;
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

/** GET /authorize of the issuer with the query, and the browser's cookies when given. */
function authorizeRequest(query: Record<string, string>, cookie?: string, issuer = TEST_ISSUER): NextRequest {
  return new NextRequest(
    new Request(`${issuer}/authorize?${new URLSearchParams(query)}`, cookie === undefined ? {} : { headers: { Cookie: cookie } }),
  );
}

/** A browser signed in as a subject of its own who consented to openid for the client, and its Cookie header. */
async function signedInBrowser(clientId = CLIENT_ID): Promise<string> {
  const subject = unique('dpop-sso-user');
  const sessionId = unique('dpop-session');
  await stores.browserSessionStore.set(sessionId, { subject, authTime: Math.floor(Date.now() / 1000) - 60 });
  await stores.consentStore.grant(subject, clientId, ['openid']);
  return `${SESSION_COOKIE_NAME}=${sessionId}`;
}

/** The cnf of every transaction /authorize stored while the spy watched ('none' for a transaction without one). */
function storedConfirmations(put: { mock: { calls: unknown[][] } }): unknown[] {
  return put.mock.calls.map((call) => {
    const value = call[1] as Record<string, unknown>;
    return 'cnf' in value ? value['cnf'] : 'none';
  });
}

/** The cnf of the stored code the redirect authorization response carries ('none' for a code without one). */
async function confirmationOfIssuedCode(response: Response): Promise<unknown> {
  const code = new URL(response.headers.get('Location') ?? '').searchParams.get('code') ?? '';
  const stored = (await stores.authCodeStore.get(code)) as Record<string, unknown> | null | undefined;
  return stored === null || stored === undefined ? stored : 'cnf' in stored ? stored['cnf'] : 'none';
}

/** The error the call throws, or undefined. */
function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('validateDpopJktParameter', () => {
  const request = { redirectUri: REDIRECT_URI, state: STATE };

  // RFC 9449 §10 / RFC 6749 §3.1: an empty parameter is the same as no parameter.
  it('should return the confirmation of dpop_jkt, and nothing without it or for an empty one', () => {
    expect([
      validateDpopJktParameter(request, { client_id: CLIENT_ID, dpop_jkt: JKT } as AuthorizationRequestParams, undefined),
      validateDpopJktParameter(request, { client_id: CLIENT_ID }, undefined),
      validateDpopJktParameter(request, { client_id: CLIENT_ID, dpop_jkt: '' } as AuthorizationRequestParams, undefined),
    ]).toEqual([{ jkt: JKT }, undefined, undefined]);
  });

  // OIDC Core 1.0 §6.1: core does not copy dpop_jkt from the Request Object into the parameters.
  it('should take dpop_jkt from the Request Object over the query, and from the query when the Request Object has none', () => {
    const query = { client_id: CLIENT_ID, dpop_jkt: RFC9449_JKT } as AuthorizationRequestParams;

    expect([
      validateDpopJktParameter(request, query, { dpop_jkt: JKT }),
      validateDpopJktParameter(request, { client_id: CLIENT_ID }, { dpop_jkt: JKT }),
      validateDpopJktParameter(request, query, { scope: 'openid' }),
    ]).toEqual([{ jkt: JKT }, { jkt: JKT }, { jkt: RFC9449_JKT }]);
  });

  // RFC 9449 §10: dpop_jkt is a JWK Thumbprint; anything else is an invalid request.
  it.each([
    ['a value that is not a thumbprint', { client_id: CLIENT_ID, dpop_jkt: 'not-a-thumbprint' }, undefined],
    ['a Request Object claim that is not a string', { client_id: CLIENT_ID, dpop_jkt: JKT }, { dpop_jkt: 42 }],
  ])('should throw an invalid_request the client is redirected to for %s', (_name, params, requestObjectClaims) => {
    const error = errorOf(() => validateDpopJktParameter(request, params as AuthorizationRequestParams, requestObjectClaims));

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({ error: 'invalid_request', errorDescription: INVALID_DPOP_JKT, redirectUri: REDIRECT_URI, state: STATE });
  });

  describe('Authorization request with dpop_jkt', () => {
    it('should redirect invalid_request with the state for a dpop_jkt that is not a thumbprint, and store no transaction', async () => {
      const put = vi.spyOn(stores.transactionStore, 'put');

      const response = await authorize(authorizeRequest(authorizationQuery({ dpop_jkt: 'not-a-thumbprint' })));
      const location = new URL(response.headers.get('Location') ?? '');

      expect(response.status).toBe(302);
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(Object.fromEntries(location.searchParams)).toEqual({
        error: 'invalid_request',
        error_description: INVALID_DPOP_JKT,
        state: STATE,
        iss: TEST_ISSUER,
      });
      expect(put).not.toHaveBeenCalled();
    });

    it('should keep the confirmation in the transaction the login and consent screens continue', async () => {
      const put = vi.spyOn(stores.transactionStore, 'put');

      const response = await authorize(authorizeRequest(authorizationQuery({ dpop_jkt: JKT })));

      expect(new URL(response.headers.get('Location') ?? '').pathname).toBe('/login');
      expect(storedConfirmations(put)).toEqual([{ jkt: JKT }]);
    });

    it('should store the transaction of a request without dpop_jkt, or with an empty one, without cnf', async () => {
      const put = vi.spyOn(stores.transactionStore, 'put');

      await authorize(authorizeRequest(authorizationQuery()));
      await authorize(authorizeRequest(authorizationQuery({ dpop_jkt: '' })));

      expect(storedConfirmations(put)).toEqual(['none', 'none']);
    });

    // OIDC Core 1.0 §6.1: the claim of the Request Object the client signed wins over the query.
    it('should bind the transaction to the dpop_jkt of the signed Request Object, not to the one of the query', async () => {
      const put = vi.spyOn(stores.transactionStore, 'put');
      const requestObject = await signRs256Jwt(
        { iss: CLIENT_ID, aud: TEST_ISSUER, ...authorizationQuery(), dpop_jkt: JKT },
        await rs256Key(REQUEST_OBJECT_KEY_ID),
      );

      await authorize(
        authorizeRequest({ client_id: CLIENT_ID, response_type: 'code', scope: 'openid', dpop_jkt: RFC9449_JKT, request: requestObject }),
      );

      expect(storedConfirmations(put)).toEqual([{ jkt: JKT }]);
    });

    // RFC 9449 §10.1: dpop_jkt in the body of a pushed authorization request binds its code.
    it('should bind the transaction to the dpop_jkt pushed to the PAR endpoint', async () => {
      const put = vi.spyOn(stores.transactionStore, 'put');
      const pushed = await push(
        new Request(`${TEST_ISSUER}/par`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
          },
          body: new URLSearchParams(authorizationQuery({ dpop_jkt: JKT })).toString(),
        }),
      );
      const { request_uri: requestUri } = (await pushed.json()) as { request_uri: string };

      const response = await authorize(authorizeRequest({ client_id: CLIENT_ID, request_uri: requestUri }));

      expect([pushed.status, response.status, new URL(response.headers.get('Location') ?? '').pathname]).toEqual([201, 302, '/login']);
      expect(storedConfirmations(put)).toEqual([{ jkt: JKT }]);
    });

    // RFC 9449 §10: the code issued at /authorize (SSO) carries the key to the token endpoint.
    it('should bind the code issued for SSO with prior consent to dpop_jkt', async () => {
      const response = await authorize(authorizeRequest(authorizationQuery({ dpop_jkt: JKT }), await signedInBrowser()));

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toMatch(new RegExp(`^${REDIRECT_URI}\\?code=`));
      expect(await confirmationOfIssuedCode(response)).toEqual({ jkt: JKT });
    });

    it('should bind the code the consent screen issues from the transaction of the request', async () => {
      const put = vi.spyOn(stores.transactionStore, 'put');
      await authorize(authorizeRequest(authorizationQuery({ dpop_jkt: JKT })));
      const [key, stored] = put.mock.calls[0] ?? ['', { csrfToken: '' }];
      const transactionId = key.slice('auth_txn:'.length);
      await stores.authSessionStore.set(transactionId, { subject: unique('dpop-consent-user'), authTime: NOW - 60 });

      const response = await decide(
        new NextRequest(
          requestTo(`/consent/decision?transaction_id=${transactionId}`, {
            method: 'POST',
            headers: { Cookie: `__Host-oidc_txn=${transactionId}`, 'Sec-Fetch-Site': 'same-origin' },
            body: new URLSearchParams({ transaction_id: transactionId, csrf_token: stored.csrfToken, action: 'approve' }),
          }),
        ),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toMatch(new RegExp(`^${REDIRECT_URI}\\?code=`));
      expect(await confirmationOfIssuedCode(response)).toEqual({ jkt: JKT });
    });
  });

  // RFC 9449 §10: the token request must carry a DPoP proof of the key of dpop_jkt.
  // The authorization server of the example is the provider of the file with its issuer set to server.example.com.
  describe('Token request for a code bound with dpop_jkt', () => {
    it('should exchange the code only with a proof of the key of dpop_jkt (RFC 9449 Figure 5)', async () => {
      vi.setSystemTime(FIGURE_5_IAT * 1000);
      config.issuer = RFC9449_ISSUER;
      await registerClient(createDatabase(), {
        clientId: RFC9449_CLIENT_ID,
        redirectUris: [RFC9449_REDIRECT_URI],
        tokenEndpointAuthMethods: ['none'],
      });
      const authorization = await authorize(
        authorizeRequest(
          {
            response_type: 'code',
            client_id: RFC9449_CLIENT_ID,
            redirect_uri: RFC9449_REDIRECT_URI,
            scope: 'openid',
            state: STATE,
            code_challenge: RFC9449_CODE_CHALLENGE,
            code_challenge_method: 'S256',
            dpop_jkt: RFC9449_JKT,
          },
          await signedInBrowser(RFC9449_CLIENT_ID),
          RFC9449_ISSUER,
        ),
      );
      const code = new URL(authorization.headers.get('Location') ?? '').searchParams.get('code') ?? '';
      const exchange = (proof?: string) =>
        token(
          new Request(`${RFC9449_ISSUER}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(proof === undefined ? {} : { DPoP: proof }) },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: RFC9449_CLIENT_ID,
              code,
              redirect_uri: RFC9449_REDIRECT_URI,
              code_verifier: RFC9449_CODE_VERIFIER,
            }).toString(),
          }),
        );

      const withoutProof = await exchange();
      const withOtherKey = await exchange(await dpopProof(await dpopKey(), { htm: 'POST', htu: `${RFC9449_ISSUER}/token` }));
      const withKey = await exchange(FIGURE_5_PROOF);
      const body = (await withKey.json()) as { access_token: string; token_type: string };

      expect(await confirmationOfIssuedCode(authorization)).toEqual({ jkt: RFC9449_JKT });
      expect([withoutProof.status, await withoutProof.json()]).toEqual([
        400,
        { error: 'invalid_grant', error_description: 'The grant is bound to a DPoP key, but no DPoP proof was sent' },
      ]);
      expect([withOtherKey.status, await withOtherKey.json()]).toEqual([
        400,
        { error: 'invalid_grant', error_description: 'The DPoP proof key does not match the key the grant is bound to' },
      ]);
      expect([withKey.status, body.token_type, decodeJwt(body.access_token).payload.cnf]).toEqual([200, 'DPoP', { jkt: RFC9449_JKT }]);
    });
  });
});
