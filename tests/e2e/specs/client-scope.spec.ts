import { expect, test, type APIRequestContext } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL = process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
// Registered in playwright.config.ts with scope ['openid', 'profile'].
const clientId = 'e2e-scope-limited';
const clientSecret = 'e2e-scope-limited-secret';
const redirectUri = `${clientBaseURL}/callback`;

/**
 * RFC 7591 §2: the scope client metadata lists the scope values a client can
 * request. Every entry point that accepts a scope from the client answers a
 * value outside that list with invalid_scope (RFC 6749 §4.1.2.1 / §5.2).
 */
test.describe('Registered client scope (RFC 7591 §2)', () => {
  test('should redirect invalid_scope when the authorization request asks for an unregistered scope', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);

    const response = await request.get(authorizeUrl(issuer, 'openid email'), { maxRedirects: 0 });

    expect(response.status()).toBe(302);
    const location = new URL(requireHeader(response.headers(), 'location'));
    expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(location.searchParams.get('error_description')).toBe(
      'Client is not registered for scope: email',
    );
    expect(location.searchParams.get('state')).toBe('client-scope-state');
    expect(location.searchParams.get('iss')).toBe(issuer);
    expect(location.searchParams.get('code')).toBe(null);
  });

  test('should continue to the login screen when every requested scope is registered', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);

    const response = await request.get(authorizeUrl(issuer, 'openid profile'), { maxRedirects: 0 });

    expect(response.status()).toBe(302);
    expect(requireHeader(response.headers(), 'location')).toBe(`${issuer}/login`);
  });

  test('should refuse a device authorization request for an unregistered scope', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await discoveredEndpoint(request, issuer, 'device_authorization_endpoint');
    test.skip(
      endpoint === undefined,
      'This sample OP was generated without --enable device-authorization-grant',
    );

    const response = await request.post(requireEndpoint(endpoint), {
      form: { client_id: clientId, client_secret: clientSecret, scope: 'openid email' },
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_scope',
      error_description: 'Client is not registered for scope: email',
    });
  });

  test('should refuse a backchannel authentication request for an unregistered scope', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await discoveredEndpoint(request, issuer, 'backchannel_authentication_endpoint');
    test.skip(endpoint === undefined, 'This sample OP was generated without --enable ciba');

    const response = await request.post(requireEndpoint(endpoint), {
      form: {
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'openid email',
        login_hint: 'testuser',
      },
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_scope',
      error_description: 'Client is not registered for scope: email',
    });
  });
});

function authorizeUrl(issuer: string, scope: string): string {
  const url = new URL('/authorize', issuer);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', 'client-scope-state');
  url.searchParams.set('nonce', 'client-scope-nonce');
  // RFC 7636 Appendix B: the S256 challenge of the example verifier.
  url.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function discoveredEndpoint(
  request: APIRequestContext,
  issuer: string,
  name: 'device_authorization_endpoint' | 'backchannel_authentication_endpoint',
): Promise<string | undefined> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  expect(response.status()).toBe(200);
  const metadata = await response.json() as Record<string, string | undefined>;
  return metadata[name];
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (baseURL === undefined) {
    throw new Error('baseURL is not configured');
  }
  return baseURL;
}

function requireEndpoint(endpoint: string | undefined): string {
  if (endpoint === undefined) {
    throw new Error('endpoint is not advertised');
  }
  return endpoint;
}

function requireHeader(headers: Record<string, string>, name: string): string {
  const value = headers[name];
  if (value === undefined) {
    throw new Error(`${name} header is missing`);
  }
  return value;
}
