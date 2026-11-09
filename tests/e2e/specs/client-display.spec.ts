import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '../fixtures';
import type { APIRequestContext } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const registeredRedirectUri = `${clientBaseURL}/logged-out`;

/**
 * OIDC Dynamic Client Registration 1.0 §2: the OP SHOULD display the
 * client_name, logo_uri, policy_uri and tos_uri a client registered to the
 * End-User. The login and consent pages show them for the client of the
 * authorization request, the URLs on https only.
 *
 * The URLs need not answer: the OP does not fetch them, it puts them into the
 * page, so the spec reads the attributes of the page.
 */
test.describe('client display metadata (OIDC Dynamic Client Registration 1.0 §2)', () => {
  test.beforeEach(async ({ request, baseURL }) => {
    const metadata = await discoveryMetadata(request, requireBaseUrl(baseURL));
    test.skip(typeof metadata['registration_endpoint'] !== 'string', 'This OP was generated without dynamic-client-registration');
  });

  test('should show the name, logo and policy links of a registered client on the login and consent pages', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const clientId = await registerClient(request, issuer, {
      redirect_uris: [registeredRedirectUri],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: 'E2E Display Client',
      logo_uri: 'https://rp.example.com/logo.png',
      policy_uri: 'https://rp.example.com/privacy',
      tos_uri: 'https://rp.example.com/terms',
    });

    await page.goto(authorizeUrl(issuer, clientId));
    await expect(page).toHaveURL(/\/login\?transaction_id=[^&]+$/);
    await expect(page.locator('strong')).toHaveText('E2E Display Client');
    await expect(page.getByRole('img', { name: 'E2E Display Client logo' })).toHaveAttribute('src', 'https://rp.example.com/logo.png');
    await expect(page.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', 'https://rp.example.com/privacy');
    await expect(page.getByRole('link', { name: 'Terms of service' })).toHaveAttribute('href', 'https://rp.example.com/terms');

    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();

    await expect(page).toHaveURL(/\/consent\?transaction_id=[^&]+$/);
    await expect(page.locator('strong')).toHaveText('E2E Display Client');
    await expect(page.getByRole('img', { name: 'E2E Display Client logo' })).toHaveAttribute('src', 'https://rp.example.com/logo.png');
    await expect(page.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', 'https://rp.example.com/privacy');
    await expect(page.getByRole('link', { name: 'Terms of service' })).toHaveAttribute('href', 'https://rp.example.com/terms');
  });

  // Only https URLs are put into the page.
  test('should not show an http logo_uri', async ({ page, request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const clientId = await registerClient(request, issuer, {
      redirect_uris: [registeredRedirectUri],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: 'E2E Insecure Logo Client',
      logo_uri: 'http://rp.example.com/logo.png',
    });

    await page.goto(authorizeUrl(issuer, clientId));
    await expect(page).toHaveURL(/\/login\?transaction_id=[^&]+$/);

    await expect(page.locator('strong')).toHaveText('E2E Insecure Logo Client');
    await expect(page.locator('img')).toHaveCount(0);
  });
});

async function registerClient(request: APIRequestContext, issuer: string, metadata: Record<string, unknown>): Promise<string> {
  const response = await request.post(`${issuer}/register`, { headers: { 'Content-Type': 'application/json' }, data: metadata });
  expect(response.status()).toBe(201);
  return requireString(((await response.json()) as Record<string, unknown>)['client_id'], 'client_id');
}

function authorizeUrl(issuer: string, clientId: string): string {
  const codeVerifier = randomBytes(32).toString('base64url');
  const url = new URL('/authorize', issuer);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: registeredRedirectUri,
    response_type: 'code',
    scope: 'openid',
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

async function discoveryMetadata(request: APIRequestContext, issuer: string): Promise<Record<string, unknown>> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
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
