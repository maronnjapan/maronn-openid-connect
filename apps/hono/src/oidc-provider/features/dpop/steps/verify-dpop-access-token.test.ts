import type { AccessTokenInfo } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, formPost, requestTo } from '../../../../test-support/context.js';
import { dpopKey, dpopProof, type DpopKey } from '../../../../test-support/dpop.js';
import { providerApp } from '../../../../test-support/screens.js';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  NOW,
  REDIRECT_URI,
  SUBJECT,
  basicAuthorization,
  confidentialClient,
  storedAuthorizationCode,
} from '../../../../test-support/token.js';
import { registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { createProviderStores } from '../../../db/memory/stores.js';
import { registerUser } from '../../../db/memory/users.js';

const USERINFO_ENDPOINT = `${TEST_ISSUER}/userinfo`;
const TOKEN_ENDPOINT = `${TEST_ISSUER}/token`;
/** The challenges of a request that presented its token with the DPoP scheme, before the error: Bearer, then DPoP with the default algs. */
const DPOP_CHALLENGES = 'Bearer realm="UserInfo", DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"';
// RFC 7636 §4.1 / §4.2: a 46-character verifier and its S256 challenge.
const CODE_VERIFIER = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const CODE_CHALLENGE = 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU';

/** The app with alice, the public client client-1, and token-1 issued to the client for alice, bound to boundJkt when given. */
async function setUp(boundJkt?: string) {
  const db = createEmptyDatabase();
  await registerUser(db, { sub: 'alice', email: 'alice@example.com', email_verified: true });
  await registerClient(db, {
    clientId: 'client-1',
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethods: ['none'],
  });
  const record: AccessTokenInfo = {
    sub: 'alice',
    scope: ['openid', 'email'],
    clientId: 'client-1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    audience: [USERINFO_ENDPOINT],
  };
  const bound = { ...record, cnf: { jkt: boundJkt }, tokenType: 'DPoP' };
  await createProviderStores(db).accessTokenStore.set('token-1', boundJkt === undefined ? record : bound);
  return providerApp(db);
}

/** A GET of /userinfo with token-1 in the DPoP scheme and a proof of key for it. */
async function dpopGet(key: DpopKey): Promise<Request> {
  const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken: 'token-1' });
  return requestTo('/userinfo', { headers: { Authorization: 'DPoP token-1', DPoP: proof } });
}

describe('verifyDpopUserInfoAccess', () => {
  // RFC 9449 §7.2: a DPoP-bound token MUST be rejected as a Bearer token. Bearer was the scheme
  // used, so its challenge carries the error (RFC 9449 Figure 18).
  it('should reject a DPoP-bound token presented in the Bearer header, with the error in the Bearer challenge', async () => {
    const key = await dpopKey();
    const app = await setUp(key.jkt);

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'Bearer token-1' } }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="UserInfo", error="invalid_token", error_description="A DPoP-bound access token must be presented with the DPoP scheme"',
    );
    expect(await response.json()).toEqual({
      error: 'invalid_token',
      error_description: 'A DPoP-bound access token must be presented with the DPoP scheme',
    });
  });

  // RFC 6750 §2.2: the form body is a Bearer method too.
  it('should reject a DPoP-bound token sent in the form body', async () => {
    const key = await dpopKey();
    const app = await setUp(key.jkt);

    const response = await app.request(formPost('/userinfo', { access_token: 'token-1' }));

    expect([response.status, response.headers.get('WWW-Authenticate'), await response.json()]).toEqual([
      401,
      'Bearer realm="UserInfo", error="invalid_token", error_description="A DPoP-bound access token must be presented with the DPoP scheme"',
      { error: 'invalid_token', error_description: 'A DPoP-bound access token must be presented with the DPoP scheme' },
    ]);
  });

  // RFC 9449 §7.1: the key of the proof must be the key the token is bound to.
  it('should reject a proof of another key than the one the token is bound to, with the error in the DPoP challenge', async () => {
    const key = await dpopKey();
    const app = await setUp((await dpopKey()).jkt);

    const response = await app.request(await dpopGet(key));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `${DPOP_CHALLENGES}, error="invalid_token", error_description="The access token is bound to a different DPoP key"`,
    );
    expect(await response.json()).toEqual({
      error: 'invalid_token',
      error_description: 'The access token is bound to a different DPoP key',
    });
  });

  it('should reject an unbound token presented with the DPoP scheme', async () => {
    const app = await setUp();

    const response = await app.request(await dpopGet(await dpopKey()));

    expect([response.status, response.headers.get('WWW-Authenticate'), await response.json()]).toEqual([
      401,
      `${DPOP_CHALLENGES}, error="invalid_token", error_description="The access token is not bound to a DPoP key"`,
      { error: 'invalid_token', error_description: 'The access token is not bound to a DPoP key' },
    ]);
  });

  it('should answer an unbound token presented as a Bearer token as before', async () => {
    const app = await setUp();

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'Bearer token-1' } }));

    expect([response.status, await response.json()]).toEqual([200, { sub: 'alice', email: 'alice@example.com', email_verified: true }]);
  });
});

describe('an access token bound at the token endpoint', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // RFC 9449 §5 / §6.1 / §7: the token endpoint binds the access token to the key of its proof
  // (the stored record keeps cnf.jkt), and UserInfo then takes it with the DPoP scheme and a
  // proof of that key only.
  it('should be answered with the DPoP scheme and a proof of its key, and rejected as a Bearer token', async () => {
    const key = await dpopKey();
    const db = createEmptyDatabase();
    await registerUser(db, { sub: SUBJECT, email: 'user-1@example.com', email_verified: true });
    await registerClient(db, confidentialClient());
    await createProviderStores(db).authCodeStore.set(
      'code-1',
      storedAuthorizationCode({ scope: ['openid', 'email'], codeChallenge: CODE_CHALLENGE, codeChallengeMethod: 'S256' }),
    );
    const app = await providerApp(db);
    const tokenResponse = await app.request(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthorization(CLIENT_ID, CLIENT_SECRET),
        DPoP: await dpopProof(key, { htm: 'POST', htu: TOKEN_ENDPOINT }),
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER }).toString(),
    });
    const { access_token: accessToken, token_type: tokenType } = (await tokenResponse.json()) as { access_token: string; token_type: string };
    const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken });

    const dpopResponse = await app.request(requestTo('/userinfo', { headers: { Authorization: `DPoP ${accessToken}`, DPoP: proof } }));
    const bearerResponse = await app.request(requestTo('/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } }));

    expect([tokenType, dpopResponse.status, await dpopResponse.json()]).toEqual([
      'DPoP',
      200,
      { sub: SUBJECT, email: 'user-1@example.com', email_verified: true },
    ]);
    expect([bearerResponse.status, bearerResponse.headers.get('WWW-Authenticate')]).toEqual([
      401,
      'Bearer realm="UserInfo", error="invalid_token", error_description="A DPoP-bound access token must be presented with the DPoP scheme"',
    ]);
  });
});
