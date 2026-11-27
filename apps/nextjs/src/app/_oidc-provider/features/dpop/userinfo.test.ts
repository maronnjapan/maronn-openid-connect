import type { AccessTokenInfo, AuthorizationCodeData } from '@maronn-openid-connect/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_ISSUER, requestTo } from '../../../../test-support/context';
import { dpopKey, dpopProof, type DpopKey } from '../../../../test-support/dpop';
import { accessTokenInfo } from '../../../../test-support/fixtures';
import { POST as token } from '../../../token/route';
import { GET, POST } from '../../../userinfo/route';
import { BEARER_CHALLENGE, type UserInfoChallenges } from '../../../userinfo/response';
import { createDatabase, registerClient, registerUser } from '../../db';
import { config, stores } from '../../provider';
import { readDpopUserInfoRequest } from './userinfo';

// provider.ts keeps its clients, users and stores in the key-value store of
// db/ (in memory for the tests, vitest.config.ts) for the whole file, so every
// test stores an access token of its own, and every proof is a fresh one (the
// jti store is shared too).

const USERINFO_ENDPOINT = `${TEST_ISSUER}/userinfo`;
const TOKEN_ENDPOINT = `${TEST_ISSUER}/token`;
/** The challenges of a request that presented its token with the DPoP scheme, before the error: Bearer, then DPoP with the default algs. */
const DPOP_CHALLENGES = 'Bearer realm="UserInfo", DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"';
const SUBJECT = 'dpop-userinfo-alice';
const CLIENT_ID = 'dpop-userinfo-client';
const CLIENT_SECRET = 'dpop-userinfo-client-secret';
const REDIRECT_URI = 'https://rp.example.com/callback';
const CLAIMS = { sub: SUBJECT, email: 'alice@example.com', email_verified: true };
// RFC 7636 §4.1 / §4.2: a 46-character verifier and its S256 challenge.
const CODE_VERIFIER = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const CODE_CHALLENGE = 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU';
const SAVED_ALGS = config.dpopSigningAlgValuesSupported;

beforeAll(async () => {
  await registerUser(createDatabase(), { sub: SUBJECT, name: 'Alice Example', email: 'alice@example.com', email_verified: true });
  await registerClient(createDatabase(), {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethods: ['client_secret_basic'],
  });
});

afterEach(() => {
  Object.assign(config, { dpopSigningAlgValuesSupported: SAVED_ALGS });
});

let sequence = 0;

/** A value of its own for each use, so the tests of the file do not share records. */
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/** Store an access token of its own for the client and the End-User, bound to boundJkt when given, and return it. */
async function storeToken(boundJkt?: string, overrides: Partial<AccessTokenInfo> = {}): Promise<string> {
  const accessToken = unique('dpop-userinfo-token');
  const record = accessTokenInfo({
    sub: SUBJECT,
    scope: ['openid', 'email'],
    clientId: CLIENT_ID,
    audience: [USERINFO_ENDPOINT],
    ...overrides,
  });
  const bound = { ...record, cnf: { jkt: boundJkt }, tokenType: 'DPoP' };
  await stores.accessTokenStore.set(accessToken, boundJkt === undefined ? record : bound);
  return accessToken;
}

/** A GET of the token with the DPoP scheme and a proof of key for it (ath of the token), with the claims of overrides. */
async function dpopGet(key: DpopKey, accessToken: string, overrides: Record<string, unknown> = {}): Promise<Request> {
  const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken }, overrides);
  return requestTo('/userinfo', { headers: { Authorization: `DPoP ${accessToken}`, DPoP: proof } });
}

/** A POST of a form body to /userinfo with the headers. */
function formPost(fields: Record<string, string>, headers: Record<string, string>): Request {
  return requestTo('/userinfo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The status, the challenge and the JSON body of an answer. */
async function answerOf(response: Response): Promise<{ status: number; challenge: string | null; body: unknown }> {
  return { status: response.status, challenge: response.headers.get('WWW-Authenticate'), body: await response.json() };
}

describe('readDpopUserInfoRequest', () => {
  // RFC 6750 §2.1: a Bearer request is left to the Bearer block, and adds no challenge.
  it('should leave a request that does not use the DPoP scheme and its challenges as they are', async () => {
    const challenges: UserInfoChallenges = { offered: [BEARER_CHALLENGE], scheme: 'Bearer' };

    const read = await readDpopUserInfoRequest(requestTo('/userinfo', { headers: { Authorization: 'Bearer token-1' } }), challenges);

    expect([read, challenges]).toEqual([
      { dpopAccessToken: undefined, dpopJkt: undefined },
      { offered: [{ scheme: 'Bearer', parameters: ['realm="UserInfo"'] }], scheme: 'Bearer' },
    ]);
  });

  // RFC 9449 §7.1: Authorization: DPoP <token> with a proof carrying ath.
  it('should answer a DPoP-bound token presented with the DPoP scheme and a proof of its key', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);

    const response = await GET(await dpopGet(key, accessToken));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(CLAIMS);
  });

  // RFC 9110 §11.1: the authentication scheme is case-insensitive.
  it('should read the DPoP scheme in any letter case', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken });

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `dpop ${accessToken}`, DPoP: proof } }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLAIMS);
  });

  it('should accept the DPoP scheme on a form POST, with the proof bound to POST', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken });

    const response = await POST(formPost({}, { Authorization: `DPoP ${accessToken}`, DPoP: proof }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLAIMS);
  });

  // RFC 9449 §7.1: the resource server MUST check that a DPoP proof was received.
  it('should reject the DPoP scheme without a proof, with the error in the DPoP challenge', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `DPoP ${accessToken}` } }));

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await answerOf(response)).toEqual({
      status: 401,
      challenge: `${DPOP_CHALLENGES}, error="invalid_dpop_proof", error_description="A DPoP proof is required with the DPoP authorization scheme"`,
      body: { error: 'invalid_dpop_proof', error_description: 'A DPoP proof is required with the DPoP authorization scheme' },
    });
  });

  // RFC 9449 §4.3: htm and htu of the UserInfo request, and ath of the token presented (§7).
  it.each([
    ['the ath of another token', { ath: 'fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo' }, 'The DPoP proof ath claim does not match the access token'],
    ['no ath', { ath: undefined }, 'The DPoP proof ath claim does not match the access token'],
    ['the htu of the token endpoint', { htu: TOKEN_ENDPOINT }, 'The DPoP proof htu claim does not match the request URI'],
    ['the htm of a POST', { htm: 'POST' }, 'The DPoP proof htm claim does not match the request method'],
  ])('should reject a proof with %s', async (_name, overrides, description) => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);

    const response = await GET(await dpopGet(key, accessToken, overrides));

    expect(await answerOf(response)).toEqual({
      status: 401,
      challenge: `${DPOP_CHALLENGES}, error="invalid_dpop_proof", error_description="${description}"`,
      body: { error: 'invalid_dpop_proof', error_description: description },
    });
  });

  // RFC 9449 §11.1: a proof is accepted once.
  it('should reject the same proof sent twice', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const request = await dpopGet(key, accessToken);
    const first = await GET(request.clone());

    const response = await GET(request);

    expect([first.status, response.status, await response.json()]).toEqual([
      200,
      401,
      { error: 'invalid_dpop_proof', error_description: 'The DPoP proof has already been used' },
    ]);
  });

  // RFC 9449 §4.3: exactly one DPoP header (a repeated header arrives joined with ", ").
  it('should reject two DPoP headers', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken });
    const headers = new Headers({ Authorization: `DPoP ${accessToken}` });
    headers.append('DPoP', proof);
    headers.append('DPoP', proof);

    const response = await GET(requestTo('/userinfo', { headers }));

    expect([response.status, await response.json()]).toEqual([
      401,
      { error: 'invalid_dpop_proof', error_description: 'More than one DPoP header is not allowed' },
    ]);
  });

  // RFC 6750 §2: one method per request. The token was presented with the DPoP scheme (Authorization: DPoP),
  // so the DPoP challenge carries the error.
  it('should reject a DPoP token sent with another token in the form body, with the error in the DPoP challenge', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken });

    const response = await POST(formPost({ access_token: accessToken }, { Authorization: `DPoP ${accessToken}`, DPoP: proof }));

    expect(await answerOf(response)).toEqual({
      status: 400,
      challenge: `${DPOP_CHALLENGES}, error="invalid_request", error_description="Multiple access token methods are not allowed"`,
      body: { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
    });
  });

  it('should take an empty access_token of the form body for no second token', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken });

    const response = await POST(formPost({ access_token: '' }, { Authorization: `DPoP ${accessToken}`, DPoP: proof }));

    expect([response.status, await response.json()]).toEqual([200, CLAIMS]);
  });

  // RFC 6750 §3.1: a repeated access_token is malformed; any value that is not empty is a second token.
  it('should reject a DPoP token sent with a repeated access_token of the form body that has a value', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken });

    const response = await POST(
      requestTo('/userinfo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `DPoP ${accessToken}`, DPoP: proof },
        body: `access_token=&access_token=${encodeURIComponent(accessToken)}`,
      }),
    );

    expect(await answerOf(response)).toEqual({
      status: 400,
      challenge: `${DPOP_CHALLENGES}, error="invalid_request", error_description="Multiple access token methods are not allowed"`,
      body: { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
    });
  });

  it('should reject the DPoP scheme without a token with 400 invalid_request', async () => {
    const response = await GET(requestTo('/userinfo', { headers: { Authorization: 'DPoP' } }));

    expect(await answerOf(response)).toEqual({
      status: 400,
      challenge: `${DPOP_CHALLENGES}, error="invalid_request", error_description="The DPoP authorization header has no access token"`,
      body: { error: 'invalid_request', error_description: 'The DPoP authorization header has no access token' },
    });
  });

  // RFC 9449 Figure 12: the credentials are one token68. The proof is a good one for the whole
  // value, so only the token68 check rejects the request.
  it('should reject credentials that are not one token68 with 400 invalid_request', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const credentials = `${accessToken}, Bearer ${accessToken}`;
    const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken: credentials });

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `DPoP ${credentials}`, DPoP: proof } }));

    expect(await answerOf(response)).toEqual({
      status: 400,
      challenge: `${DPOP_CHALLENGES}, error="invalid_request", error_description="The access token of the DPoP authorization header is not a token68 value"`,
      body: { error: 'invalid_request', error_description: 'The access token of the DPoP authorization header is not a token68 value' },
    });
  });

  it('should reject a form POST whose body it cannot read with 400 invalid_request and no challenge', async () => {
    const accessToken = await storeToken((await dpopKey()).jkt);
    const brokenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('the connection was reset'));
      },
    });

    const response = await POST(
      requestTo('/userinfo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `DPoP ${accessToken}` },
        body: brokenBody,
        duplex: 'half',
      } as RequestInit),
    );

    expect(await answerOf(response)).toEqual({ status: 400, challenge: null, body: { error: 'invalid_request' } });
  });

  // RFC 9449 §7.1 / §7.2: the failures of the later blocks also go in the DPoP challenge.
  it('should answer a DPoP token without the openid scope with the error in the DPoP challenge', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt, { scope: ['email'] });

    const response = await GET(await dpopGet(key, accessToken));

    expect(await answerOf(response)).toEqual({
      status: 403,
      challenge: `${DPOP_CHALLENGES}, error="insufficient_scope", error_description="The openid scope is required"`,
      body: { error: 'insufficient_scope', error_description: 'The openid scope is required' },
    });
  });

  // RFC 9449 §7.1: algs lists the algs the proof check accepts, which are the configured ones it can verify.
  it('should list in the DPoP challenge only the configured algs the checks can verify', async () => {
    Object.assign(config, { dpopSigningAlgValuesSupported: ['HS256', 'ES256', 'PS256'] });
    const accessToken = await storeToken((await dpopKey()).jkt);

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `DPoP ${accessToken}` } }));

    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="UserInfo", DPoP algs="ES256 PS256", error="invalid_dpop_proof", error_description="A DPoP proof is required with the DPoP authorization scheme"',
    );
  });
});

describe('verifyDpopUserInfoAccess', () => {
  // RFC 9449 §7.2: a DPoP-bound token MUST be rejected as a Bearer token. Bearer was the scheme
  // used, so its challenge carries the error (RFC 9449 Figure 18).
  it('should reject a DPoP-bound token presented in the Bearer header, with the error in the Bearer challenge', async () => {
    const accessToken = await storeToken((await dpopKey()).jkt);

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } }));

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await answerOf(response)).toEqual({
      status: 401,
      challenge: 'Bearer realm="UserInfo", error="invalid_token", error_description="A DPoP-bound access token must be presented with the DPoP scheme"',
      body: { error: 'invalid_token', error_description: 'A DPoP-bound access token must be presented with the DPoP scheme' },
    });
  });

  // RFC 6750 §2.2: the form body is a Bearer method too.
  it('should reject a DPoP-bound token sent in the form body', async () => {
    const accessToken = await storeToken((await dpopKey()).jkt);

    const response = await POST(formPost({ access_token: accessToken }, {}));

    expect(await answerOf(response)).toEqual({
      status: 401,
      challenge: 'Bearer realm="UserInfo", error="invalid_token", error_description="A DPoP-bound access token must be presented with the DPoP scheme"',
      body: { error: 'invalid_token', error_description: 'A DPoP-bound access token must be presented with the DPoP scheme' },
    });
  });

  // RFC 9449 §7.1: the key of the proof must be the key the token is bound to.
  it('should reject a proof of another key than the one the token is bound to, with the error in the DPoP challenge', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken((await dpopKey()).jkt);

    const response = await GET(await dpopGet(key, accessToken));

    expect(await answerOf(response)).toEqual({
      status: 401,
      challenge: `${DPOP_CHALLENGES}, error="invalid_token", error_description="The access token is bound to a different DPoP key"`,
      body: { error: 'invalid_token', error_description: 'The access token is bound to a different DPoP key' },
    });
  });

  it('should reject an unbound token presented with the DPoP scheme', async () => {
    const accessToken = await storeToken();

    const response = await GET(await dpopGet(await dpopKey(), accessToken));

    expect(await answerOf(response)).toEqual({
      status: 401,
      challenge: `${DPOP_CHALLENGES}, error="invalid_token", error_description="The access token is not bound to a DPoP key"`,
      body: { error: 'invalid_token', error_description: 'The access token is not bound to a DPoP key' },
    });
  });

  it('should answer an unbound token presented as a Bearer token as before', async () => {
    const accessToken = await storeToken();

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } }));

    expect([response.status, await response.json()]).toEqual([200, CLAIMS]);
  });
});

describe('an access token bound at the token endpoint', () => {
  // RFC 9449 §5 / §6.1 / §7: the token endpoint binds the access token to the key of its proof
  // (the stored record keeps cnf.jkt), and UserInfo then takes it with the DPoP scheme and a
  // proof of that key only.
  it('should be answered with the DPoP scheme and a proof of its key, and rejected as a Bearer token', async () => {
    const key = await dpopKey();
    const code = unique('dpop-userinfo-code');
    const now = Math.floor(Date.now() / 1000);
    const storedCode: AuthorizationCodeData = {
      code,
      grantId: unique('grant'),
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      redirectUriExplicit: true,
      scope: ['openid', 'email'],
      subject: SUBJECT,
      used: false,
      expiresAt: now + 300,
      authTime: now - 600,
      nonce: 'nonce-1',
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: 'S256',
    };
    await stores.authCodeStore.set(code, storedCode);
    const tokenResponse = await token(
      new Request(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
          DPoP: await dpopProof(key, { htm: 'POST', htu: TOKEN_ENDPOINT }),
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER }).toString(),
      }),
    );
    const { access_token: accessToken, token_type: tokenType } = (await tokenResponse.json()) as { access_token: string; token_type: string };
    const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken });

    const dpopResponse = await GET(requestTo('/userinfo', { headers: { Authorization: `DPoP ${accessToken}`, DPoP: proof } }));
    const bearerResponse = await GET(requestTo('/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } }));

    expect([tokenType, dpopResponse.status, await dpopResponse.json()]).toEqual(['DPoP', 200, CLAIMS]);
    expect([bearerResponse.status, bearerResponse.headers.get('WWW-Authenticate')]).toEqual([
      401,
      'Bearer realm="UserInfo", error="invalid_token", error_description="A DPoP-bound access token must be presented with the DPoP scheme"',
    ]);
  });
});
