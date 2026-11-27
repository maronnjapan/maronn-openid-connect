import { AuthorizationError, type AuthorizationRequestParams, type Jwk } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ID,
  REDIRECT_URI,
  STATE,
  SUBJECT,
  authorizationParams,
  authorizePath,
  registerTestClient,
  signIn,
  validatedRequestOf,
} from '../../../../test-support/authorize.js';
import { TEST_ISSUER, formPost, providerContext, requestTo } from '../../../../test-support/context.js';
import { dpopKey, dpopProof } from '../../../../test-support/dpop.js';
import { basicAuthorization, providerApp, signRs256Jwt } from '../../../../test-support/feature-endpoints.js';
import { rs256Key } from '../../../../test-support/keys.js';
import { transactionCookie } from '../../../../test-support/screens.js';
import { decodeJwt } from '../../../../test-support/token.js';
import { createEmptyDatabase, type MemoryDatabase } from '../../../db/memory/database.js';
import { processAuthorizationRequest } from '../../../endpoints/authorize/pipeline.js';
import { submitConsent } from '../../../endpoints/consent/pipeline.js';
import { validateDpopJktParameter } from './validate-dpop-jkt.js';

/** The dpop_jkt of the authorization request of RFC 9449 Figure 25 (the thumbprint of RFC 7638 §3.1). */
const JKT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';
/** The JWK Thumbprint of the key of the DPoP proofs of RFC 9449 §5, the cnf.jkt of RFC 9449 Figure 9. */
const RFC9449_JKT = '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I';
const INVALID_DPOP_JKT = 'dpop_jkt must be a base64url SHA-256 JWK Thumbprint';

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

/** The parameters of a valid authorization request, as /authorize parses them. */
function paramsOf(overrides: Record<string, string> = {}): AuthorizationRequestParams {
  return { client_id: CLIENT_ID, ...authorizationParams(overrides) };
}

/** The test client (client-1) registered on a database of its own. */
async function databaseWithClient(): Promise<MemoryDatabase> {
  const db = createEmptyDatabase();
  await registerTestClient(db);
  return db;
}

/** Answer an authorization request of the parameters on the database, from a browser with the cookie when given. */
async function authorize(db: MemoryDatabase, params: Record<string, string>, cookie?: string) {
  const headers: Record<string, string> = cookie === undefined ? {} : { Cookie: cookie };
  const { c } = await providerContext({ db, request: requestTo(authorizePath(params), { headers }) });
  return processAuthorizationRequest(c);
}

/** The cnf of every transaction stored in the database ('none' for a transaction without one). */
function transactionConfirmations(db: MemoryDatabase): unknown[] {
  return [...db.transactions.values()].map((entry) => {
    const value = entry.value as unknown as Record<string, unknown>;
    return 'cnf' in value ? value['cnf'] : 'none';
  });
}

/** The cnf of every code stored in the database ('none' for a code without one). */
function codeConfirmations(db: MemoryDatabase): unknown[] {
  return [...db.codes.values()].map((code) => {
    const value = code as unknown as Record<string, unknown>;
    return 'cnf' in value ? value['cnf'] : 'none';
  });
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
  // RFC 9449 §10 / RFC 6749 §3.1: an empty parameter is the same as no parameter.
  it('should return the confirmation of dpop_jkt, and nothing without it or for an empty one', () => {
    expect([
      validateDpopJktParameter(validatedRequestOf(), paramsOf({ dpop_jkt: JKT }), undefined),
      validateDpopJktParameter(validatedRequestOf(), paramsOf(), undefined),
      validateDpopJktParameter(validatedRequestOf(), paramsOf({ dpop_jkt: '' }), undefined),
    ]).toEqual([{ jkt: JKT }, undefined, undefined]);
  });

  // OIDC Core 1.0 §6.1: core does not copy dpop_jkt from the Request Object into effectiveParams.
  it('should take dpop_jkt from the Request Object over the query, and from the query when the Request Object has none', () => {
    const query = paramsOf({ dpop_jkt: RFC9449_JKT });

    expect([
      validateDpopJktParameter(validatedRequestOf(), query, { dpop_jkt: JKT }),
      validateDpopJktParameter(validatedRequestOf(), paramsOf(), { dpop_jkt: JKT }),
      validateDpopJktParameter(validatedRequestOf(), query, { scope: 'openid' }),
    ]).toEqual([{ jkt: JKT }, { jkt: JKT }, { jkt: RFC9449_JKT }]);
  });

  // RFC 9449 §10: dpop_jkt is a JWK Thumbprint; anything else is an invalid request.
  it.each([
    ['a value that is not a thumbprint', paramsOf({ dpop_jkt: 'not-a-thumbprint' }), undefined],
    ['a Request Object claim that is not a string', paramsOf({ dpop_jkt: JKT }), { dpop_jkt: 42 }],
  ])('should throw an invalid_request the client is redirected to for %s', (_name, params, requestObjectClaims) => {
    const error = errorOf(() => validateDpopJktParameter(validatedRequestOf(), params, requestObjectClaims));

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({ error: 'invalid_request', errorDescription: INVALID_DPOP_JKT, redirectUri: REDIRECT_URI, state: STATE });
  });

  describe('Authorization request with dpop_jkt', () => {
    it('should redirect invalid_request with the state for a dpop_jkt that is not a thumbprint, and store no transaction', async () => {
      const db = await databaseWithClient();

      const outcome = await authorize(db, authorizationParams({ dpop_jkt: 'not-a-thumbprint' }));

      expect(outcome).toEqual({
        kind: 'authorization_response',
        response: {
          method: 'redirect',
          location:
            `${REDIRECT_URI}?error=invalid_request` +
            `&error_description=dpop_jkt+must+be+a+base64url+SHA-256+JWK+Thumbprint` +
            `&state=${STATE}&iss=${encodeURIComponent(TEST_ISSUER)}`,
        },
      });
      expect(db.transactions.size).toBe(0);
    });

    it('should keep the confirmation in the transaction the login and consent screens continue', async () => {
      const db = await databaseWithClient();

      await authorize(db, authorizationParams({ dpop_jkt: JKT }));

      expect(transactionConfirmations(db)).toEqual([{ jkt: JKT }]);
    });

    it('should store the transaction of a request without dpop_jkt, or with an empty one, without cnf', async () => {
      const db = await databaseWithClient();

      await authorize(db, authorizationParams());
      await authorize(db, authorizationParams({ dpop_jkt: '' }));

      expect(transactionConfirmations(db)).toEqual(['none', 'none']);
    });

    // OIDC Core 1.0 §6.1: the claim of the Request Object the client signed wins over the query.
    it('should bind the transaction to the dpop_jkt of the signed Request Object, not to the one of the query', async () => {
      const db = createEmptyDatabase();
      const clientKey = await rs256Key('dpop-jkt-request-object-key');
      await registerTestClient(db, { keys: { request_object: { keys: [clientKey.publicJwk as Jwk] } } });
      const requestObject = await signRs256Jwt(
        { iss: CLIENT_ID, aud: TEST_ISSUER, ...authorizationParams(), dpop_jkt: JKT },
        clientKey,
      );

      await authorize(db, { client_id: CLIENT_ID, response_type: 'code', scope: 'openid', dpop_jkt: RFC9449_JKT, request: requestObject });

      expect(transactionConfirmations(db)).toEqual([{ jkt: JKT }]);
    });

    // RFC 9449 §10.1: dpop_jkt in the body of a pushed authorization request binds its code.
    it('should bind the transaction to the dpop_jkt pushed to the PAR endpoint', async () => {
      const db = createEmptyDatabase();
      await registerTestClient(db, { clientSecret: 'client-1-secret' });
      const { app } = await providerApp(db);
      const pushed = await app.request(
        formPost('/par', { ...authorizationParams({ dpop_jkt: JKT }), client_id: CLIENT_ID }, {
          Authorization: basicAuthorization(CLIENT_ID, 'client-1-secret'),
        }),
      );
      const { request_uri: requestUri } = (await pushed.json()) as { request_uri: string };

      const response = await app.request(requestTo(authorizePath({ client_id: CLIENT_ID, request_uri: requestUri })));

      expect([pushed.status, response.status, new URL(response.headers.get('Location') ?? '').pathname]).toEqual([201, 302, '/login']);
      expect(transactionConfirmations(db)).toEqual([{ jkt: JKT }]);
    });

    // RFC 9449 §10: the code issued at /authorize (SSO) carries the key to the token endpoint.
    it('should bind the code issued for SSO with prior consent to dpop_jkt', async () => {
      const db = await databaseWithClient();
      const { stores } = await providerContext({ db });
      const cookie = await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

      await authorize(db, authorizationParams({ dpop_jkt: JKT }), cookie);

      expect(codeConfirmations(db)).toEqual([{ jkt: JKT }]);
    });

    it('should bind the code the consent screen issues from the transaction of the request', async () => {
      const db = await databaseWithClient();
      await authorize(db, authorizationParams({ dpop_jkt: JKT }));
      const [[key, entry]] = [...db.transactions.entries()];
      const transactionId = key.slice('auth_txn:'.length);
      const { csrfToken } = entry.value as { csrfToken: string };
      const { c, stores } = await providerContext({
        db,
        request: formPost(`/consent?transaction_id=${transactionId}`, {}, { Cookie: transactionCookie(transactionId) }),
      });
      await stores.authSessionStore.set(transactionId, { subject: SUBJECT, authTime: Math.floor(Date.now() / 1000) - 30 });

      const outcome = await submitConsent(c, { transactionId, csrfToken, action: 'approve' });

      expect(outcome).toMatchObject({ kind: 'authorization_response' });
      expect(codeConfirmations(db)).toEqual([{ jkt: JKT }]);
    });
  });

  // RFC 9449 §10: the token request must carry a DPoP proof of the key of dpop_jkt.
  describe('Token request for a code bound with dpop_jkt', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(FIGURE_5_IAT * 1000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should exchange the code only with a proof of the key of dpop_jkt (RFC 9449 Figure 5)', async () => {
      const db = createEmptyDatabase();
      await registerTestClient(db, {
        clientId: RFC9449_CLIENT_ID,
        clientType: 'public',
        redirectUris: [RFC9449_REDIRECT_URI],
        tokenEndpointAuthMethods: ['none'],
      });
      const { app, stores } = await providerApp(db, { config: { issuer: RFC9449_ISSUER } });
      const cookie = await signIn(stores);
      await stores.consentStore.grant(SUBJECT, RFC9449_CLIENT_ID, ['openid']);
      const authorization = await app.request(
        `${RFC9449_ISSUER}${authorizePath({
          response_type: 'code',
          client_id: RFC9449_CLIENT_ID,
          redirect_uri: RFC9449_REDIRECT_URI,
          scope: 'openid',
          state: STATE,
          code_challenge: RFC9449_CODE_CHALLENGE,
          code_challenge_method: 'S256',
          dpop_jkt: RFC9449_JKT,
        })}`,
        { headers: { Cookie: cookie } },
      );
      const code = new URL(authorization.headers.get('Location') ?? '').searchParams.get('code') ?? '';
      const exchange = (proof?: string) =>
        app.request(`${RFC9449_ISSUER}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(proof === undefined ? {} : { DPoP: proof }) },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: RFC9449_CLIENT_ID,
            code,
            redirect_uri: RFC9449_REDIRECT_URI,
            code_verifier: RFC9449_CODE_VERIFIER,
          }).toString(),
        });

      const withoutProof = await exchange();
      const withOtherKey = await exchange(await dpopProof(await dpopKey(), { htm: 'POST', htu: `${RFC9449_ISSUER}/token` }));
      const withKey = await exchange(FIGURE_5_PROOF);
      const body = (await withKey.json()) as { access_token: string; token_type: string };

      expect(codeConfirmations(db)).toEqual([{ jkt: RFC9449_JKT }]);
      expect([withoutProof.status, await withoutProof.json()]).toEqual([
        400,
        { error: 'invalid_grant', error_description: 'The grant is bound to a DPoP key, but no DPoP proof was sent' },
      ]);
      expect([withOtherKey.status, await withOtherKey.json()]).toEqual([
        400,
        { error: 'invalid_grant', error_description: 'The DPoP proof key does not match the key the grant is bound to' },
      ]);
      expect([withKey.status, body.token_type, decodeJwt(body.access_token).payload['cnf']]).toEqual([200, 'DPoP', { jkt: RFC9449_JKT }]);
    });
  });
});
