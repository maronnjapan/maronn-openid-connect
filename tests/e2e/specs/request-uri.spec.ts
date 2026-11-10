import { expect, test } from '../fixtures';
import type { APIRequestContext } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
// The capped-registration OP instance of playwright.config.ts, which requires
// registered request_uris (require_request_uri_registration) and accepts
// unsigned Request Objects.
const dcrOpPort = Number(process.env.E2E_DCR_OP_PORT ?? '3050');
const registrationIssuer = process.env.E2E_DCR_ISSUER ?? `http://${host}:${dcrOpPort}`;

// Registered in playwright.config.ts with the jwks_uri of the E2E RP, which
// also signs the Request Objects it passes by reference.
const jwksUriClient = { clientId: 'e2e-client-jwks-uri', clientSecret: 'e2e-client-jwks-uri-secret' };
// Registered at the capped-registration instance with request_uris of
// /request-objects/registered only.
const registeredClientId = 'e2e-request-uri-registered';
const redirectUri = `${clientBaseURL}/request-object-callback`;

/**
 * Request Objects passed by reference (OIDC Core 1.0 §6.2 / RFC 9101 §5.2):
 * the client puts its Request Object at a URL and sends the URL as
 * request_uri; the OP fetches it (without the fragment, without following
 * redirects) and verifies it as one passed by value. An object the OP cannot
 * fetch is invalid_request_uri, answered by the OP itself (the redirect_uri
 * of an unverified Request Object is not trusted).
 *
 * playwright.config.ts starts the OP with OIDC_ALLOW_INSECURE_REQUEST_URI=1,
 * as the E2E RP serves its Request Objects over http on 127.0.0.1. The
 * destination checks, the timeout and the body limit are covered by the unit
 * tests of core.
 */
test.describe('request_uri (OIDC Core 1.0 §6.2)', () => {

  // OIDC Discovery 1.0 §3.
  test('should advertise request_uri_parameter_supported without requiring registration', async ({ request, baseURL }) => {
    const discoveryIssuer: string = requireBaseUrl(baseURL);
    const discoveryResponse = await request.get(`${discoveryIssuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.status()).toBe(200);
    const discoveryMetadata = (await discoveryResponse.json()) as Record<string, unknown>;
    test.skip(discoveryMetadata['request_uri_parameter_supported'] !== true, 'This OP does not fetch request_uri');

    const issuer: string = requireBaseUrl(baseURL);
    const response = await request.get(`${issuer}/.well-known/openid-configuration`);
    expect(response.status()).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;

    expect(metadata['request_uri_parameter_supported']).toBe(true);
    expect(metadata['require_request_uri_registration']).toBe(false);
  });

  test('should complete the flow with a signed Request Object fetched from the request_uri', async ({ page, request, baseURL }) => {
    const discoveryIssuer: string = requireBaseUrl(baseURL);
    const discoveryResponse = await request.get(`${discoveryIssuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.status()).toBe(200);
    const discoveryMetadata = (await discoveryResponse.json()) as Record<string, unknown>;
    test.skip(discoveryMetadata['request_uri_parameter_supported'] !== true, 'This OP does not fetch request_uri');

    const issuer = requireBaseUrl(baseURL);
    const params: Record<string, string> = { client_id: jwksUriClient.clientId, alg: 'RS256' };
    const url = new URL('/request-uri', clientBaseURL);
    url.search = new URLSearchParams(params).toString();
    const response = await request.get(url.toString());
    expect(response.status()).toBe(200);
    const authorization = (await response.json()) as RequestUriAuthorization;

    // redirect_uri, state and code_challenge are in the Request Object only,
    // so a code issued to that redirect_uri and redeemed with the matching
    // code_verifier shows the OP fetched and verified it.
    const authorizationUrl2: string = authorization.authorizationUrl;
    await page.goto(authorizationUrl2);
    await expect(page).toHaveURL(/\/login\?transaction_id=[^&]+$/);
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page).toHaveURL(/\/consent\?transaction_id=[^&]+$/);
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.waitForURL((url2) => url2.pathname === '/request-object-callback');
    const callback = new URL(page.url());
    expect(callback.searchParams.get('state')).toBe(authorization.state);
    const redeemed = await request.post(`${issuer}/token`, {
      form: {
        grant_type: 'authorization_code',
        code: requireString(callback.searchParams.get('code'), 'code'),
        redirect_uri: redirectUri,
        code_verifier: authorization.codeVerifier,
        client_id: jwksUriClient.clientId,
        client_secret: jwksUriClient.clientSecret,
      },
    });
    expect(redeemed.status()).toBe(200);
  });

  test('should answer invalid_request_uri without redirecting when the request_uri answers 404', async ({ request, baseURL }) => {
    const discoveryIssuer: string = requireBaseUrl(baseURL);
    const discoveryResponse = await request.get(`${discoveryIssuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.status()).toBe(200);
    const discoveryMetadata = (await discoveryResponse.json()) as Record<string, unknown>;
    test.skip(discoveryMetadata['request_uri_parameter_supported'] !== true, 'This OP does not fetch request_uri');

    const issuer = requireBaseUrl(baseURL);
    const url = authorizeUrl(issuer, jwksUriClient.clientId, { request_uri: `${clientBaseURL}/request-objects/never-written` });

    const response = await authorize(request, url);

    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request_uri',
      error_description: 'the request_uri could not be retrieved',
    });
  });

  // OIDC Core 1.0 §6.2 / RFC 9101 §5: request and request_uri are not combined.
  test('should answer invalid_request when request and request_uri are both sent', async ({baseURL,  request }) => {
    const discoveryIssuer: string = requireBaseUrl(baseURL);
    const discoveryResponse = await request.get(`${discoveryIssuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.status()).toBe(200);
    const discoveryMetadata = (await discoveryResponse.json()) as Record<string, unknown>;
    test.skip(discoveryMetadata['request_uri_parameter_supported'] !== true, 'This OP does not fetch request_uri');

    const params: Record<string, string> = { client_id: jwksUriClient.clientId, alg: 'RS256' };
    const url2 = new URL('/request-uri', clientBaseURL);
    url2.search = new URLSearchParams(params).toString();
    const response2 = await request.get(url2.toString());
    expect(response2.status()).toBe(200);
    const authorization = (await response2.json()) as RequestUriAuthorization;
    const url = new URL(authorization.authorizationUrl);
    url.searchParams.set('request', 'eyJhbGciOiJub25lIn0.e30.');

    const response = await authorize(request, url.toString());

    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'request and request_uri must not be used together',
    });
  });

  // RFC 9101 §5.2: a request_uri SHOULD NOT exceed 512 ASCII characters.
  test('should answer invalid_request_uri for a request_uri longer than 512 characters', async ({ request, baseURL }) => {
    const discoveryIssuer: string = requireBaseUrl(baseURL);
    const discoveryResponse = await request.get(`${discoveryIssuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.status()).toBe(200);
    const discoveryMetadata = (await discoveryResponse.json()) as Record<string, unknown>;
    test.skip(discoveryMetadata['request_uri_parameter_supported'] !== true, 'This OP does not fetch request_uri');

    const issuer = requireBaseUrl(baseURL);
    const url = authorizeUrl(issuer, jwksUriClient.clientId, {
      request_uri: `${clientBaseURL}/request-objects/${'a'.repeat(512)}`,
    });

    const response = await authorize(request, url);

    expect(response.status()).toBe(400);
    expect(((await response.json()) as Record<string, unknown>)['error']).toBe('invalid_request_uri');
  });

  // OIDC Discovery 1.0 §3 require_request_uri_registration, at the instance that requires it.
  test.describe('require_request_uri_registration', () => {
    test.beforeEach(async ({ request }) => {
      const metadata = await reachableMetadata(request, registrationIssuer);
      test.skip(metadata?.['require_request_uri_registration'] !== true, 'No OP instance requires registered request_uris');
    });

    test('should accept the unsigned Request Object of a registered request_uri and go on to the login page', async ({ request }) => {
      const params: Record<string, string> = {
        client_id: registeredClientId,
        alg: 'none',
        id: 'registered',
        fragment: 'none',
        issuer: registrationIssuer,
      };
      const url = new URL('/request-uri', clientBaseURL);
      url.search = new URLSearchParams(params).toString();
      const response2 = await request.get(url.toString());
      expect(response2.status()).toBe(200);
      const authorization = (await response2.json()) as RequestUriAuthorization;

      const response = await authorize(request, authorization.authorizationUrl);

      expect(authorization.requestUri).toBe(`${clientBaseURL}/request-objects/registered`);
      expect(response.status()).toBe(302);
      expect(new URL(requireString(response.headers()['location'], 'location'), registrationIssuer).pathname).toBe('/login');
    });

    test('should answer invalid_request_uri for a request_uri the client did not register', async ({ request }) => {
      const params: Record<string, string> = {
        client_id: registeredClientId,
        alg: 'none',
        issuer: registrationIssuer,
      };
      const url = new URL('/request-uri', clientBaseURL);
      url.search = new URLSearchParams(params).toString();
      const response2 = await request.get(url.toString());
      expect(response2.status()).toBe(200);
      const authorization = (await response2.json()) as RequestUriAuthorization;

      const response = await authorize(request, authorization.authorizationUrl);

      expect(response.status()).toBe(400);
      expect(await response.json()).toEqual({
        error: 'invalid_request_uri',
        error_description: 'request_uri is not registered for the client',
      });
    });
  });
});

interface RequestUriAuthorization {
  authorizationUrl: string;
  requestUri: string;
  state: string;
  codeVerifier: string;
}

/** The URL of an authorization request of clientId with the parameters OIDC Core 1.0 §6.2 keeps in the query. */
function authorizeUrl(issuer: string, clientId: string, extra: Record<string, string>): string {
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, scope: 'openid', ...extra });
  return `${issuer}/authorize?${params}`;
}

/** The authorization request, answered without following a redirect and with JSON for an error. */
function authorize(request: APIRequestContext, authorizationUrl: string) {
  return request.get(authorizationUrl, { maxRedirects: 0, headers: { Accept: 'application/json' } });
}

/** The metadata of the OP at issuer, or undefined when nothing answers there. */
async function reachableMetadata(request: APIRequestContext, issuer: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await request.get(`${issuer}/.well-known/openid-configuration`, { timeout: 5_000 });
    return response.ok() ? ((await response.json()) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
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
