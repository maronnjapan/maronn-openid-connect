import type { AccessTokenInfo, SigningKeyProvider } from '@maronn-openid-connect/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, requestTo } from '../../test-support/context';
import { accessTokenInfo } from '../../test-support/fixtures';
import { decodeJwt, verifyRs256Jwt } from '../../test-support/jwt';
import { createDatabase, registerClient, registerUser } from '../_oidc-provider/db';
import { clientResolver, loadSigningKeys, resolvers, stores } from '../_oidc-provider/provider';
import { GET, POST } from './route';

// provider.ts keeps its clients, users and stores in the key-value store of
// db/ (in memory for the tests, vitest.config.ts) for the whole file, so every
// test stores an access token of its own.

const USERINFO_ENDPOINT = `${TEST_ISSUER}/userinfo`;
const SUBJECT = 'userinfo-route-alice';
const CLIENT_ID = 'userinfo-route-client';

beforeAll(async () => {
  await registerUser(createDatabase(), {
    sub: SUBJECT,
    name: 'Alice Example',
    email: 'alice@example.com',
    email_verified: true,
  });
  await registerClient(createDatabase(), {
    clientId: CLIENT_ID,
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethods: ['none'],
  });
});

afterEach(() => vi.restoreAllMocks());

let sequence = 0;

/** Store an access token of its own for the client and the End-User, with the members of overrides, and return it. */
async function storeToken(overrides: Partial<AccessTokenInfo> = {}): Promise<string> {
  sequence += 1;
  const accessToken = `userinfo-route-token-${sequence}`;
  await stores.accessTokenStore.set(
    accessToken,
    accessTokenInfo({
      sub: SUBJECT,
      scope: ['openid', 'email'],
      clientId: CLIENT_ID,
      audience: [USERINFO_ENDPOINT],
      ...overrides,
    }),
  );
  return accessToken;
}

/** A GET of /userinfo with the token in the Authorization header of the Bearer scheme. */
function bearerGet(accessToken: string): Request {
  return requestTo('/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
}

/** A POST of a form body to /userinfo with the headers. */
function formPost(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return requestTo('/userinfo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Make the client of the tokens one that registered userinfo_signed_response_alg alg. */
function registerUserinfoSigningAlg(alg: string): void {
  const findClient = clientResolver.findClient.bind(clientResolver);
  vi.spyOn(clientResolver, 'findClient').mockImplementation(async (id: string) => {
    const client = await findClient(id);
    return client === null ? null : { ...client, userinfoSignedResponseAlg: alg };
  });
}

/** Make the client of the tokens one that is no longer registered. */
function unregisterClient(): void {
  vi.spyOn(clientResolver, 'findClient').mockResolvedValue(null);
}

/** Make the signing key provider that provider.ts keeps on globalThis fail to load the keys. */
function failToLoadSigningKeys(): void {
  const registry = globalThis as typeof globalThis & { __oidcSigningKeyProvider: SigningKeyProvider };
  vi.spyOn(registry.__oidcSigningKeyProvider, 'getSigningKeys').mockRejectedValue(new Error('the key store is down'));
}

/** Make the access token resolver find an expired record of the client and the End-User, and return its token. */
function resolveExpiredToken(): string {
  vi.spyOn(resolvers.accessTokenResolver, 'findAccessToken').mockResolvedValue(
    accessTokenInfo({
      sub: SUBJECT,
      scope: ['openid', 'email'],
      clientId: CLIENT_ID,
      audience: [USERINFO_ENDPOINT],
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    }),
  );
  return 'userinfo-route-expired-token';
}

/** The status, the headers the endpoint decides and the body of a JSON answer. */
async function answerOf(response: Response): Promise<{
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  pragma: string | null;
  challenge: string | null;
  body: unknown;
}> {
  return {
    status: response.status,
    contentType: response.headers.get('Content-Type'),
    cacheControl: response.headers.get('Cache-Control'),
    pragma: response.headers.get('Pragma'),
    challenge: response.headers.get('WWW-Authenticate'),
    body: await response.json(),
  };
}

describe('userinfo', () => {
  // OIDC Core 1.0 §5.3.2 / §5.4: the claims of the granted scopes, never cached (RFC 6750 §5.2).
  it('should answer a Bearer token of the Authorization header with the claims of its scopes as uncacheable JSON', async () => {
    const accessToken = await storeToken();

    const response = await GET(bearerGet(accessToken));

    expect(await answerOf(response)).toEqual({
      status: 200,
      contentType: 'application/json',
      cacheControl: 'no-store',
      pragma: 'no-cache',
      challenge: null,
      body: { sub: SUBJECT, email: 'alice@example.com', email_verified: true },
    });
  });

  // RFC 6750 §2.2: the form-encoded body parameter, with the media type read case-insensitively.
  it('should read access_token from a form POST whose media type differs in case and has parameters', async () => {
    const accessToken = await storeToken();

    const response = await POST(
      requestTo('/userinfo', {
        method: 'POST',
        headers: { 'Content-Type': 'Application/X-WWW-Form-URLEncoded; charset=UTF-8' },
        body: new URLSearchParams({ access_token: accessToken }).toString(),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sub: SUBJECT, email: 'alice@example.com', email_verified: true });
  });

  // OIDC Core 1.0 §5.5: the claims requested individually and stored with the token.
  it('should add the claims requested individually with the token', async () => {
    const accessToken = await storeToken({ scope: ['openid'], claims: { userinfo: { name: null } } });

    const response = await GET(bearerGet(accessToken));

    expect(await response.json()).toEqual({ sub: SUBJECT, name: 'Alice Example' });
  });

  // OIDC Core 1.0 §5.3.2: a client that registered userinfo_signed_response_alg gets a JWT signed with that alg.
  it('should answer a signed JWT for a client that registered userinfo_signed_response_alg', async () => {
    registerUserinfoSigningAlg('RS256');
    const accessToken = await storeToken();

    const response = await GET(bearerGet(accessToken));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/jwt');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    const jwt = await response.text();
    const [signingKey] = (await loadSigningKeys()).userinfo;
    expect(decodeJwt(jwt)).toMatchObject({
      header: { alg: 'RS256', typ: 'JWT', kid: signingKey.keyId },
      payload: { iss: TEST_ISSUER, aud: CLIENT_ID, sub: SUBJECT, email: 'alice@example.com' },
    });
    expect(await verifyRs256Jwt(jwt, signingKey.publicJwk)).toBe(true);
  });

  it('should answer JSON when the client of the token is no longer registered', async () => {
    unregisterClient();
    const accessToken = await storeToken();

    const response = await GET(bearerGet(accessToken));

    expect(await answerOf(response)).toEqual({
      status: 200,
      contentType: 'application/json',
      cacheControl: 'no-store',
      pragma: 'no-cache',
      challenge: null,
      body: { sub: SUBJECT, email: 'alice@example.com', email_verified: true },
    });
  });

  it('should answer server_error naming the alg when no UserInfo key has the registered alg', async () => {
    registerUserinfoSigningAlg('ES256');
    const accessToken = await storeToken();

    const response = await GET(bearerGet(accessToken));

    expect(await answerOf(response)).toEqual({
      status: 500,
      contentType: 'application/json',
      cacheControl: 'no-store',
      pragma: 'no-cache',
      challenge: null,
      body: { error: 'server_error', error_description: 'No UserInfo signing key registered for alg "ES256"' },
    });
  });

  // RFC 6750 §3.1: a request without credentials gets a challenge with the realm alone.
  it('should answer a request without a token with 401 and the realm-only challenge', async () => {
    const response = await GET(requestTo('/userinfo'));

    expect(await answerOf(response)).toEqual({
      status: 401,
      contentType: 'application/json',
      cacheControl: 'no-store',
      pragma: 'no-cache',
      challenge: 'Bearer realm="UserInfo"',
      body: { error: 'invalid_token', error_description: 'Access token is required' },
    });
  });

  it('should treat another authentication scheme as no token', async () => {
    const response = await GET(requestTo('/userinfo', { headers: { Authorization: 'Basic dXNlcjpwYXNz' } }));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="UserInfo"');
  });

  // RFC 6750 §2: a client MUST NOT use more than one method in a request.
  it('should reject a token sent both in the header and in the form body with 400 invalid_request', async () => {
    const accessToken = await storeToken();

    const response = await POST(formPost({ access_token: accessToken }, { Authorization: `Bearer ${accessToken}` }));

    expect(await answerOf(response)).toEqual({
      status: 400,
      contentType: 'application/json',
      cacheControl: 'no-store',
      pragma: 'no-cache',
      challenge: 'Bearer realm="UserInfo", error="invalid_request"',
      body: { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
    });
  });

  it('should answer a body it cannot read with 400 invalid_request and no challenge', async () => {
    const brokenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('the connection was reset'));
      },
    });
    const request = new Request(USERINFO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: brokenBody,
      duplex: 'half',
    } as RequestInit);

    const response = await POST(request);

    expect(await answerOf(response)).toEqual({
      status: 400,
      contentType: 'application/json',
      cacheControl: 'no-store',
      pragma: 'no-cache',
      challenge: null,
      body: { error: 'invalid_request' },
    });
  });

  // OIDC Core 1.0 §5.3.1 / RFC 6750 §3.1 / RFC 9068 §4: the token the pipeline rejects, with the Bearer challenge of the error.
  it.each([
    ['an unknown token', async () => 'userinfo-route-unknown-token', 'Access token is invalid'],
    // The key-value store no longer reads an expired record, so the resolver hands one over as another store could.
    ['an expired token', async () => resolveExpiredToken(), 'The access token expired'],
    [
      'a token for another audience',
      () => storeToken({ audience: ['https://api.example.com'] }),
      'The access token is not intended for the UserInfo endpoint',
    ],
    ['a token whose user is gone', () => storeToken({ sub: 'userinfo-route-nobody' }), 'User not found for the given access token'],
  ])('should answer %s with 401 invalid_token and its Bearer challenge', async (_name, token, description) => {
    const response = await GET(bearerGet(await token()));

    expect(await answerOf(response)).toEqual({
      status: 401,
      contentType: 'application/json',
      cacheControl: 'no-store',
      pragma: 'no-cache',
      challenge: `Bearer realm="UserInfo", error="invalid_token", error_description="${description}"`,
      body: { error: 'invalid_token', error_description: description },
    });
  });

  // RFC 6750 §2.2: a token of the form body is a Bearer token, so the Bearer challenge carries its error.
  it('should answer an unknown token of the form body with 401 invalid_token and its Bearer challenge', async () => {
    const response = await POST(formPost({ access_token: 'userinfo-route-unknown-form-token' }));

    expect(await answerOf(response)).toEqual({
      status: 401,
      contentType: 'application/json',
      cacheControl: 'no-store',
      pragma: 'no-cache',
      challenge: 'Bearer realm="UserInfo", error="invalid_token", error_description="Access token is invalid"',
      body: { error: 'invalid_token', error_description: 'Access token is invalid' },
    });
  });

  // OIDC Core 1.0 §5.3.1: the openid scope is required.
  it('should answer a token without the openid scope with 403 insufficient_scope', async () => {
    const accessToken = await storeToken({ scope: ['email'] });

    const response = await GET(bearerGet(accessToken));

    expect(await answerOf(response)).toEqual({
      status: 403,
      contentType: 'application/json',
      cacheControl: 'no-store',
      pragma: 'no-cache',
      challenge: 'Bearer realm="UserInfo", error="insufficient_scope", error_description="The openid scope is required"',
      body: { error: 'insufficient_scope', error_description: 'The openid scope is required' },
    });
  });

  it('should answer 503 server_error and no challenge when the signing keys cannot be loaded', async () => {
    failToLoadSigningKeys();
    const accessToken = await storeToken();

    const response = await GET(bearerGet(accessToken));

    expect(response.status).toBe(503);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(await response.json()).toEqual({ error: 'server_error', error_description: 'Failed to load signing key' });
  });

  it('should answer any other failure with 500 server_error and no challenge', async () => {
    vi.spyOn(resolvers.accessTokenResolver, 'findAccessToken').mockRejectedValue(new Error('the store is down'));

    const response = await GET(bearerGet('userinfo-route-any-token'));

    expect(await answerOf(response)).toEqual({
      status: 500,
      contentType: 'application/json',
      cacheControl: 'no-store',
      pragma: 'no-cache',
      challenge: null,
      body: { error: 'server_error' },
    });
  });
});
