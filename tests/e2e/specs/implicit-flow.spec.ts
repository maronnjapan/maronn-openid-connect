import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
// Registered in playwright.config.ts as a public client for the two response
// types of the Implicit Flow. Nothing listens on the redirect URI: the spec
// reads the authorization response from the fragment of the URL the browser
// lands on, as the script of a client's page would.
const clientId = 'e2e-implicit-client';
const redirectUri = `${clientBaseURL}/implicit-callback`;

/**
 * OpenID Connect Core 1.0 §3.2: the Implicit Flow.
 *
 * response_type=id_token token and id_token return the ID Token (and the
 * access token) from the authorization endpoint itself, in the fragment of
 * the redirect URI (OAuth 2.0 Multiple Response Type Encoding Practices §3 /
 * §5), without a code or the token endpoint. The browser does not send the
 * fragment to the client's server, so nothing of the response appears in a
 * request to it.
 *
 * A sample OP generated with `--disable implicit-flow` does not advertise the
 * response types, and every test here skips itself.
 */
test.describe('Implicit Flow', () => {
  test('should return the access token and the ID Token in the fragment after consent', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsImplicitFlow(request, issuer)), 'This sample OP was generated without implicit-flow');
    const { url, state, nonce } = authorizationRequest(issuer, 'id_token token');

    await page.goto(url);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Approve' }).click();
    const callback = await landOnRedirectUri(page);

    // §3.2.2.5: the tokens ride in the fragment, never in the query.
    expect(callback.search).toBe('');
    const response = fragmentOf(callback);
    expect(Object.keys(response)).toEqual(['access_token', 'token_type', 'expires_in', 'scope', 'id_token', 'state', 'iss']);
    expect(response).toMatchObject({ token_type: 'Bearer', expires_in: '3600', scope: 'openid profile', state, iss: issuer });

    // §3.2.2.10: nonce and at_hash are REQUIRED in the ID Token of this response type.
    const idToken = parseJwt(requireString(response['id_token'], 'id_token'));
    const accessToken = requireString(response['access_token'], 'access_token');
    expect(await verifyJwtSignature(idToken, await fetchJwks(request, issuer))).toBe(true);
    expect(idToken.payload).toMatchObject({ iss: issuer, sub: 'testuser', aud: clientId, nonce });
    expect(idToken.payload['at_hash']).toBe(await computeAtHash(accessToken));

    // The access token reaches the UserInfo endpoint like one from the token endpoint.
    const userInfo = await request.get(`${issuer}/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(userInfo.status()).toBe(200);
    expect(await userInfo.json()).toMatchObject({ sub: 'testuser', name: 'Test User' });
  });

  // OIDC Core 1.0 §5.4: with no access token for the UserInfo endpoint, the
  // claims of the scope values ride in the ID Token.
  test('should return the ID Token alone, with the claims of the scope, for response_type=id_token', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsImplicitFlow(request, issuer)), 'This sample OP was generated without implicit-flow');
    const { url, state, nonce } = authorizationRequest(issuer, 'id_token');

    await page.goto(url);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Approve' }).click();
    const response = fragmentOf(await landOnRedirectUri(page));

    expect(Object.keys(response)).toEqual(['id_token', 'state', 'iss']);
    expect(response['state']).toBe(state);
    const idToken = parseJwt(requireString(response['id_token'], 'id_token'));
    expect(idToken.payload).toMatchObject({ sub: 'testuser', aud: clientId, nonce, name: 'Test User' });
    expect(idToken.payload['at_hash']).toBe(undefined);
  });

  // OIDC Core 1.0 §5.5: the id_token member of the claims parameter asks for a
  // claim the scope does not cover, in the ID Token (as the OIDF
  // oidcc-claims-essential module of the Implicit OP plan does).
  test('should put the claims that claims.id_token requests into the ID Token', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsImplicitFlow(request, issuer)), 'This sample OP was generated without implicit-flow');
    const { url, state, nonce } = authorizationRequest(issuer, 'id_token', {
      scope: 'openid',
      claims: JSON.stringify({ id_token: { name: { essential: true } } }),
    });

    await page.goto(url);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Approve' }).click();
    const response = fragmentOf(await landOnRedirectUri(page));

    expect(response['state']).toBe(state);
    const idToken = parseJwt(requireString(response['id_token'], 'id_token'));
    expect(idToken.payload).toMatchObject({ sub: 'testuser', aud: clientId, nonce, name: 'Test User' });
  });

  // OIDC Core 1.0 §3.1.2.1: the authorization endpoint itself returns the
  // tokens when it needs no screen.
  test('should return the tokens from the authorization endpoint for prompt=none', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsImplicitFlow(request, issuer)), 'This sample OP was generated without implicit-flow');
    const first = authorizationRequest(issuer, 'id_token token');
    await page.goto(first.url);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Approve' }).click();
    await landOnRedirectUri(page);

    const silent = authorizationRequest(issuer, 'id_token token', { prompt: 'none' });
    await page.goto(silent.url);
    const response = fragmentOf(await landOnRedirectUri(page));

    expect(response['state']).toBe(silent.state);
    expect(parseJwt(requireString(response['id_token'], 'id_token')).payload['nonce']).toBe(silent.nonce);
    expect(response['access_token']).toEqual(expect.any(String));
  });

  // OIDC Core 1.0 §3.2.2.6: an error goes back in the fragment too.
  test('should return access_denied in the fragment when the End-User denies consent', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsImplicitFlow(request, issuer)), 'This sample OP was generated without implicit-flow');
    const { url, state } = authorizationRequest(issuer, 'id_token token');

    await page.goto(url);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Deny' }).click();

    expect(fragmentOf(await landOnRedirectUri(page))).toEqual({ error: 'access_denied', state, iss: issuer });
  });

  // OIDC Core 1.0 §3.2.2.1: nonce is REQUIRED; OAuth 2.0 Multiple Response
  // Type Encoding Practices §5: the tokens never travel in the query.
  test('should refuse a request without nonce and one with response_mode=query in the fragment', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsImplicitFlow(request, issuer)), 'This sample OP was generated without implicit-flow');
    const withoutNonce = authorizationRequest(issuer, 'id_token token', { nonce: '' });
    const inQuery = authorizationRequest(issuer, 'id_token token', { response_mode: 'query' });

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
        error_description: 'response_mode=query must not be used with the Implicit Flow',
        state: inQuery.state,
        iss: issuer,
      },
    });
  });

  // RFC 6749 §4.2.2.1: a client must be registered for the response type.
  test('should refuse response_type=id_token of a client registered only for code with unauthorized_client', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsImplicitFlow(request, issuer)), 'This sample OP was generated without implicit-flow');
    const codeClientRedirectUri = `${clientBaseURL}/callback`;
    const state = randomValue();
    const url =
      `${issuer}/authorize?response_type=id_token&client_id=e2e-client` +
      `&redirect_uri=${encodeURIComponent(codeClientRedirectUri)}&scope=openid&state=${state}&nonce=${randomValue()}`;

    expect(await errorRedirectOf(request, url)).toEqual({
      target: codeClientRedirectUri,
      response: {
        error: 'unauthorized_client',
        error_description: 'Client is not authorized to use response_type: id_token',
        state,
        iss: issuer,
      },
    });
  });

  // OIDC Discovery 1.0 §3.
  test('should advertise the response types, the fragment response mode and the implicit grant type', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const metadata = await discoveryMetadata(request, issuer);
    test.skip(
      !metadata.response_types_supported.includes('id_token token'),
      'This sample OP was generated without implicit-flow',
    );

    expect(metadata.response_types_supported).toEqual(['code', 'id_token', 'id_token token']);
    expect(metadata.response_modes_supported).toContain('fragment');
    expect(metadata.grant_types_supported).toContain('implicit');
  });
});

interface ProviderMetadata {
  response_types_supported: string[];
  response_modes_supported: string[];
  grant_types_supported: string[];
}

type Jwk = JsonWebKey & { kid?: string };

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: ArrayBuffer;
}

/** An authorization request of the Implicit Flow for the client, with a fresh state and nonce. */
function authorizationRequest(
  issuer: string,
  responseType: 'id_token token' | 'id_token',
  extra: { prompt?: string; response_mode?: string; nonce?: string; scope?: string; claims?: string } = {},
): { url: string; state: string; nonce: string } {
  const state = randomValue();
  const nonce = extra.nonce ?? randomValue();
  const params = new URLSearchParams({
    response_type: responseType,
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: extra.scope ?? 'openid profile',
    state,
    ...(nonce === '' ? {} : { nonce }),
    ...(extra.prompt === undefined ? {} : { prompt: extra.prompt }),
    ...(extra.response_mode === undefined ? {} : { response_mode: extra.response_mode }),
    ...(extra.claims === undefined ? {} : { claims: extra.claims }),
  });
  return { url: `${issuer}/authorize?${params.toString()}`, state, nonce };
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

async function supportsImplicitFlow(request: APIRequestContext, issuer: string): Promise<boolean> {
  return (await discoveryMetadata(request, issuer)).response_types_supported.includes('id_token token');
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

/** OIDC Core 1.0 §3.2.2.9: the left half of the SHA-256 hash of the access token, base64url-encoded. */
async function computeAtHash(accessToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken));
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
