import type { AccessTokenInfo } from '@maronn-openid-connect/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, requestTo } from '../../../../test-support/context';
import { dpopKey, dpopProof, type DpopKey } from '../../../../test-support/dpop';
import { GET, POST } from '../../../userinfo/route';
import { createDatabase, registerClient, registerUser } from '../../db';
import { clientResolver, stores } from '../../provider';

// provider.ts keeps its clients, users and stores in the key-value store of
// db/ (in memory for the tests, vitest.config.ts) for the whole file, so every
// test stores an access token of its own.

const USERINFO_ENDPOINT = `${TEST_ISSUER}/userinfo`;
const ALGS = 'algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"';
const SUBJECT = 'dpop-alice';
const CLIENT_ID = 'dpop-userinfo-client';
const CLAIMS = { sub: SUBJECT, email: 'alice@example.com', email_verified: true };

beforeAll(async () => {
  await registerUser(createDatabase(), { sub: SUBJECT, name: 'Alice Example', email: 'alice@example.com', email_verified: true });
  await registerClient(createDatabase(), {
    clientId: CLIENT_ID,
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethods: ['none'],
  });
});

afterEach(() => vi.restoreAllMocks());

let sequence = 0;

/** Store an access token of its own for the client and the End-User, bound to boundJkt when given, and return it. */
async function storeToken(boundJkt?: string, overrides: Partial<AccessTokenInfo> = {}): Promise<string> {
  sequence += 1;
  const accessToken = `dpop-userinfo-token-${sequence}`;
  await stores.accessTokenStore.set(accessToken, {
    sub: SUBJECT,
    scope: ['openid', 'email'],
    clientId: CLIENT_ID,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    audience: [USERINFO_ENDPOINT],
    ...(boundJkt === undefined ? {} : { cnf: { jkt: boundJkt }, tokenType: 'DPoP' }),
    ...overrides,
  });
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

describe('readDpopUserInfoRequest', () => {
  // RFC 9449 §7.1: Authorization: DPoP <token> with a proof carrying ath.
  it('should answer a DPoP-bound token presented with the DPoP scheme and a proof of its key', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);

    const response = await GET(await dpopGet(key, accessToken));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(CLAIMS);
  });

  it('should accept the DPoP scheme on a POST, with the proof bound to POST', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken });

    const response = await POST(formPost({}, { Authorization: `DPoP ${accessToken}`, DPoP: proof }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLAIMS);
  });

  it('should leave a Bearer token of an unbound access token to the Bearer block', async () => {
    const accessToken = await storeToken();

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLAIMS);
  });

  it('should reject the DPoP scheme without a proof, with a DPoP challenge', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `DPoP ${accessToken}` } }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
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
    const accessToken = await storeToken(key.jkt);

    const response = await GET(await dpopGet(key, accessToken, overrides));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof', error_description: description });
  });

  it('should reject the same proof sent twice', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const request = await dpopGet(key, accessToken);
    await GET(request.clone());

    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error_description: string }).error_description).toBe('The DPoP proof has already been used');
  });

  // RFC 6750 §2: one method per request. The DPoP block reads the form body once.
  it('should reject a DPoP token sent with another token in the form body', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);
    const proof = await dpopProof(key, { htm: 'POST', htu: USERINFO_ENDPOINT, accessToken });

    const response = await POST(formPost({ access_token: accessToken }, { Authorization: `DPoP ${accessToken}`, DPoP: proof }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' });
  });

  it('should reject the DPoP scheme without a token', async () => {
    const response = await GET(requestTo('/userinfo', { headers: { Authorization: 'DPoP' } }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_request');
  });

  // RFC 9449 §7.1: the failures of the later blocks answer with the DPoP challenge too.
  it('should answer an expired DPoP token with a DPoP challenge', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt, { expiresAt: Math.floor(Date.now() / 1000) - 10 });

    const response = await GET(await dpopGet(key, accessToken));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toMatch(/^DPoP realm="UserInfo", error="invalid_token", error_description="[^"]+", algs="ES256 /);
  });
});

describe('verifyDpopUserInfoAccess', () => {
  // RFC 9449 §7.2: a DPoP-bound token must not be usable as a Bearer token.
  it('should reject a DPoP-bound token presented as a Bearer token', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } }));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `DPoP error="invalid_token", error_description="A DPoP-bound access token must be presented with the DPoP scheme", ${ALGS}`,
    );
    expect(await response.json()).toEqual({
      error: 'invalid_token',
      error_description: 'A DPoP-bound access token must be presented with the DPoP scheme',
    });
  });

  it('should reject a DPoP-bound token sent as access_token in a form body', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken(key.jkt);

    const response = await POST(formPost({ access_token: accessToken }, {}));

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_token');
  });

  // RFC 9449 §7.1: the key of the proof must be the key the token is bound to.
  it('should reject a proof of another key than the one the token is bound to', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken((await dpopKey()).jkt);

    const response = await GET(await dpopGet(key, accessToken));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'The access token is bound to a different DPoP key' });
  });

  it('should reject a Bearer token presented with the DPoP scheme', async () => {
    const key = await dpopKey();
    const accessToken = await storeToken();

    const response = await GET(await dpopGet(key, accessToken));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'The access token is not bound to a DPoP key' });
  });
});

// RFC 6750 §2 / §3: the Bearer answers of the endpoint, unchanged by the DPoP blocks.
describe('the Bearer answers of the UserInfo endpoint', () => {
  it('should challenge a request without a token with the realm alone', async () => {
    const response = await GET(requestTo('/userinfo'));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="UserInfo"');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'Access token is required' });
  });

  it('should reject a Bearer token sent in the header and the form body', async () => {
    const accessToken = await storeToken();

    const response = await POST(formPost({ access_token: accessToken }, { Authorization: `Bearer ${accessToken}` }));

    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="UserInfo", error="invalid_request"');
    expect(await response.json()).toEqual({ error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' });
  });

  it('should answer a token sent as access_token in a form body', async () => {
    const accessToken = await storeToken();

    const response = await POST(formPost({ access_token: accessToken }, {}));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLAIMS);
  });

  it('should answer an unknown token with the Bearer challenge of invalid_token', async () => {
    const response = await GET(requestTo('/userinfo', { headers: { Authorization: 'Bearer unknown-token' } }));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toMatch(/^Bearer realm="UserInfo", error="invalid_token", error_description="[^"]+"$/);
  });

  // OIDC Core 1.0 §5.3.2: a client that registered userinfo_signed_response_alg gets a signed JWT.
  it.each([
    ['RS256', 200, 'application/jwt'],
    ['ES256', 500, 'application/json'],
  ])('should answer a client that registered userinfo_signed_response_alg %s with %i', async (alg, status, contentType) => {
    const findClient = clientResolver.findClient.bind(clientResolver);
    vi.spyOn(clientResolver, 'findClient').mockImplementation(async (id: string) => {
      const client = await findClient(id);
      return client === null ? null : { ...client, userinfoSignedResponseAlg: alg };
    });
    const accessToken = await storeToken();

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } }));

    expect(response.status).toBe(status);
    expect(response.headers.get('Content-Type')).toContain(contentType);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
  });

  it('should name the alg without a UserInfo signing key in the server_error', async () => {
    const findClient = clientResolver.findClient.bind(clientResolver);
    vi.spyOn(clientResolver, 'findClient').mockImplementation(async (id: string) => {
      const client = await findClient(id);
      return client === null ? null : { ...client, userinfoSignedResponseAlg: 'ES256' };
    });
    const accessToken = await storeToken();

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } }));

    expect(await response.json()).toEqual({ error: 'server_error', error_description: 'No UserInfo signing key registered for alg "ES256"' });
  });

  it('should answer a token without the openid scope with insufficient_scope', async () => {
    const accessToken = await storeToken(undefined, { scope: ['email'] });

    const response = await GET(requestTo('/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } }));

    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toMatch(/^Bearer realm="UserInfo", error="insufficient_scope"/);
  });
});
