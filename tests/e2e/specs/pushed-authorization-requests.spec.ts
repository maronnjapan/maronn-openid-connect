import { expect, test } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const clientId = 'e2e-client';
const clientSecret = 'e2e-client-secret';
const REQUEST_URI_PREFIX = 'urn:ietf:params:oauth:request_uri:';

/**
 * EXPERIMENTAL — Pushed Authorization Requests (RFC 9126).
 *
 * Only the samples generated with `--enable par` expose the endpoint, so every
 * test here skips when discovery does not advertise it. That keeps the shared
 * spec suite green across all sample OPs.
 */
test.describe('Pushed Authorization Requests (RFC 9126)', () => {
  test('should complete the full flow with a pushed request_uri', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const parEndpoint = await pushedAuthorizationEndpoint(request, issuer);
    test.skip(parEndpoint === undefined, 'This sample OP was generated without --enable par');
    expect(parEndpoint).toBe(`${issuer}/par`);

    const redirectUri = `${clientBaseURL}/callback`;

    await page.goto(`${clientBaseURL}/start-par`);
    // The browser only ever carried client_id and request_uri to the OP.
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=`));

    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=`));
    await expect(page.locator('strong')).toHaveText(clientId);
    // The consent screen shows the scope that was pushed, not one from the URL.
    await expect(page.locator('li')).toHaveText(['openid', 'profile', 'email']);

    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(redirectUri)}\\?`));

    // The code exchange succeeded, so the OP issued tokens from the pushed request.
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
    await expect(page.getByTestId('userinfo-sub')).toHaveText('testuser');
    const callbackUrl = new URL(page.url());
    expect(callbackUrl.searchParams.get('iss')).toBe(issuer);
  });

  test('should return a single-use request_uri that cannot be replayed', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const parEndpoint = await pushedAuthorizationEndpoint(request, issuer);
    test.skip(parEndpoint === undefined, 'This sample OP was generated without --enable par');

    const pushResponse = await request.post(`${issuer}/par`, {
      form: pushedRequestForm(),
    });
    expect(pushResponse.status()).toBe(201);
    expect(pushResponse.headers()['cache-control']).toBe('no-cache, no-store');
    const pushed = await pushResponse.json() as { request_uri: string; expires_in: number };
    expect(pushed.expires_in).toBe(60);
    expect(pushed.request_uri.startsWith(REQUEST_URI_PREFIX)).toBe(true);

    const authorizeUrl =
      `${issuer}/authorize?client_id=${clientId}&request_uri=` +
      encodeURIComponent(pushed.request_uri);
    const first = await request.get(authorizeUrl, { maxRedirects: 0 });
    expect(first.status()).toBe(302);

    // RFC 9126 §7.3: the reference is single use.
    const replay = await request.get(authorizeUrl, {
      maxRedirects: 0,
      headers: { Accept: 'application/json' },
    });
    expect(replay.status()).toBe(400);
    expect(replay.headers()['location']).toBe(undefined);
    expect(await replay.json()).toEqual({
      error: 'invalid_request_uri',
      error_description: 'The request_uri is invalid, expired, or has already been used',
    });
  });

  test('should reject an unauthenticated pushed request', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const parEndpoint = await pushedAuthorizationEndpoint(request, issuer);
    test.skip(parEndpoint === undefined, 'This sample OP was generated without --enable par');

    const form = pushedRequestForm();
    delete form.client_secret;
    const response = await request.post(`${issuer}/par`, { form });

    expect(response.status()).toBe(401);
    expect((await response.json()).error).toBe('invalid_client');
  });

  test('should reject an unknown request_uri without redirecting', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const parEndpoint = await pushedAuthorizationEndpoint(request, issuer);
    test.skip(parEndpoint === undefined, 'This sample OP was generated without --enable par');

    const response = await request.get(
      `${issuer}/authorize?client_id=${clientId}&request_uri=` +
        encodeURIComponent(`${REQUEST_URI_PREFIX}never-issued-reference`),
      { maxRedirects: 0, headers: { Accept: 'application/json' } },
    );

    expect(response.status()).toBe(400);
    expect(response.headers()['location']).toBe(undefined);
    expect(await response.json()).toEqual({
      error: 'invalid_request_uri',
      error_description: 'The request_uri is invalid, expired, or has already been used',
    });
  });
});

function pushedRequestForm(): Record<string, string> {
  return {
    response_type: 'code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: `${clientBaseURL}/callback`,
    scope: 'openid profile email',
    state: 'e2e-par-state',
    nonce: 'e2e-par-nonce',
    // RFC 7636 Appendix B example challenge.
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  };
}

async function pushedAuthorizationEndpoint(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  issuer: string,
): Promise<string | undefined> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  const metadata = await response.json() as {
    pushed_authorization_request_endpoint?: string;
  };
  return metadata.pushed_authorization_request_endpoint;
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
