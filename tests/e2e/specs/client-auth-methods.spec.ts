import { expect, test, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;

// Registered in playwright.config.ts with both client_secret_basic and
// client_secret_post (tokenEndpointAuthMethods).
const clientId = 'e2e-multiple-auth-methods';
const clientSecret = 'e2e-multiple-auth-methods-secret';
// Nothing listens on this path: the spec reads the code from the URL the
// browser lands on and redeems it itself.
const redirectUri = `${clientBaseURL}/multiple-auth-methods-callback`;

/**
 * OIDC Core 1.0 §9 / RFC 7591 §2: a client may register more than one client
 * authentication method (tokenEndpointAuthMethods). The OP accepts each of
 * them with the client's one secret, and refuses a method the client did not
 * register.
 */
test.describe('several client authentication methods', () => {
  test('should accept client_secret_basic and client_secret_post from a client that registered both', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const { code, codeVerifier } = await authorize(page, issuer);

    // client_secret_basic: the secret in the Authorization header.
    const redeemed = await request.post(`${issuer}/token`, {
      headers: { Authorization: basicAuthorization(clientId, clientSecret) },
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      },
    });
    expect(redeemed.status()).toBe(200);
    const refreshToken = requireString(
      ((await redeemed.json()) as Record<string, unknown>).refresh_token,
      'refresh_token',
    );

    // client_secret_post: the same secret in the request body.
    const refreshed = await request.post(`${issuer}/token`, {
      form: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(refreshed.status()).toBe(200);
  });

  // e2e-client is registered with client_secret_post only. Client
  // authentication runs before the code is looked at, so an unknown code is
  // enough to reach it.
  test('should refuse a client authentication method the client did not register', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);

    const response = await request.post(`${issuer}/token`, {
      headers: { Authorization: basicAuthorization('e2e-client', 'e2e-client-secret') },
      form: {
        grant_type: 'authorization_code',
        code: 'unknown-code',
        redirect_uri: `${clientBaseURL}/callback`,
      },
    });

    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({
      error: 'invalid_client',
      error_description: 'Client authentication method is not registered for the client',
    });
  });
});

/** RFC 6749 §2.3.1: client_secret_basic. */
function basicAuthorization(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
}

/** Run the authorization code flow in the browser and read the code from the redirect. */
async function authorize(page: Page, issuer: string): Promise<{ code: string; codeVerifier: string }> {
  const codeVerifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const authorizationUrl = new URL('/authorize', issuer);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid',
    state,
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  await page.goto(authorizationUrl.toString());
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/consent$/);
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForURL((url) => url.pathname === '/multiple-auth-methods-callback');
  const callback = new URL(page.url());
  expect(callback.searchParams.get('state')).toBe(state);
  return { code: requireString(callback.searchParams.get('code'), 'code'), codeVerifier };
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
