import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
// Registered in playwright.config.ts as a confidential client for the three
// response types of the Hybrid Flow. Nothing listens on the redirect URI: the
// spec reads the authorization response from the fragment of the URL the
// browser lands on, as the script of a client's page would, and exchanges the
// code at the token endpoint itself.
const clientId = 'e2e-hybrid-client';
const clientSecret = 'e2e-hybrid-client-secret';
const redirectUri = `${clientBaseURL}/hybrid-callback`;

/**
 * OpenID Connect Core 1.0 §3.3: the Hybrid Flow.
 *
 * response_type=code id_token token, code id_token and code token return the
 * authorization code together with the ID Token and/or the access token from
 * the authorization endpoint itself, in the fragment of the redirect URI
 * (OAuth 2.0 Multiple Response Type Encoding Practices §5). The client then
 * exchanges the code at the token endpoint as in the Authorization Code Flow
 * (§3.3.3), PKCE included.
 *
 * A sample OP generated with `--disable hybrid-flow` does not advertise the
 * response types, and every test here skips itself.
 */
test.describe('Hybrid Flow', () => {
  test('should return the code with the access token and the ID Token in the fragment after consent, then exchange the code', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsHybridFlow(request, issuer)), 'This sample OP was generated without hybrid-flow');
    const { url, state, nonce, codeVerifier } = authorizationRequest(issuer, 'code id_token token');

    await page.goto(url);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Approve' }).click();
    const callback = await landOnRedirectUri(page);

    // §3.3.2.5: the code and the tokens ride in the fragment, never in the query.
    expect(callback.search).toBe('');
    const response = fragmentOf(callback);
    expect(Object.keys(response)).toEqual(['code', 'access_token', 'token_type', 'expires_in', 'scope', 'id_token', 'state', 'iss']);
    expect(response).toMatchObject({ token_type: 'Bearer', expires_in: '3600', scope: 'openid profile', state, iss: issuer });

    // §3.3.2.11: nonce, c_hash and at_hash are REQUIRED in the ID Token of this response type.
    const code = requireString(response['code'], 'code');
    const accessToken = requireString(response['access_token'], 'access_token');
    const idToken = parseJwt(requireString(response['id_token'], 'id_token'));
    expect(await verifyJwtSignature(idToken, await fetchJwks(request, issuer))).toBe(true);
    expect(idToken.payload).toMatchObject({ iss: issuer, sub: 'testuser', aud: clientId, nonce });
    expect(idToken.payload['c_hash']).toBe(await leftHalfSha256(code));
    expect(idToken.payload['at_hash']).toBe(await leftHalfSha256(accessToken));

    // The access token of the fragment reaches the UserInfo endpoint like one from the token endpoint.
    expect(await userInfoStatus(request, issuer, accessToken)).toBe(200);

    // §3.3.3: the code is exchanged as in the code flow; §3.3.3.6: the ID Token
    // of the token endpoint names the same End-User and carries the nonce.
    const tokens = await exchangeCode(request, issuer, code, codeVerifier);
    expect(tokens.status).toBe(200);
    expect(Object.keys(tokens.body).sort()).toEqual(['access_token', 'expires_in', 'id_token', 'refresh_token', 'scope', 'token_type']);
    const exchangedIdToken = parseJwt(requireString(tokens.body['id_token'], 'id_token'));
    expect(exchangedIdToken.payload).toMatchObject({ iss: issuer, sub: 'testuser', aud: clientId, nonce });
    expect(await userInfoStatus(request, issuer, requireString(tokens.body['access_token'], 'access_token'))).toBe(200);
  });

  // OIDC Core 1.0 §3.3.2.5 / §5.4: no access token from the authorization
  // endpoint, and the claims of the scope values wait at the UserInfo endpoint
  // for the access token of the code.
  test('should return the code and the ID Token without an access token for response_type=code id_token', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsHybridFlow(request, issuer)), 'This sample OP was generated without hybrid-flow');
    const { url, state, nonce, codeVerifier } = authorizationRequest(issuer, 'code id_token');

    await page.goto(url);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Approve' }).click();
    const response = fragmentOf(await landOnRedirectUri(page));

    expect(Object.keys(response)).toEqual(['code', 'id_token', 'state', 'iss']);
    expect(response['state']).toBe(state);
    const code = requireString(response['code'], 'code');
    const idToken = parseJwt(requireString(response['id_token'], 'id_token'));
    expect(idToken.payload).toMatchObject({ sub: 'testuser', aud: clientId, nonce });
    expect(idToken.payload['c_hash']).toBe(await leftHalfSha256(code));
    expect(idToken.payload['at_hash']).toBe(undefined);
    expect(idToken.payload['name']).toBe(undefined);

    const tokens = await exchangeCode(request, issuer, code, codeVerifier);
    expect(tokens.status).toBe(200);
    const userInfo = await request.get(`${issuer}/userinfo`, {
      headers: { Authorization: `Bearer ${requireString(tokens.body['access_token'], 'access_token')}` },
    });
    expect(await userInfo.json()).toMatchObject({ sub: 'testuser', name: 'Test User' });
  });

  // OIDC Core 1.0 §3.3.2.5: no ID Token from the authorization endpoint, so
  // nonce stays optional as in the code flow (the errata NonceNotes; the OIDF
  // oidcc-ensure-request-without-nonce-succeeds-for-code-flow module).
  test('should return the code and the access token without an ID Token for response_type=code token, with no nonce', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsHybridFlow(request, issuer)), 'This sample OP was generated without hybrid-flow');
    const { url, state, codeVerifier } = authorizationRequest(issuer, 'code token', { nonce: '' });

    await page.goto(url);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Approve' }).click();
    const response = fragmentOf(await landOnRedirectUri(page));

    expect(Object.keys(response)).toEqual(['code', 'access_token', 'token_type', 'expires_in', 'scope', 'state', 'iss']);
    expect(response).toMatchObject({ token_type: 'Bearer', expires_in: '3600', scope: 'openid profile', state, iss: issuer });

    const tokens = await exchangeCode(request, issuer, requireString(response['code'], 'code'), codeVerifier);
    expect(tokens.status).toBe(200);
    const exchangedIdToken = parseJwt(requireString(tokens.body['id_token'], 'id_token'));
    expect(exchangedIdToken.payload).toMatchObject({ sub: 'testuser', aud: clientId });
    expect(exchangedIdToken.payload['nonce']).toBe(undefined);
  });

  // OAuth 2.1 §4.1.2: the code and the access token of the fragment belong to
  // one grant, so a replayed code revokes that access token too.
  test('should refuse a replayed code and revoke the access token of the fragment with it', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsHybridFlow(request, issuer)), 'This sample OP was generated without hybrid-flow');
    const { url, codeVerifier } = authorizationRequest(issuer, 'code token');

    await page.goto(url);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Approve' }).click();
    const response = fragmentOf(await landOnRedirectUri(page));
    const code = requireString(response['code'], 'code');
    const accessToken = requireString(response['access_token'], 'access_token');

    expect((await exchangeCode(request, issuer, code, codeVerifier)).status).toBe(200);
    const replay = await exchangeCode(request, issuer, code, codeVerifier);
    expect(replay.status).toBe(400);
    expect(replay.body['error']).toBe('invalid_grant');
    expect(await userInfoStatus(request, issuer, accessToken)).toBe(401);
  });

  // OIDC Core 1.0 §3.1.2.1: the authorization endpoint itself returns the
  // code and the tokens when it needs no screen.
  test('should return the code and the tokens from the authorization endpoint for prompt=none', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsHybridFlow(request, issuer)), 'This sample OP was generated without hybrid-flow');
    const first = authorizationRequest(issuer, 'code id_token token');
    await page.goto(first.url);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Approve' }).click();
    await landOnRedirectUri(page);

    const silent = authorizationRequest(issuer, 'code id_token token', { prompt: 'none' });
    await page.goto(silent.url);
    const response = fragmentOf(await landOnRedirectUri(page));

    expect(Object.keys(response)).toEqual(['code', 'access_token', 'token_type', 'expires_in', 'scope', 'id_token', 'state', 'iss']);
    expect(response['state']).toBe(silent.state);
    const idToken = parseJwt(requireString(response['id_token'], 'id_token'));
    expect(idToken.payload['nonce']).toBe(silent.nonce);
    expect(idToken.payload['c_hash']).toBe(await leftHalfSha256(requireString(response['code'], 'code')));
  });

  // OIDC Core 1.0 §3.3.2.11: nonce is REQUIRED when an ID Token is returned
  // from the authorization endpoint; OAuth 2.0 Multiple Response Type Encoding
  // Practices §5: the tokens never travel in the query.
  test('should refuse a code id_token request without nonce and one with response_mode=query in the fragment', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsHybridFlow(request, issuer)), 'This sample OP was generated without hybrid-flow');
    const withoutNonce = authorizationRequest(issuer, 'code id_token', { nonce: '' });
    const inQuery = authorizationRequest(issuer, 'code id_token token', { response_mode: 'query' });

    expect(await errorRedirectOf(request, withoutNonce.url)).toEqual({
      target: redirectUri,
      response: {
        error: 'invalid_request',
        error_description: 'Missing required parameter: nonce',
        state: withoutNonce.state,
        iss: issuer,
      },
    });
    expect(await errorRedirectOf(request, inQuery.url)).toEqual({
      target: redirectUri,
      response: {
        error: 'invalid_request',
        error_description: 'response_mode=query must not be used with the Hybrid Flow',
        state: inQuery.state,
        iss: issuer,
      },
    });
  });

  // RFC 6749 §4.1.2.1: a client must be registered for the response type.
  test('should refuse response_type=code id_token of a client registered only for code with unauthorized_client', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsHybridFlow(request, issuer)), 'This sample OP was generated without hybrid-flow');
    const codeClientRedirectUri = `${clientBaseURL}/callback`;
    const state = randomValue();
    const url =
      `${issuer}/authorize?response_type=${encodeURIComponent('code id_token')}&client_id=e2e-client` +
      `&redirect_uri=${encodeURIComponent(codeClientRedirectUri)}&scope=openid&state=${state}&nonce=${randomValue()}`;

    expect(await errorRedirectOf(request, url)).toEqual({
      target: codeClientRedirectUri,
      response: {
        error: 'unauthorized_client',
        error_description: 'Client is not authorized to use response_type: code id_token',
        state,
        iss: issuer,
      },
    });
  });

  // OIDC Discovery 1.0 §3.
  test('should advertise the response types of the Hybrid Flow and the c_hash claim', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const metadata = await discoveryMetadata(request, issuer);
    test.skip(
      !metadata.response_types_supported.includes('code id_token token'),
      'This sample OP was generated without hybrid-flow',
    );

    expect(metadata.response_types_supported).toEqual([
      'code',
      'id_token',
      'id_token token',
      'code id_token',
      'code token',
      'code id_token token',
    ]);
    expect(metadata.response_modes_supported.includes('fragment')).toBe(true);
    expect(metadata.grant_types_supported.includes('implicit')).toBe(true);
    expect(metadata.claims_supported.includes('c_hash')).toBe(true);
  });
});

interface ProviderMetadata {
  response_types_supported: string[];
  response_modes_supported: string[];
  grant_types_supported: string[];
  claims_supported: string[];
}

type Jwk = JsonWebKey & { kid?: string };

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: ArrayBuffer;
}

/** An authorization request of the Hybrid Flow for the client, with a fresh state, nonce and PKCE verifier. */
function authorizationRequest(
  issuer: string,
  responseType: 'code id_token token' | 'code id_token' | 'code token',
  extra: { prompt?: string; response_mode?: string; nonce?: string } = {},
): { url: string; state: string; nonce: string; codeVerifier: string } {
  const state = randomValue();
  const nonce = extra.nonce ?? randomValue();
  const codeVerifier = randomValue();
  const params = new URLSearchParams({
    response_type: responseType,
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile',
    state,
    ...(nonce === '' ? {} : { nonce }),
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...(extra.prompt === undefined ? {} : { prompt: extra.prompt }),
    ...(extra.response_mode === undefined ? {} : { response_mode: extra.response_mode }),
  });
  return { url: `${issuer}/authorize?${params.toString()}`, state, nonce, codeVerifier };
}

async function login(page: Page, issuer: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login$`));
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent$`));
}

/** Wait for the browser to land on the redirect URI and return the URL it landed on. */
async function landOnRedirectUri(page: Page): Promise<URL> {
  await page.waitForURL((url) => url.href.startsWith(redirectUri));
  return new URL(page.url());
}

/** The parameters in the fragment of a URL (application/x-www-form-urlencoded). */
function fragmentOf(url: URL): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(url.hash.slice(1)));
}

/** Exchange the code at the token endpoint as the client (client_secret_post, PKCE). OIDC Core 1.0 §3.3.3.1 */
async function exchangeCode(
  request: APIRequestContext,
  issuer: string,
  code: string,
  codeVerifier: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await request.post(`${issuer}/token`, {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: codeVerifier,
    },
  });
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
}

async function userInfoStatus(request: APIRequestContext, issuer: string, accessToken: string): Promise<number> {
  const response = await request.get(`${issuer}/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return response.status();
}

/** The redirect the authorization endpoint answers with, without following it. */
async function errorRedirectOf(
  request: APIRequestContext,
  url: string,
): Promise<{ target: string; response: Record<string, string> }> {
  const answer = await request.get(url, { maxRedirects: 0 });
  expect(answer.status()).toBe(302);
  const location = new URL(requireString(answer.headers()['location'], 'Location'));
  return { target: location.origin + location.pathname + location.search, response: fragmentOf(location) };
}

async function discoveryMetadata(request: APIRequestContext, issuer: string): Promise<ProviderMetadata> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  return (await response.json()) as ProviderMetadata;
}

async function supportsHybridFlow(request: APIRequestContext, issuer: string): Promise<boolean> {
  return (await discoveryMetadata(request, issuer)).response_types_supported.includes('code id_token token');
}

async function fetchJwks(request: APIRequestContext, issuer: string): Promise<{ keys: Jwk[] }> {
  const response = await request.get(`${issuer}/.well-known/jwks.json`);
  return (await response.json()) as { keys: Jwk[] };
}

function parseJwt(jwt: string): ParsedJwt {
  const [header = '', payload = '', signature = ''] = jwt.split('.');
  const bytes = Buffer.from(signature, 'base64url');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    signingInput: `${header}.${payload}`,
    signature: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

async function verifyJwtSignature(jwt: ParsedJwt, jwks: { keys: Jwk[] }): Promise<boolean> {
  const jwk = jwks.keys.find((candidate) => candidate.kid === jwt.header['kid']);
  if (jwk === undefined) {
    throw new Error(`JWK not found for kid: ${String(jwt.header['kid'])}`);
  }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, jwt.signature, new TextEncoder().encode(jwt.signingInput));
}

/** OIDC Core 1.0 §3.3.2.11: the left half of the SHA-256 hash of the value, base64url-encoded (at_hash and c_hash for RS256). */
async function leftHalfSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Buffer.from(new Uint8Array(digest).slice(0, 16)).toString('base64url');
}

function randomValue(): string {
  return randomBytes(32).toString('base64url');
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (baseURL === undefined) {
    throw new Error('baseURL is not configured');
  }
  return baseURL;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
