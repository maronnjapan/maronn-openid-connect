import type { AccessTokenInfo } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { TEST_ISSUER, formPost, requestTo } from '../../../../test-support/context.js';
import { dpopKey, dpopProof, type DpopKey } from '../../../../test-support/dpop.js';
import { providerApp } from '../../../../test-support/screens.js';
import { registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { createProviderStores } from '../../../db/memory/stores.js';
import { registerUser } from '../../../db/memory/users.js';

const USERINFO_ENDPOINT = `${TEST_ISSUER}/userinfo`;
const ALGS = 'algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"';
const CLAIMS = { sub: 'alice', email: 'alice@example.com', email_verified: true };

function tokenInfo(overrides: Partial<AccessTokenInfo> & { cnf?: Record<string, string>; tokenType?: string } = {}) {
  return {
    sub: 'alice',
    scope: ['openid', 'email'],
    clientId: 'client-1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    audience: ['https://op.example.com/userinfo'],
    ...overrides,
  };
}

/** The app with alice, a client, and token-1 issued to the client for alice, bound to key when given. */
async function setUp(key?: DpopKey, overrides: Partial<AccessTokenInfo> = {}) {
  const db = createEmptyDatabase();
  await registerUser(db, { sub: 'alice', name: 'Alice Example', email: 'alice@example.com', email_verified: true });
  await registerClient(db, {
    clientId: 'client-1',
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethods: ['none'],
  });
  const binding = key === undefined ? {} : { cnf: { jkt: key.jkt }, tokenType: 'DPoP' };
  await createProviderStores(db).accessTokenStore.set('token-1', tokenInfo({ ...binding, ...overrides }));
  return providerApp(db);
}

async function dpopGet(key: DpopKey, overrides: Record<string, unknown> = {}, token = 'token-1'): Promise<Request> {
  const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken: token }, overrides);
  return requestTo('/userinfo', { headers: { Authorization: `DPoP ${token}`, DPoP: proof } });
}

describe('readDpopUserInfoRequest', () => {
  // RFC 9449 §7.1: Authorization: DPoP <token> with a proof carrying ath.
  it('should answer a DPoP-bound token presented with the DPoP scheme and a proof of its key', async () => {
    const key = await dpopKey();
    const app = await setUp(key);

    const response = await app.request(await dpopGet(key));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLAIMS);
  });

  it('should accept the DPoP scheme on a POST, with the proof bound to POST', async () => {
    const key = await dpopKey();
    const app = await setUp(key);
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken: 'token-1' });

    const response = await app.request(formPost('/userinfo', {}, { Authorization: 'DPoP token-1', DPoP: proof }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLAIMS);
  });

  it('should leave a Bearer token of an unbound access token to the Bearer steps', async () => {
    const app = await setUp();

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'Bearer token-1' } }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLAIMS);
  });

  it('should reject the DPoP scheme without a proof, with a DPoP challenge', async () => {
    const key = await dpopKey();
    const app = await setUp(key);

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'DPoP token-1' } }));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `DPoP error="invalid_dpop_proof", error_description="A DPoP proof is required with the DPoP authorization scheme", ${ALGS}`,
    );
    expect(await response.json()).toEqual({
      error: 'invalid_dpop_proof',
      error_description: 'A DPoP proof is required with the DPoP authorization scheme',
    });
  });

  it.each([
    ['the ath of another token', { ath: 'fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo' }, 'The DPoP proof ath claim does not match the access token'],
    ['no ath', { ath: undefined }, 'The DPoP proof ath claim does not match the access token'],
    ['the htu of the token endpoint', { htu: `${TEST_ISSUER}/token` }, 'The DPoP proof htu claim does not match the request URI'],
  ])('should reject a proof with %s', async (_name, overrides, description) => {
    const key = await dpopKey();
    const app = await setUp(key);

    const response = await app.request(await dpopGet(key, overrides));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof', error_description: description });
  });

  it('should reject the same proof sent twice', async () => {
    const key = await dpopKey();
    const app = await setUp(key);
    const request = await dpopGet(key);
    await app.request(request.clone());

    const response = await app.request(request);

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error_description: string }).error_description).toBe('The DPoP proof has already been used');
  });

  // RFC 6750 §2: one method per request.
  it('should reject a DPoP token sent with another token in the form body', async () => {
    const key = await dpopKey();
    const app = await setUp(key);
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken: 'token-1' });

    const response = await app.request(formPost('/userinfo', { access_token: 'token-1' }, { Authorization: 'DPoP token-1', DPoP: proof }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' });
  });

  it('should reject the DPoP scheme without a token', async () => {
    const app = await setUp();

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'DPoP' } }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_request');
  });

  // RFC 9449 §7.1: the failures of the later steps answer with the DPoP challenge too.
  it('should answer an expired DPoP token with a DPoP challenge', async () => {
    const key = await dpopKey();
    const app = await setUp(key, { expiresAt: Math.floor(Date.now() / 1000) - 10 });

    const response = await app.request(await dpopGet(key));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toMatch(/^DPoP realm="UserInfo", error="invalid_token", error_description="[^"]+", algs="ES256 /);
  });
});
