import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const redirectUri = `${clientBaseURL}/callback`;

// What playwright.config.ts registers for e2e-hashed-client: the hash, not the
// secret. hashClientSecret() of core returns the base64url SHA-256 digest,
// without a prefix.
const hashedClientSecret = 'e2e-hashed-client-secret';
const registeredSecretHash = 'XTdm4hz_Raiz0XpnpuyAp3vlTS5u5zvbtKLw32daEb8';

/**
 * Client registration metadata: clientSecretHash and scope (the allowed scopes).
 *
 * The two clients are registered through OIDC_CLIENTS_JSON, the way a
 * deployment hands its clients to a sample OP, so these tests show that the
 * registration reaches the endpoints of every generated framework over real
 * HTTP:
 *
 * - RFC 6819 §5.1.4.1.3: a client registered with the hash of its secret
 *   authenticates with the secret, and the stored hash is not a credential.
 * - RFC 7591 §2 / RFC 6749 §3.3: a client registered with a scope list
 *   (RegisteredClient.scope) cannot request a scope outside it.
 */
test.describe('Client registration metadata', () => {
  test('should issue tokens to a client registered with clientSecretHash', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    // The E2E client app redeems codes as e2e-client, so the authorization
    // response of this client is answered here and never reaches it.
    await page.route(
      (url) => url.href.startsWith(`${redirectUri}?`),
      (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'received' }),
    );

    await page.goto(
      `${issuer}/authorize?` +
        new URLSearchParams({
          response_type: 'code',
          client_id: 'e2e-hashed-client',
          redirect_uri: redirectUri,
          scope: 'openid',
          state: 'hashed-client-state',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString(),
    );
    await login(page);
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(redirectUri)}\\?`));
    const callback = new URL(page.url());
    const tokenResponse = await request.post(`${issuer}/token`, {
      form: {
        grant_type: 'authorization_code',
        code: callback.searchParams.get('code') ?? '',
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: 'e2e-hashed-client',
        client_secret: hashedClientSecret,
      },
    });

    expect(callback.searchParams.get('state')).toBe('hashed-client-state');
    expect(tokenResponse.status()).toBe(200);
    const tokens = (await tokenResponse.json()) as Record<string, unknown>;
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.scope).toBe('openid');
  });

  // Client authentication runs before the code is looked at, so no flow is needed.
  test('should reject the registered hash presented as the client secret', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);

    const tokenResponse = await request.post(`${issuer}/token`, {
      form: {
        grant_type: 'authorization_code',
        code: 'unused',
        redirect_uri: redirectUri,
        client_id: 'e2e-hashed-client',
        client_secret: registeredSecretHash,
      },
    });

    expect(tokenResponse.status()).toBe(401);
    expect(await tokenResponse.json()).toEqual({
      error: 'invalid_client',
      error_description: 'Client authentication failed',
    });
  });

  test('should return invalid_scope for a scope outside the allowedScopes of the client', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);

    const response = await request.get(scopedClientAuthorizeUrl(issuer, 'openid email'), {
      maxRedirects: 0,
    });
    const location = new URL(response.headers()['location'] ?? '');

    expect(response.status()).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
    expect(Object.fromEntries(location.searchParams)).toEqual({
      error: 'invalid_scope',
      error_description: 'Client is not registered for scope: email',
      state: 'scoped-client-state',
      iss: issuer,
    });
  });

  test('should send a request within the allowedScopes of the client to the login page', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);

    const response = await request.get(scopedClientAuthorizeUrl(issuer, 'openid profile'), {
      maxRedirects: 0,
    });
    const location = new URL(response.headers()['location'] ?? '');

    expect(response.status()).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe(`${issuer}/login`);
  });
});

function scopedClientAuthorizeUrl(issuer: string, scope: string): string {
  return (
    `${issuer}/authorize?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: 'e2e-scoped-client',
      redirect_uri: redirectUri,
      scope,
      state: 'scoped-client-state',
      // RFC 7636 Appendix B example challenge; the flow stops before it is used.
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    }).toString()
  );
}

// The transaction ID in the URL must match the cookie and hidden form field.
async function login(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/login\?transaction_id=[^&]+$/);
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/consent\?transaction_id=[^&]+$/);
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('Playwright baseURL is required');
  return baseURL;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
