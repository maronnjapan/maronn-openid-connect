import { expect, test } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;

// Registered in playwright.config.ts with the jwks_uri of the E2E RP
// (apps/client.mjs, /jwks.json). Nothing serves the redirect URI: the spec
// reads the code from the URL the browser lands on and redeems it itself.
const jwksUriClient = { clientId: 'e2e-client-jwks-uri', clientSecret: 'e2e-client-jwks-uri-secret' };
const es256Client = { clientId: 'e2e-client-jwks-uri-es256', clientSecret: 'e2e-client-jwks-uri-es256-secret' };
// Its jwks_uri answers 404.
const brokenClientId = 'e2e-client-jwks-uri-broken';
const redirectUri = `${clientBaseURL}/request-object-callback`;

/**
 * A client that registered a jwks_uri (RFC 7591 §2) signs its Request Objects
 * (OIDC Core 1.0 §6.1) with the keys it publishes there, and the OP fetches
 * them from there: when it first needs them, and again for a kid it has not
 * seen (OIDC Core 1.0 §10.1.1), so the client rotates its keys without the OP
 * changing anything. A client that registered request_object_signing_alg
 * (OIDC Dynamic Client Registration 1.0 §2) has its Request Objects signed
 * with that alg only (OIDC Core 1.0 §6.3.2).
 *
 * playwright.config.ts starts the OP with OIDC_ALLOW_INSECURE_CLIENT_JWKS_URI=1,
 * as the E2E RP serves its keys over http on 127.0.0.1, and with
 * OIDC_CLIENT_JWKS_URI_REFETCH_INTERVAL_SECONDS=0, so a rotated key is fetched
 * at once. The destination checks and the refetch interval are covered by the
 * unit tests of core.
 */
test.describe('client jwks_uri (RFC 7591 §2)', () => {
  test.beforeEach(async ({ request, baseURL }) => {
    const metadata = await discoveryMetadata(request, requireBaseUrl(baseURL));
    test.skip(metadata['request_parameter_supported'] !== true, 'This OP was generated without request-object');
  });

  // D-20: the algs core verifies (RFC 7518 §3.3 / §3.4).
  test('should advertise the Request Object signing algs core verifies', async ({ request, baseURL }) => {
    const metadata = await discoveryMetadata(request, requireBaseUrl(baseURL));

    expect(metadata['request_object_signing_alg_values_supported']).toEqual([
      'RS256',
      'RS384',
      'RS512',
      'ES256',
      'ES384',
      'ES512',
    ]);
  });

  // UC-1
  test('should verify a Request Object with the keys of the jwks_uri and complete the flow with its state and redirect_uri', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const authorization = await requestObjectAuthorization(request, jwksUriClient.clientId, 'RS256');

    // redirect_uri, state and code_challenge come from the Request Object
    // alone, so a code issued to that redirect_uri and redeemed with the
    // matching code_verifier shows the OP verified it and applied its claims.
    const callback = await completeAuthorization(page, authorization.authorizationUrl);
    expect(callback.searchParams.get('state')).toBe(authorization.state);
    const redeemed = await redeemCode(
      request,
      issuer,
      jwksUriClient,
      requireString(callback.searchParams.get('code'), 'code'),
      authorization.codeVerifier,
    );
    expect(redeemed.status()).toBe(200);
  });

  // UC-2 / OIDC Core 1.0 §10.1.1
  test('should verify a Request Object signed with a key the client has just added to its jwks_uri', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    // The OP fetches the jwks_uri and keeps its keys.
    await page.goto((await requestObjectAuthorization(request, jwksUriClient.clientId, 'RS256')).authorizationUrl);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login$`));

    // The client adds a key to its jwks_uri and signs with it from now on.
    const rotation = await request.post(`${clientBaseURL}/rotate-request-object-key`);
    expect(rotation.status()).toBe(200);
    const { kid } = (await rotation.json()) as { kid: string };
    const authorization = await requestObjectAuthorization(request, jwksUriClient.clientId, 'RS256');
    expect(authorization.kid).toBe(kid);

    const callback = await completeAuthorization(page, authorization.authorizationUrl);
    expect(callback.searchParams.get('state')).toBe(authorization.state);
  });

  // UC-8 / UC-14 / OIDC Core 1.0 §6.3.2
  test('should accept an ES256 Request Object of a client that registered ES256 and refuse an RS256 one', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const es256 = await requestObjectAuthorization(request, es256Client.clientId, 'ES256');

    const callback = await completeAuthorization(page, es256.authorizationUrl);
    expect(callback.searchParams.get('state')).toBe(es256.state);
    const redeemed = await redeemCode(
      request,
      issuer,
      es256Client,
      requireString(callback.searchParams.get('code'), 'code'),
      es256.codeVerifier,
    );
    expect(redeemed.status()).toBe(200);

    const refused = await authorize(request, (await requestObjectAuthorization(request, es256Client.clientId, 'RS256')).authorizationUrl);
    expect(refused.status()).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'invalid_request_object',
      error_description: 'request object alg does not match the registered request_object_signing_alg',
    });
  });

  // UC-18
  test('should refuse a Request Object signed with a key the jwks_uri does not publish', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);

    const refused = await authorize(request, unpublishedKeyRequestObjectUrl(issuer));

    expect(refused.status()).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'invalid_request_object',
      error_description: 'no JWK matched the request object header (kid)',
    });
  });

  // UC-16 / D-14: the reason (the 404) stays in the log of the OP.
  test('should refuse the Request Object of a client whose jwks_uri cannot be retrieved, without the reason', async ({
    request,
  }) => {
    const refused = await authorize(request, (await requestObjectAuthorization(request, brokenClientId, 'RS256')).authorizationUrl);

    expect(refused.status()).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'invalid_request_object',
      error_description: 'the client jwks_uri could not be retrieved',
    });
  });
});

interface RequestObjectAuthorization {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  kid: string;
}

/** An authorization URL carrying a Request Object the E2E RP signed with the current key of alg. */
async function requestObjectAuthorization(
  request: APIRequestContext,
  clientId: string,
  alg: 'RS256' | 'ES256',
): Promise<RequestObjectAuthorization> {
  const url = new URL('/request-object', clientBaseURL);
  url.search = new URLSearchParams({ client_id: clientId, alg }).toString();
  const response = await request.get(url.toString());
  expect(response.status()).toBe(200);
  return (await response.json()) as RequestObjectAuthorization;
}

/** The authorization request, answered without following a redirect and with JSON for an error. */
function authorize(request: APIRequestContext, authorizationUrl: string) {
  return request.get(authorizationUrl, { maxRedirects: 0, headers: { Accept: 'application/json' } });
}

/**
 * A Request Object of e2e-client-jwks-uri signed with a key of this spec, whose
 * kid the jwks_uri of the client does not publish.
 */
function unpublishedKeyRequestObjectUrl(issuer: string): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'oauth-authz-req+jwt', kid: `e2e-unpublished-${randomUUID()}` };
  const claims = {
    iss: jwksUriClient.clientId,
    aud: issuer,
    iat: now,
    exp: now + 300,
    response_type: 'code',
    client_id: jwksUriClient.clientId,
    redirect_uri: redirectUri,
    scope: 'openid',
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');
  const url = new URL('/authorize', issuer);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: jwksUriClient.clientId,
    scope: 'openid',
    request: `${signingInput}.${signature}`,
  }).toString();
  return url.toString();
}

/** Sign in and approve in the browser, and return the URL the OP redirected back to. */
async function completeAuthorization(page: Page, authorizationUrl: string): Promise<URL> {
  await page.goto(authorizationUrl);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/consent$/);
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForURL((url) => url.pathname === '/request-object-callback');
  return new URL(page.url());
}

async function redeemCode(
  request: APIRequestContext,
  issuer: string,
  client: { clientId: string; clientSecret: string },
  code: string,
  codeVerifier: string,
) {
  return request.post(`${issuer}/token`, {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
  });
}

async function discoveryMetadata(request: APIRequestContext, issuer: string): Promise<Record<string, unknown>> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (!baseURL) {
    throw new Error('Playwright baseURL is required');
  }
  return baseURL.replace(/\/$/, '');
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}
