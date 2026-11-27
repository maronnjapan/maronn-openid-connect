import type { AccessTokenInfo } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { TEST_ISSUER, contextOf, formPost, requestTo } from '../../../../test-support/context.js';
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
const CLAIMS = { sub: 'alice', email: 'alice@example.com', email_verified: true };

/** The app with alice, the public client client-1, and token-1 issued to the client for alice, bound to key when given. */
async function setUp(input: { key?: DpopKey; token?: Partial<AccessTokenInfo>; config?: Partial<ProviderConfig> } = {}) {
  const db = createEmptyDatabase();
  await registerUser(db, { sub: 'alice', name: 'Alice Example', email: 'alice@example.com', email_verified: true });
  await registerClient(db, {
    clientId: 'client-1',
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethods: ['none'],
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
  return { app: await providerApp(db, input.config === undefined ? {} : { config: input.config }) };
}

/** A GET of /userinfo with token-1 in the DPoP scheme and a proof of key for it, with the claims of overrides. */
async function dpopGet(key: DpopKey, overrides: Record<string, unknown> = {}): Promise<Request> {
  const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken: 'token-1' }, overrides);
  return requestTo('/userinfo', { headers: { Authorization: 'DPoP token-1', DPoP: proof } });
}

describe('readDpopUserInfoRequest', () => {
  // RFC 6750 §2.1: a Bearer request is left to the Bearer step, and adds no challenge.
  it('should leave a request that does not use the DPoP scheme and its challenges as they are', async () => {
    const challenges: UserInfoChallenges = { offered: [BEARER_CHALLENGE], scheme: 'Bearer' };
    const c = contextOf(requestTo('/userinfo', { headers: { Authorization: 'Bearer token-1' } }));

    const read = await readDpopUserInfoRequest(c, challenges);

    expect([read, challenges]).toEqual([
      { dpopAccessToken: undefined, dpopJkt: undefined },
      { offered: [{ scheme: 'Bearer', parameters: ['realm="UserInfo"'] }], scheme: 'Bearer' },
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

  // RFC 6750 §2: one method per request. The token was presented with the DPoP scheme (Authorization: DPoP),
  // so the DPoP challenge carries the error.
  it('should reject a DPoP token sent with another token in the form body, with the error in the DPoP challenge', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key });
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken: 'token-1' });

    const response = await app.request(
      formPost('/userinfo', { access_token: 'token-1' }, { Authorization: 'DPoP token-1', DPoP: proof }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `${CHALLENGES}, error="invalid_request", error_description="Multiple access token methods are not allowed"`,
    );
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Multiple access token methods are not allowed',
    });
  });

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
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `${CHALLENGES}, error="invalid_request", error_description="Multiple access token methods are not allowed"`,
    );
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

  // RFC 9449 Figure 12: the credentials are one token68. The proof is a good one for the whole
  // value, so only the token68 check rejects the request.
  it('should reject credentials that are not one token68 with 400 invalid_request', async () => {
    const key = await dpopKey();
    const { app } = await setUp({ key });
    const credentials = 'token-1, Bearer token-1';
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
