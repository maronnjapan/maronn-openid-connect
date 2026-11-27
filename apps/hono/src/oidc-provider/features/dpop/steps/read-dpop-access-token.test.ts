import type { AccessTokenInfo } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, formPost, providerContext, requestTo } from '../../../../test-support/context.js';
import { dpopKey, dpopProof, type DpopKey } from '../../../../test-support/dpop.js';
import { providerApp } from '../../../../test-support/screens.js';
import type { ProviderConfig } from '../../../config.js';
import { registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { createProviderStores } from '../../../db/memory/stores.js';
import { registerUser } from '../../../db/memory/users.js';
import { BEARER_CHALLENGE, type UserInfoChallenges } from '../../../endpoints/userinfo/response.js';
import { readDpopUserInfoRequest } from './read-dpop-access-token.js';

const USERINFO_ENDPOINT = `${TEST_ISSUER}/userinfo`;
/** The challenges of a request that presented its token with the DPoP scheme, before the error: Bearer, then DPoP with the default algs. */
const CHALLENGES = 'Bearer realm="UserInfo", DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"';
/** The challenges of a request that sent its token with both Bearer and DPoP: both carry the error (RFC 9449 Figure 19). */
const MULTIPLE_METHODS_CHALLENGES =
  'Bearer realm="UserInfo", error="invalid_request", error_description="Multiple access token methods are not allowed", ' +
  'DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA", error="invalid_request", error_description="Multiple access token methods are not allowed"';
const CLAIMS = { sub: 'alice', email: 'alice@example.com', email_verified: true };
/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW = 1_767_225_600;
/** The secret of the DPoP nonces of the tests (41 bytes). */
const NONCE_SECRET = 'dpop-nonce-secret-for-the-unit-tests-0001';
/** The random bytes 0x00 to 0x0b. */
const RANDOM = Uint8Array.from({ length: 12 }, (_, index) => index);
// The nonces below were computed apart from the code under test, with the HMAC
// of node:crypto and NONCE_SECRET, for the issuer https://op.example.com
// (TEST_ISSUER) and RANDOM (see nonce.test.ts).
/** The nonce the protected resource issues at NOW. */
const RESOURCE_SERVER_NONCE_AT_NOW = 'AAAAAGlVuQAAAQIDBAUGBwgJCgs.qMJbK4hF-YMMuV93-YOisKgT890kG1mcLWrlBS0Hgvc';
/** The nonce the protected resource issues 60 seconds before NOW. */
const RESOURCE_SERVER_NONCE_A_MINUTE_AGO = 'AAAAAGlVuMQAAQIDBAUGBwgJCgs.nqqlWQTffRmDCkTSydKKh-0jY-TTN63lEhXSRrjSmCU';
/** The nonce the authorization server issues at NOW. */
const AUTHORIZATION_SERVER_NONCE_AT_NOW = 'AAAAAGlVuQAAAQIDBAUGBwgJCgs.qlRn_qjLCd4ScDSkutyR475dsXalwZpCxni6jPVshAI';
/** The form of a nonce of this OP (RFC 9449 §8.1): the base64url of 20 bytes, a dot and the base64url of an HMAC-SHA256. */
const NONCE_FORM = /^[A-Za-z0-9_-]{27}\.[A-Za-z0-9_-]{43}$/;
const NONCE_REQUIRED = 'Resource server requires nonce in DPoP proof';
const STALE_NONCE = 'The DPoP proof nonce is not a nonce the resource server recently provided';

/** The inputs of setUp(). */
interface SetUpInput {
  key?: DpopKey;
  token?: Partial<AccessTokenInfo>;
  config?: Partial<ProviderConfig>;
  secret?: string;
  userinfoSignedResponseAlg?: 'RS256';
}

/**
 * The app with alice, the public client client-1, and token-1 issued to the client for alice, bound to key when given,
 * with the settings of config and the secret of the DPoP nonces when given. The client registered
 * userinfoSignedResponseAlg when given.
 */
async function setUp(input: SetUpInput = {}) {
  const db = createEmptyDatabase();
  await registerUser(db, { sub: 'alice', name: 'Alice Example', email: 'alice@example.com', email_verified: true });
  await registerClient(db, {
    clientId: 'client-1',
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethods: ['none'],
    ...(input.userinfoSignedResponseAlg === undefined ? {} : { userinfoSignedResponseAlg: input.userinfoSignedResponseAlg }),
  });
  const binding = input.key === undefined ? {} : { cnf: { jkt: input.key.jkt }, tokenType: 'DPoP' };
  const record: AccessTokenInfo = {
    sub: 'alice',
    scope: ['openid', 'email'],
    clientId: 'client-1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    audience: [USERINFO_ENDPOINT],
    ...input.token,
    ...binding,
  };
  await createProviderStores(db).accessTokenStore.set('token-1', record);
  return {
    app: await providerApp(db, {
      ...(input.config === undefined ? {} : { config: input.config }),
      ...(input.secret === undefined ? {} : { dpopNonceSecret: input.secret }),
    }),
  };
}

/** A GET of /userinfo with token-1 in the DPoP scheme and a proof of key for it, with the claims of overrides. */
async function dpopGet(key: DpopKey, overrides: Record<string, unknown> = {}): Promise<Request> {
  const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken: 'token-1' }, overrides);
  return requestTo('/userinfo', { headers: { Authorization: 'DPoP token-1', DPoP: proof } });
}

describe('readDpopUserInfoRequest', () => {
  // RFC 6750 §2.1 / RFC 9449 §7.2: a Bearer request is left to the Bearer step, whose failures also offer the DPoP scheme.
  it('should add the DPoP challenge to a request that does not use the DPoP scheme, and leave its token to the Bearer step', async () => {
    const challenges: UserInfoChallenges = { offered: [BEARER_CHALLENGE], scheme: 'Bearer' };
    const { c } = await providerContext({ request: requestTo('/userinfo', { headers: { Authorization: 'Bearer token-1' } }) });

    const read = await readDpopUserInfoRequest(c, challenges);

    expect([read, challenges]).toEqual([
      { dpopAccessToken: undefined, dpopJkt: undefined },
      {
        offered: [
          { scheme: 'Bearer', parameters: ['realm="UserInfo"'] },
          { scheme: 'DPoP', parameters: ['algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"'] },
        ],
        scheme: 'Bearer',
      },
    ]);
  });

  // RFC 9449 §7.2 Figure 17: no authentication information, so no challenge carries an error.
  it('should answer a request without a token with the Bearer and the DPoP challenge, neither with an error', async () => {
    const { app } = await setUp();

    const response = await app.request(requestTo('/userinfo'));

    expect([response.status, response.headers.get('WWW-Authenticate'), await response.json()]).toEqual([
      401,
      'Bearer realm="UserInfo", DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"',
      { error: 'invalid_token', error_description: 'Access token is required' },
    ]);
  });

  // RFC 9449 §7.2 Figure 18: the token was presented with the Bearer scheme, so the Bearer challenge carries the error.
  it('should answer an unknown Bearer token with the error in the Bearer challenge and the DPoP challenge without it', async () => {
    const { app } = await setUp();

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'Bearer unknown' } }));

    expect([response.status, response.headers.get('WWW-Authenticate')]).toEqual([
      401,
      'Bearer realm="UserInfo", error="invalid_token", error_description="Access token is invalid", ' +
        'DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"',
    ]);
  });

  // RFC 6750 §2: the header and the form body are both Bearer methods, so the scheme is not ambiguous.
  it('should answer a Bearer token sent in the header and in the form body with the error in the Bearer challenge alone', async () => {
    const { app } = await setUp();

    const response = await app.request(formPost('/userinfo', { access_token: 'token-1' }, { Authorization: 'Bearer token-1' }));

    expect([response.status, response.headers.get('WWW-Authenticate')]).toEqual([
      400,
      'Bearer realm="UserInfo", error="invalid_request", DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"',
    ]);
  });

  // RFC 9449 §7.2 Figure 19: two Authorization fields arrive as one value joined with ", ". The proof is a
  // good one for the token, so only the two schemes reject the request.
  it.each([
    ['Bearer', 'DPoP'],
    ['DPoP', 'Bearer'],
  ])('should reject a token sent in a %s and a %s Authorization field with 400 and the error in both challenges', async (first, second) => {
    const key = await dpopKey();
    const { app } = await setUp({ key });
    const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken: 'token-1' });
    const headers = new Headers({ DPoP: proof });
    headers.append('Authorization', `${first} token-1`);
    headers.append('Authorization', `${second} token-1`);

    const response = await app.request(requestTo('/userinfo', { headers }));

    expect([response.status, response.headers.get('Cache-Control'), response.headers.get('WWW-Authenticate'), await response.json()]).toEqual([
      400,
      'no-store',
      MULTIPLE_METHODS_CHALLENGES,
      { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
    ]);
  });

  // RFC 9449 §7.1: Authorization: DPoP <token> with a proof carrying ath.
  it('should answer a DPoP-bound token presented with the DPoP scheme and a proof of its key', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key });

    const response = await app.request(await dpopGet(key));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(CLAIMS);
  });

  // RFC 9110 §11.1: the authentication scheme is case-insensitive.
  it('should read the DPoP scheme in any letter case', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key });
    const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken: 'token-1' });

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'dpop token-1', DPoP: proof } }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLAIMS);
  });

  it('should accept the DPoP scheme on a form POST, with the proof bound to POST', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key });
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken: 'token-1' });

    const response = await app.request(formPost('/userinfo', {}, { Authorization: 'DPoP token-1', DPoP: proof }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLAIMS);
  });

  // RFC 9449 §7.1: the resource server MUST check that a DPoP proof was received.
  it('should reject the DPoP scheme without a proof, with the error in the DPoP challenge', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key });

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'DPoP token-1' } }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `${CHALLENGES}, error="invalid_dpop_proof", error_description="A DPoP proof is required with the DPoP authorization scheme"`,
    );
    expect(await response.json()).toEqual({
      error: 'invalid_dpop_proof',
      error_description: 'A DPoP proof is required with the DPoP authorization scheme',
    });
  });

  // RFC 9449 §4.3: htm and htu of the UserInfo request, and ath of the token presented (§7).
  it.each([
    ['the ath of another token', { ath: 'fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo' }, 'The DPoP proof ath claim does not match the access token'],
    ['no ath', { ath: undefined }, 'The DPoP proof ath claim does not match the access token'],
    ['the htu of the token endpoint', { htu: `${TEST_ISSUER}/token` }, 'The DPoP proof htu claim does not match the request URI'],
    ['the htm of a POST', { htm: 'POST' }, 'The DPoP proof htm claim does not match the request method'],
  ])('should reject a proof with %s', async (_name, overrides, description) => {
    const key = await dpopKey();
    const { app } = await setUp({ key });

    const response = await app.request(await dpopGet(key, overrides));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `${CHALLENGES}, error="invalid_dpop_proof", error_description="${description}"`,
    );
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof', error_description: description });
  });

  // RFC 9449 §11.1: a proof is accepted once.
  it('should reject the same proof sent twice', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key });
    const request = await dpopGet(key);
    const first = await app.request(request.clone());

    const response = await app.request(request);

    expect([first.status, response.status, await response.json()]).toEqual([
      200,
      401,
      { error: 'invalid_dpop_proof', error_description: 'The DPoP proof has already been used' },
    ]);
  });

  // RFC 9449 §4.3: exactly one DPoP header (a repeated header arrives joined with ", ").
  it('should reject two DPoP headers', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key });
    const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken: 'token-1' });
    const headers = new Headers({ Authorization: 'DPoP token-1' });
    headers.append('DPoP', proof);
    headers.append('DPoP', proof);

    const response = await app.request(requestTo('/userinfo', { headers }));

    expect([response.status, await response.json()]).toEqual([
      401,
      { error: 'invalid_dpop_proof', error_description: 'More than one DPoP header is not allowed' },
    ]);
  });

  // RFC 6750 §2.2 / RFC 9449 §7.2 Figure 19: a token of the form body is a Bearer token, so the request sent
  // its token with both schemes, and both challenges carry the error.
  it('should reject a DPoP token sent with another token in the form body, with the error in both challenges', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key });
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken: 'token-1' });

    const response = await app.request(
      formPost('/userinfo', { access_token: 'token-1' }, { Authorization: 'DPoP token-1', DPoP: proof }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBe(MULTIPLE_METHODS_CHALLENGES);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Multiple access token methods are not allowed',
    });
  });

  // RFC 9449 §7.2 Figure 19: the form body is a Bearer method whatever the DPoP credentials are, as a
  // Bearer field without a token beside a DPoP field is.
  it.each(['DPoP', 'DPoP token-1 token-1'])(
    'should reject "%s" sent with a token in the form body with 400 and the error in both challenges',
    async (authorization) => {
      const { app } = await setUp();

      const response = await app.request(formPost('/userinfo', { access_token: 'token-1' }, { Authorization: authorization }));

      expect([response.status, response.headers.get('WWW-Authenticate'), await response.json()]).toEqual([
        400,
        MULTIPLE_METHODS_CHALLENGES,
        { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
      ]);
    },
  );

  it('should take an empty access_token of the form body for no second token', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key });
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken: 'token-1' });

    const response = await app.request(formPost('/userinfo', { access_token: '' }, { Authorization: 'DPoP token-1', DPoP: proof }));

    expect([response.status, await response.json()]).toEqual([200, CLAIMS]);
  });

  // RFC 6750 §3.1: a repeated access_token is malformed; any value that is not empty is a second token.
  it('should reject a DPoP token sent with a repeated access_token of the form body that has a value', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key });
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken: 'token-1' });

    const response = await app.request(
      requestTo('/userinfo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'DPoP token-1', DPoP: proof },
        body: 'access_token=&access_token=token-1',
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBe(MULTIPLE_METHODS_CHALLENGES);
  });

  it('should reject the DPoP scheme without a token with 400 invalid_request', async () => {
    const { app } = await setUp();

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'DPoP' } }));

    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `${CHALLENGES}, error="invalid_request", error_description="The DPoP authorization header has no access token"`,
    );
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'The DPoP authorization header has no access token',
    });
  });

  // RFC 9449 Figure 12: the credentials are one token68. Two DPoP fields name one scheme, and the proof
  // is a good one for the whole value, so only the token68 check rejects the request.
  it('should reject credentials that are not one token68 with 400 invalid_request', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key });
    const credentials = 'token-1, DPoP token-1';
    const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken: credentials });

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: `DPoP ${credentials}`, DPoP: proof } }));

    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `${CHALLENGES}, error="invalid_request", error_description="The access token of the DPoP authorization header is not a token68 value"`,
    );
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'The access token of the DPoP authorization header is not a token68 value',
    });
  });

  it('should reject a form POST whose body it cannot read with 400 invalid_request and no challenge', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key });
    const brokenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('the connection was reset'));
      },
    });

    const response = await app.request(
      requestTo('/userinfo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'DPoP token-1' },
        body: brokenBody,
        duplex: 'half',
      } as RequestInit),
    );

    expect([response.status, response.headers.get('WWW-Authenticate'), await response.json()]).toEqual([
      400,
      null,
      { error: 'invalid_request' },
    ]);
  });

  // RFC 9449 §7.1 / §7.2: the failures of the later steps also go in the DPoP challenge.
  it('should answer a DPoP token without the openid scope with the error in the DPoP challenge', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key, token: { scope: ['email'] } });

    const response = await app.request(await dpopGet(key));

    expect([response.status, response.headers.get('WWW-Authenticate'), await response.json()]).toEqual([
      403,
      `${CHALLENGES}, error="insufficient_scope", error_description="The openid scope is required"`,
      { error: 'insufficient_scope', error_description: 'The openid scope is required' },
    ]);
  });

  // RFC 9449 §7.1: algs lists the algs the proof check accepts, which are the configured ones it can verify.
  it('should list in the DPoP challenge only the configured algs the checks can verify', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key, config: { dpopSigningAlgValuesSupported: ['HS256', 'ES256', 'PS256'] } });

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'DPoP token-1' } }));

    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="UserInfo", DPoP algs="ES256 PS256", error="invalid_dpop_proof", error_description="A DPoP proof is required with the DPoP authorization scheme"',
    );
  });
});

describe('readDpopUserInfoRequest with dpopNonceRequiredAtResourceServer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Makes crypto.getRandomValues() fill its array with RANDOM. */
  function fixRandomBytes(): void {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint8Array).set(RANDOM);
      return array;
    });
  }

  /** The app of setUp() where the protected resource requires its nonces, made with NONCE_SECRET. */
  function nonceSetUp(input: SetUpInput = {}) {
    return setUp({ secret: NONCE_SECRET, ...input, config: { dpopNonceRequiredAtResourceServer: true, ...input.config } });
  }

  // RFC 9449 §9 Figure 24: 401 use_dpop_nonce in the DPoP challenge, with the nonce to use in DPoP-Nonce, which a browser may read.
  it('should answer a DPoP proof without a nonce with 401 use_dpop_nonce in the DPoP challenge and the nonce to use', async () => {
    const key = await dpopKey();
    const { app } = await nonceSetUp({ key });
    const request = await dpopGet(key);
    request.headers.set('Origin', 'https://rp.example.com');
    fixRandomBytes();

    const response = await app.request(request);

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(`${CHALLENGES}, error="use_dpop_nonce", error_description="${NONCE_REQUIRED}"`);
    expect(await response.json()).toEqual({ error: 'use_dpop_nonce', error_description: NONCE_REQUIRED });
    expect(response.headers.get('DPoP-Nonce')).toBe(RESOURCE_SERVER_NONCE_AT_NOW);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('WWW-Authenticate,DPoP-Nonce');
  });

  // RFC 9449 §9 / §8.2: the retry with the nonce succeeds, and the 200 carries the nonce to use next.
  it('should answer the retry with the nonce it gave, with the next nonce', async () => {
    const key = await dpopKey();
    const { app } = await nonceSetUp({ key });
    const nonce = (await app.request(await dpopGet(key))).headers.get('DPoP-Nonce') ?? '';

    const retry = await app.request(await dpopGet(key, { nonce }));

    expect([retry.status, await retry.json()]).toEqual([200, CLAIMS]);
    expect(retry.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
    expect(retry.headers.get('DPoP-Nonce')).not.toBe(nonce);
  });

  // RFC 9449 §8 / §9: the server keeps a window of recent nonces (dpopNonceLifetimeSeconds, 120 by default).
  it('should accept a nonce it issued a minute ago, and give the nonce it issues now', async () => {
    const key = await dpopKey();
    const { app } = await nonceSetUp({ key });
    const request = await dpopGet(key, { nonce: RESOURCE_SERVER_NONCE_A_MINUTE_AGO });
    fixRandomBytes();

    const response = await app.request(request);

    expect([response.status, await response.json(), response.headers.get('DPoP-Nonce')]).toEqual([200, CLAIMS, RESOURCE_SERVER_NONCE_AT_NOW]);
  });

  // RFC 9449 §8.2 / §9: the signed UserInfo response (OIDC Core 1.0 §5.3.2) carries the nonce to use next too.
  it('should give the nonce it issues now with a signed UserInfo response', async () => {
    const key = await dpopKey();
    const { app } = await nonceSetUp({ key, userinfoSignedResponseAlg: 'RS256' });
    const request = await dpopGet(key, { nonce: RESOURCE_SERVER_NONCE_A_MINUTE_AGO });
    fixRandomBytes();

    const response = await app.request(request);

    expect([response.status, response.headers.get('Content-Type'), response.headers.get('DPoP-Nonce')]).toEqual([
      200,
      'application/jwt',
      RESOURCE_SERVER_NONCE_AT_NOW,
    ]);
  });

  it('should reject a nonce older than dpopNonceLifetimeSeconds and give a new one', async () => {
    const key = await dpopKey();
    const { app } = await nonceSetUp({ key });
    const nonce = (await app.request(await dpopGet(key))).headers.get('DPoP-Nonce') ?? '';
    vi.setSystemTime((NOW + 121) * 1000);

    const response = await app.request(await dpopGet(key, { nonce }));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(`${CHALLENGES}, error="use_dpop_nonce", error_description="${STALE_NONCE}"`);
    expect(response.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
    expect(response.headers.get('DPoP-Nonce')).not.toBe(nonce);
  });

  // RFC 9449 §9: the nonces of the authorization server and of the resource server are not the same.
  it('should reject a nonce of the authorization server', async () => {
    const key = await dpopKey();
    const { app } = await nonceSetUp({ key });

    const response = await app.request(await dpopGet(key, { nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW }));

    expect([response.status, await response.json()]).toEqual([401, { error: 'use_dpop_nonce', error_description: STALE_NONCE }]);
  });

  // RFC 9449 §9: a nonce given by the token endpoint is not one of the protected resource, and the other way round.
  it('should not accept a nonce of the token endpoint at UserInfo, nor a nonce of UserInfo at the token endpoint', async () => {
    const key = await dpopKey();
    const { app } = await nonceSetUp({ key, config: { dpopNonceRequiredAtAuthorizationServer: true } });
    const tokenRequest = async (claims: Record<string, unknown>) =>
      app.request(
        formPost('/token', { grant_type: 'authorization_code', code: 'code-1' }, { DPoP: await dpopProof(key, { htm: 'POST', htu: `${TEST_ISSUER}/token` }, claims) }),
      );
    const tokenEndpointNonce = (await tokenRequest({})).headers.get('DPoP-Nonce') ?? '';
    const userInfoNonce = (await app.request(await dpopGet(key))).headers.get('DPoP-Nonce') ?? '';

    const atUserInfo = await app.request(await dpopGet(key, { nonce: tokenEndpointNonce }));
    const atTokenEndpoint = await tokenRequest({ nonce: userInfoNonce });

    expect([tokenEndpointNonce, userInfoNonce]).toEqual([expect.stringMatching(NONCE_FORM), expect.stringMatching(NONCE_FORM)]);
    expect([atUserInfo.status, await atUserInfo.json()]).toEqual([401, { error: 'use_dpop_nonce', error_description: STALE_NONCE }]);
    expect([atTokenEndpoint.status, await atTokenEndpoint.json()]).toEqual([
      400,
      { error: 'use_dpop_nonce', error_description: 'The DPoP proof nonce is not a nonce the authorization server recently provided' },
    ]);
  });

  // RFC 9449 §8.2 / §9: every response to a request presented with the DPoP scheme carries the nonce to use next, the other errors too.
  it.each([
    ['no proof', async () => requestTo('/userinfo', { headers: { Authorization: 'DPoP token-1' } }), {}, 401, 'invalid_dpop_proof'],
    [
      'a proof for another URI',
      async (key: DpopKey) =>
        requestTo('/userinfo', {
          headers: {
            Authorization: 'DPoP token-1',
            DPoP: await dpopProof(key, { htm: 'GET', htu: `${TEST_ISSUER}/token`, accessToken: 'token-1' }, { nonce: RESOURCE_SERVER_NONCE_AT_NOW }),
          },
        }),
      {},
      401,
      'invalid_dpop_proof',
    ],
    [
      'another token in the form body',
      async (key: DpopKey) =>
        formPost('/userinfo', { access_token: 'token-1' }, { Authorization: 'DPoP token-1', DPoP: await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken: 'token-1' }) }),
      {},
      400,
      'invalid_request',
    ],
    ['a token bound to another key', async () => dpopGet(await dpopKey(), { nonce: RESOURCE_SERVER_NONCE_AT_NOW }), {}, 401, 'invalid_token'],
    ['a token without the openid scope', async (key: DpopKey) => dpopGet(key, { nonce: RESOURCE_SERVER_NONCE_AT_NOW }), { scope: ['email'] }, 403, 'insufficient_scope'],
  ])('should give the nonce to use next with the error of a request with %s', async (_name, requestOf, tokenOverrides, status, error) => {
    const key = await dpopKey();
    const { app } = await nonceSetUp({ key, token: tokenOverrides });
    const request = await requestOf(key);
    fixRandomBytes();

    const response = await app.request(request);

    expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([status, error]);
    expect(response.headers.get('DPoP-Nonce')).toBe(RESOURCE_SERVER_NONCE_AT_NOW);
  });

  // A request that does not present its token with the DPoP scheme is given no nonce and asked for none.
  it.each([
    ['a Bearer token', { Authorization: 'Bearer token-1' }, 200],
    ['no token', {}, 401],
  ])('should give no nonce to a request with %s', async (_name, headers: Record<string, string>, status) => {
    const { app } = await nonceSetUp();

    const response = await app.request(requestTo('/userinfo', { headers }));

    expect([response.status, response.headers.has('DPoP-Nonce')]).toEqual([status, false]);
  });

  // RFC 9449 §7.2 Figure 19: a request that names both schemes in Authorization is rejected before the DPoP scheme is read.
  it('should give no nonce to a request that names both Bearer and DPoP in Authorization', async () => {
    const { app } = await nonceSetUp();

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'Bearer token-1, DPoP token-1' } }));

    expect([response.status, response.headers.get('WWW-Authenticate'), response.headers.has('DPoP-Nonce')]).toEqual([400, MULTIPLE_METHODS_CHALLENGES, false]);
  });

  // RFC 9449 §11.3: a server that provides no nonce requires none.
  it.each([
    ['without a nonce', {}],
    ['with a nonce the server never issued', { nonce: 'a-nonce-of-another-server' }],
  ])('should neither give nor require a nonce when dpopNonceRequiredAtResourceServer is false: a proof %s', async (_name, claims) => {
    const key = await dpopKey();
    const { app } = await setUp({ key, secret: NONCE_SECRET });

    const response = await app.request(await dpopGet(key, claims));

    expect([response.status, await response.json(), response.headers.has('DPoP-Nonce')]).toEqual([200, CLAIMS, false]);
  });

  // RFC 2104 §3: a secret shorter than 32 bytes is a misconfiguration, not a bad request.
  it('should answer server_error when the secret of the DPoP nonces is shorter than 32 bytes', async () => {
    const key = await dpopKey();
    const { app } = await nonceSetUp({ key, secret: 'a'.repeat(31) });

    const response = await app.request(await dpopGet(key));

    expect([response.status, await response.json(), response.headers.has('DPoP-Nonce')]).toEqual([500, { error: 'server_error' }, false]);
  });
});
