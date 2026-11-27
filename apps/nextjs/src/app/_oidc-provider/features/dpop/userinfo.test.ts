import type { AccessTokenInfo, AuthorizationCodeData } from '@maronn-openid-connect/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
/** The challenges of a request that sent its token with both Bearer and DPoP: both carry the error (RFC 9449 Figure 19). */
const MULTIPLE_METHODS_CHALLENGES =
  'Bearer realm="UserInfo", error="invalid_request", error_description="Multiple access token methods are not allowed", ' +
  'DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA", error="invalid_request", error_description="Multiple access token methods are not allowed"';
/** The challenges of a bound token presented as a Bearer token: the error in the Bearer challenge, the DPoP challenge without it (RFC 9449 Figure 18). */
const BEARER_DOWNGRADE_CHALLENGES =
  'Bearer realm="UserInfo", error="invalid_token", error_description="A DPoP-bound access token must be presented with the DPoP scheme", ' +
  'DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"';
const SUBJECT = 'dpop-userinfo-alice';
const CLIENT_ID = 'dpop-userinfo-client';
const CLIENT_SECRET = 'dpop-userinfo-client-secret';
const REDIRECT_URI = 'https://rp.example.com/callback';
const CLAIMS = { sub: SUBJECT, email: 'alice@example.com', email_verified: true };
// RFC 7636 §4.1 / §4.2: a 46-character verifier and its S256 challenge.
const CODE_VERIFIER = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const CODE_CHALLENGE = 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU';
const SAVED_ALGS = config.dpopSigningAlgValuesSupported;
const SAVED_NONCE_SETTINGS = {
  dpopNonceRequiredAtAuthorizationServer: config.dpopNonceRequiredAtAuthorizationServer,
  dpopNonceRequiredAtResourceServer: config.dpopNonceRequiredAtResourceServer,
};
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
  // RFC 6750 §2.1 / RFC 9449 §7.2: a Bearer request is left to the Bearer block, whose failures also offer the DPoP scheme.
  it('should add the DPoP challenge to a request that does not use the DPoP scheme, and leave its token to the Bearer block', async () => {
    const challenges: UserInfoChallenges = { offered: [BEARER_CHALLENGE], scheme: 'Bearer' };

    const read = await readDpopUserInfoRequest(requestTo('/userinfo', { headers: { Authorization: 'Bearer token-1' } }), challenges);

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
    const response = await GET(requestTo('/userinfo'));

    expect(await answerOf(response)).toEqual({
      status: 401,
      challenge: 'Bearer realm="UserInfo", DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"',
      body: { error: 'invalid_token', error_description: 'Access token is required' },
    });
  });

  // RFC 9449 §7.2 Figure 18: the token was presented with the Bearer scheme, so the Bearer challenge carries the error.
  it('should answer an unknown Bearer token with the error in the Bearer challenge and the DPoP challenge without it', async () => {
    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `Bearer ${unique('dpop-userinfo-unknown')}` } }));

    expect([response.status, response.headers.get('WWW-Authenticate')]).toEqual([
      401,
      'Bearer realm="UserInfo", error="invalid_token", error_description="Access token is invalid", ' +
        'DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"',
    ]);
  });

  // RFC 6750 §2: the header and the form body are both Bearer methods, so the scheme is not ambiguous.
  it('should answer a Bearer token sent in the header and in the form body with the error in the Bearer challenge alone', async () => {
    const accessToken = await storeToken();

    const response = await POST(formPost({ access_token: accessToken }, { Authorization: `Bearer ${accessToken}` }));

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
    const accessToken = await storeToken(key.jkt);
    const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken });
    const headers = new Headers({ DPoP: proof });
    headers.append('Authorization', `${first} ${accessToken}`);
    headers.append('Authorization', `${second} ${accessToken}`);

    const response = await GET(requestTo('/userinfo', { headers }));

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await answerOf(response)).toEqual({
      status: 400,
      challenge: MULTIPLE_METHODS_CHALLENGES,
      body: { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
    });
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

  // RFC 6750 §2.2 / RFC 9449 §7.2 Figure 19: a token of the form body is a Bearer token, so the request sent
  // its token with both schemes, and both challenges carry the error.
  it('should reject a DPoP token sent with another token in the form body, with the error in both challenges', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken });

    const response = await POST(formPost({ access_token: accessToken }, { Authorization: `DPoP ${accessToken}`, DPoP: proof }));

    expect(await answerOf(response)).toEqual({
      status: 400,
      challenge: MULTIPLE_METHODS_CHALLENGES,
      body: { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
    });
  });

  // RFC 9449 §7.2 Figure 19: the form body is a Bearer method whatever the DPoP credentials are, as a
  // Bearer field without a token beside a DPoP field is.
  it.each(['DPoP', 'DPoP token-1 token-1'])(
    'should reject "%s" sent with a token in the form body with 400 and the error in both challenges',
    async (authorization) => {
      const accessToken = await storeToken();

      const response = await POST(formPost({ access_token: accessToken }, { Authorization: authorization }));

      expect(await answerOf(response)).toEqual({
        status: 400,
        challenge: MULTIPLE_METHODS_CHALLENGES,
        body: { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
      });
    },
  );

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
      challenge: MULTIPLE_METHODS_CHALLENGES,
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

  // RFC 9449 Figure 12: the credentials are one token68. Two DPoP fields name one scheme, and the proof
  // is a good one for the whole value, so only the token68 check rejects the request.
  it('should reject credentials that are not one token68 with 400 invalid_request', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const credentials = `${accessToken}, DPoP ${accessToken}`;
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
  // used, so its challenge carries the error, and the DPoP challenge follows without it (RFC 9449 Figure 18).
  it('should reject a DPoP-bound token presented in the Bearer header, with the error in the Bearer challenge', async () => {
    const accessToken = await storeToken((await dpopKey()).jkt);

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } }));

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await answerOf(response)).toEqual({
      status: 401,
      challenge: BEARER_DOWNGRADE_CHALLENGES,
      body: { error: 'invalid_token', error_description: 'A DPoP-bound access token must be presented with the DPoP scheme' },
    });
  });

  // RFC 6750 §2.2: the form body is a Bearer method too.
  it('should reject a DPoP-bound token sent in the form body', async () => {
    const accessToken = await storeToken((await dpopKey()).jkt);

    const response = await POST(formPost({ access_token: accessToken }, {}));

    expect(await answerOf(response)).toEqual({
      status: 401,
      challenge: BEARER_DOWNGRADE_CHALLENGES,
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
      BEARER_DOWNGRADE_CHALLENGES,
    ]);
  });
});

describe('readDpopUserInfoRequest with dpopNonceRequiredAtResourceServer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    vi.stubEnv('OIDC_DPOP_NONCE_SECRET', NONCE_SECRET);
    config.dpopNonceRequiredAtResourceServer = true;
  });

  afterEach(() => {
    Object.assign(config, SAVED_NONCE_SETTINGS);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** Makes crypto.getRandomValues() fill its array with RANDOM. */
  function fixRandomBytes(): void {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint8Array).set(RANDOM);
      return array;
    });
  }

  // RFC 9449 §9 Figure 24: 401 use_dpop_nonce in the DPoP challenge, with the nonce to use in DPoP-Nonce, which a browser may read.
  it('should answer a DPoP proof without a nonce with 401 use_dpop_nonce in the DPoP challenge and the nonce to use', async () => {
    const key = await dpopKey();
    const request = await dpopGet(key, await storeToken(key.jkt));
    request.headers.set('Origin', 'https://rp.example.com');
    fixRandomBytes();

    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(`${DPOP_CHALLENGES}, error="use_dpop_nonce", error_description="${NONCE_REQUIRED}"`);
    expect(await response.json()).toEqual({ error: 'use_dpop_nonce', error_description: NONCE_REQUIRED });
    expect(response.headers.get('DPoP-Nonce')).toBe(RESOURCE_SERVER_NONCE_AT_NOW);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('WWW-Authenticate,DPoP-Nonce');
  });

  // RFC 9449 §9 / §8.2: the retry with the nonce succeeds, and the 200 carries the nonce to use next.
  it('should answer the retry with the nonce it gave, with the next nonce', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const nonce = (await GET(await dpopGet(key, accessToken))).headers.get('DPoP-Nonce') ?? '';

    const retry = await GET(await dpopGet(key, accessToken, { nonce }));

    expect([retry.status, await retry.json()]).toEqual([200, CLAIMS]);
    expect(retry.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
    expect(retry.headers.get('DPoP-Nonce')).not.toBe(nonce);
  });

  // RFC 9449 §8 / §9: the server keeps a window of recent nonces (dpopNonceLifetimeSeconds, 120 by default).
  it('should accept a nonce it issued a minute ago, and give the nonce it issues now', async () => {
    const key = await dpopKey();
    const request = await dpopGet(key, await storeToken(key.jkt), { nonce: RESOURCE_SERVER_NONCE_A_MINUTE_AGO });
    fixRandomBytes();

    const response = await GET(request);

    expect([response.status, await response.json(), response.headers.get('DPoP-Nonce')]).toEqual([200, CLAIMS, RESOURCE_SERVER_NONCE_AT_NOW]);
  });

  it('should reject a nonce older than dpopNonceLifetimeSeconds and give a new one', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const nonce = (await GET(await dpopGet(key, accessToken))).headers.get('DPoP-Nonce') ?? '';
    vi.setSystemTime((NOW + 121) * 1000);

    const response = await GET(await dpopGet(key, accessToken, { nonce }));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(`${DPOP_CHALLENGES}, error="use_dpop_nonce", error_description="${STALE_NONCE}"`);
    expect(response.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
    expect(response.headers.get('DPoP-Nonce')).not.toBe(nonce);
  });

  // RFC 9449 §9: the nonces of the authorization server and of the resource server are not the same.
  it('should reject a nonce of the authorization server', async () => {
    const key = await dpopKey();

    const response = await GET(await dpopGet(key, await storeToken(key.jkt), { nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW }));

    expect([response.status, await response.json()]).toEqual([401, { error: 'use_dpop_nonce', error_description: STALE_NONCE }]);
  });

  // RFC 9449 §9: a nonce given by the token endpoint is not one of the protected resource, and the other way round.
  it('should not accept a nonce of the token endpoint at UserInfo, nor a nonce of UserInfo at the token endpoint', async () => {
    config.dpopNonceRequiredAtAuthorizationServer = true;
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const tokenRequest = async (claims: Record<string, unknown>) =>
      token(
        new Request(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: await dpopProof(key, { htm: 'POST', htu: TOKEN_ENDPOINT }, claims) },
          body: new URLSearchParams({ grant_type: 'authorization_code', code: unique('dpop-userinfo-code') }).toString(),
        }),
      );
    const tokenEndpointNonce = (await tokenRequest({})).headers.get('DPoP-Nonce') ?? '';
    const userInfoNonce = (await GET(await dpopGet(key, accessToken))).headers.get('DPoP-Nonce') ?? '';

    const atUserInfo = await GET(await dpopGet(key, accessToken, { nonce: tokenEndpointNonce }));
    const atTokenEndpoint = await tokenRequest({ nonce: userInfoNonce });

    expect([atUserInfo.status, await atUserInfo.json()]).toEqual([401, { error: 'use_dpop_nonce', error_description: STALE_NONCE }]);
    expect([atTokenEndpoint.status, await atTokenEndpoint.json()]).toEqual([
      400,
      { error: 'use_dpop_nonce', error_description: 'The DPoP proof nonce is not a nonce the authorization server recently provided' },
    ]);
  });

  // RFC 9449 §8.2 / §9: every response to a request presented with the DPoP scheme carries the nonce to use next, the other errors too.
  it.each([
    ['no proof', async (_key: DpopKey, accessToken: string) => requestTo('/userinfo', { headers: { Authorization: `DPoP ${accessToken}` } }), {}, 401, 'invalid_dpop_proof'],
    [
      'a proof for another URI',
      async (key: DpopKey, accessToken: string) =>
        requestTo('/userinfo', {
          headers: {
            Authorization: `DPoP ${accessToken}`,
            DPoP: await dpopProof(key, { htm: 'GET', htu: TOKEN_ENDPOINT, accessToken }, { nonce: RESOURCE_SERVER_NONCE_AT_NOW }),
          },
        }),
      {},
      401,
      'invalid_dpop_proof',
    ],
    [
      'another token in the form body',
      async (key: DpopKey, accessToken: string) =>
        formPost(
          { access_token: accessToken },
          { Authorization: `DPoP ${accessToken}`, DPoP: await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken }) },
        ),
      {},
      400,
      'invalid_request',
    ],
    [
      'a token bound to another key',
      async (_key: DpopKey, accessToken: string) => dpopGet(await dpopKey(), accessToken, { nonce: RESOURCE_SERVER_NONCE_AT_NOW }),
      {},
      401,
      'invalid_token',
    ],
    [
      'a token without the openid scope',
      async (key: DpopKey, accessToken: string) => dpopGet(key, accessToken, { nonce: RESOURCE_SERVER_NONCE_AT_NOW }),
      { scope: ['email'] },
      403,
      'insufficient_scope',
    ],
  ])('should give the nonce to use next with the error of a request with %s', async (_name, requestOf, tokenOverrides: Partial<AccessTokenInfo>, status, error) => {
    const key = await dpopKey();
    const request = await requestOf(key, await storeToken(key.jkt, tokenOverrides));
    fixRandomBytes();

    const response = request.method === 'POST' ? await POST(request) : await GET(request);

    expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([status, error]);
    expect(response.headers.get('DPoP-Nonce')).toBe(RESOURCE_SERVER_NONCE_AT_NOW);
  });

  // A request that does not present its token with the DPoP scheme is given no nonce and asked for none.
  it.each([
    ['a Bearer token', 'Bearer', 200],
    ['no token', undefined, 401],
  ])('should give no nonce to a request with %s', async (_name, scheme, status) => {
    const accessToken = await storeToken();
    const headers: Record<string, string> = scheme === undefined ? {} : { Authorization: `${scheme} ${accessToken}` };

    const response = await GET(requestTo('/userinfo', { headers }));

    expect([response.status, response.headers.has('DPoP-Nonce')]).toEqual([status, false]);
  });

  // RFC 9449 §7.2 Figure 19: a request that names both schemes in Authorization is rejected before the DPoP scheme is read.
  it('should give no nonce to a request that names both Bearer and DPoP in Authorization', async () => {
    const accessToken = await storeToken();

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `Bearer ${accessToken}, DPoP ${accessToken}` } }));

    expect([response.status, response.headers.get('WWW-Authenticate'), response.headers.has('DPoP-Nonce')]).toEqual([400, MULTIPLE_METHODS_CHALLENGES, false]);
  });

  // RFC 9449 §11.3: a server that provides no nonce requires none.
  it.each([
    ['without a nonce', {}],
    ['with a nonce the server never issued', { nonce: 'a-nonce-of-another-server' }],
  ])('should neither give nor require a nonce when dpopNonceRequiredAtResourceServer is false: a proof %s', async (_name, claims) => {
    config.dpopNonceRequiredAtResourceServer = false;
    const key = await dpopKey();

    const response = await GET(await dpopGet(key, await storeToken(key.jkt), claims));

    expect([response.status, await response.json(), response.headers.has('DPoP-Nonce')]).toEqual([200, CLAIMS, false]);
  });

  // RFC 2104 §3: a secret shorter than 32 bytes is a misconfiguration, not a bad request.
  it('should answer server_error when the secret of the DPoP nonces is shorter than 32 bytes', async () => {
    vi.stubEnv('OIDC_DPOP_NONCE_SECRET', 'a'.repeat(31));
    const key = await dpopKey();

    const response = await GET(await dpopGet(key, await storeToken(key.jkt)));

    expect([response.status, await response.json(), response.headers.has('DPoP-Nonce')]).toEqual([500, { error: 'server_error' }, false]);
  });
});
