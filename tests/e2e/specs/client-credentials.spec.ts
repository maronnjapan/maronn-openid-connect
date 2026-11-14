import { expect, test } from '../fixtures';

// Registered in playwright.config.ts for the client_credentials grant, with
// the scopes reports.read and reports.write and client_secret_basic.
const serviceId = 'e2e-service';
const serviceSecret = 'e2e-service-secret';

/**
 * The client credentials grant (RFC 6749 §4.4 / OAuth 2.1 §4.2).
 *
 * A confidential client asks the token endpoint for an access token for
 * itself: no End-User, no browser. The token names the client as its subject
 * (RFC 9068 §2.2), carries only scopes the client registered, and comes
 * without a refresh token or an ID Token (RFC 6749 §4.4.3).
 *
 * An OP generated with `--disable client-credentials` does not advertise the
 * grant, and every test here skips itself.
 */
// @feature client-credentials
test.describe('client credentials grant', () => {
  test('should issue an access token for the client itself without a refresh token or an ID Token', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!supportsClientCredentials(await discoveryOf(request, issuer)), 'This OP was generated without client-credentials');

    const response = await request.post(`${issuer}/token`, {
      headers: { Authorization: basicAuthorization(serviceId, serviceSecret) },
      form: { grant_type: 'client_credentials', scope: 'reports.read' },
    });
    const body = (await response.json()) as Record<string, unknown>;

    // RFC 6749 §5.1 / §4.4.3: a token response that is not cached, without refresh_token or id_token.
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(Object.keys(body).sort()).toEqual(['access_token', 'expires_in', 'scope', 'token_type']);
    expect(body.token_type).toBe('Bearer');
    expect(body.scope).toBe('reports.read');
    // RFC 9068 §2.2: the subject of a token no resource owner is involved in is the client.
    const claims = decodeJwtPayload(requireString(body.access_token, 'access_token'));
    expect(claims.iss).toBe(issuer);
    expect(claims.sub).toBe(serviceId);
    expect(claims.client_id).toBe(serviceId);
    expect(claims.scope).toBe('reports.read');
    expect(claims.aud).toEqual([issuer]);
  });

  // RFC 7662 §2.2: a resource server reads the token at the introspection endpoint.
  test('should issue a token the introspection endpoint reports active for the client', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const discovery = await discoveryOf(request, issuer);
    test.skip(!supportsClientCredentials(discovery), 'This OP was generated without client-credentials');
    const introspectionEndpoint = discovery.introspection_endpoint;
    test.skip(typeof introspectionEndpoint !== 'string', 'This OP was generated without introspection');
    const tokenResponse = await request.post(`${issuer}/token`, {
      headers: { Authorization: basicAuthorization(serviceId, serviceSecret) },
      form: { grant_type: 'client_credentials', scope: 'reports.read' },
    });
    const accessToken = requireString(((await tokenResponse.json()) as Record<string, unknown>).access_token, 'access_token');

    const introspection = await request.post(String(introspectionEndpoint), {
      headers: { Authorization: basicAuthorization(serviceId, serviceSecret) },
      form: { token: accessToken },
    });

    expect(introspection.status()).toBe(200);
    const introspected = (await introspection.json()) as Record<string, unknown>;
    expect(introspected.active).toBe(true);
    expect(introspected.sub).toBe(serviceId);
    expect(introspected.client_id).toBe(serviceId);
    expect(introspected.scope).toBe('reports.read');
  });

  // RFC 6749 §3.3: a request without scope gets the scopes the client registered.
  test('should issue every registered scope when the request names none', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!supportsClientCredentials(await discoveryOf(request, issuer)), 'This OP was generated without client-credentials');

    const response = await request.post(`${issuer}/token`, {
      headers: { Authorization: basicAuthorization(serviceId, serviceSecret) },
      form: { grant_type: 'client_credentials' },
    });

    expect(response.status()).toBe(200);
    expect(((await response.json()) as Record<string, unknown>).scope).toBe('reports.read reports.write');
  });

  // OIDC Core 1.0 §5.3.1: the token stands for no End-User, so the UserInfo endpoint refuses it.
  test('should issue a token the UserInfo endpoint refuses with insufficient_scope', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!supportsClientCredentials(await discoveryOf(request, issuer)), 'This OP was generated without client-credentials');
    const tokenResponse = await request.post(`${issuer}/token`, {
      headers: { Authorization: basicAuthorization(serviceId, serviceSecret) },
      form: { grant_type: 'client_credentials' },
    });
    const accessToken = requireString(((await tokenResponse.json()) as Record<string, unknown>).access_token, 'access_token');

    const userinfo = await request.get(`${issuer}/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(userinfo.status()).toBe(403);
    expect(await userinfo.json()).toEqual({
      error: 'insufficient_scope',
      error_description: 'The openid scope is required',
    });
  });

  // OIDC Core 1.0 §3.1.2.1: openid stands for the authentication of an End-User.
  test('should refuse the openid scope and a scope the client did not register with invalid_scope', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!supportsClientCredentials(await discoveryOf(request, issuer)), 'This OP was generated without client-credentials');

    const openid = await request.post(`${issuer}/token`, {
      headers: { Authorization: basicAuthorization(serviceId, serviceSecret) },
      form: { grant_type: 'client_credentials', scope: 'openid' },
    });
    const unregistered = await request.post(`${issuer}/token`, {
      headers: { Authorization: basicAuthorization(serviceId, serviceSecret) },
      form: { grant_type: 'client_credentials', scope: 'reports.read admin' },
    });

    expect(openid.status()).toBe(400);
    expect(await openid.json()).toEqual({
      error: 'invalid_scope',
      error_description: 'Scope is not available for the client_credentials grant: openid',
    });
    expect(unregistered.status()).toBe(400);
    expect(await unregistered.json()).toEqual({
      error: 'invalid_scope',
      error_description: 'Client is not registered for scope: admin',
    });
  });

  // RFC 7591 §2: grant_types defaults to ["authorization_code"]. e2e-resource-server
  // (client_secret_basic) registered the authorization_code and refresh_token grants only.
  test('should refuse a client that did not register the grant with unauthorized_client', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!supportsClientCredentials(await discoveryOf(request, issuer)), 'This OP was generated without client-credentials');

    const response = await request.post(`${issuer}/token`, {
      headers: { Authorization: basicAuthorization('e2e-resource-server', 'e2e-resource-server-secret') },
      form: { grant_type: 'client_credentials' },
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'unauthorized_client',
      error_description: 'Client is not authorized to use grant_type: client_credentials',
    });
  });

  // RFC 8707 §2: no audience may be named until the OP lists the resources it issues tokens for.
  test('should refuse an audience the OP does not allow with invalid_target', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!supportsClientCredentials(await discoveryOf(request, issuer)), 'This OP was generated without client-credentials');

    const response = await request.post(`${issuer}/token`, {
      headers: { Authorization: basicAuthorization(serviceId, serviceSecret) },
      form: { grant_type: 'client_credentials', audience: 'https://not-allowed.e2e.example.com' },
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_target',
      error_description: 'Requested audience is not allowed: https://not-allowed.e2e.example.com',
    });
  });
});

/** The provider metadata of the OP (OIDC Discovery 1.0 §3). */
async function discoveryOf(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  issuer: string,
): Promise<Record<string, unknown>> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  return (await response.json()) as Record<string, unknown>;
}

/** Whether the OP advertises the client_credentials grant (grant_types_supported). */
function supportsClientCredentials(discovery: Record<string, unknown>): boolean {
  const grants = discovery.grant_types_supported;
  return Array.isArray(grants) && grants.includes('client_credentials');
}

/** The payload of a compact JWS, without verifying it. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload = ''] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** RFC 6749 §2.3.1: client_secret_basic. */
function basicAuthorization(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (!baseURL) {
    throw new Error('Playwright baseURL is required');
  }
  return baseURL;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}
