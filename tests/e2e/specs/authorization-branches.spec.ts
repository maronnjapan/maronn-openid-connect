import { expect, test, type Page } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL = process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const clientId = 'e2e-client';
const clientSecret = 'e2e-client-secret';

test.describe('Authorization endpoint browser branches', () => {
  test('should return access_denied with the exact state and issuer after consent denial', async ({
    page,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const authorizeRequestPromise = page.waitForRequest((request) =>
      request.url().startsWith(`${issuer}/authorize?`),
    );

    await page.goto(`${clientBaseURL}/start?prompt=consent`);
    const authorizeRequest = await authorizeRequestPromise;
    const sentState = requireSearchParam(new URL(authorizeRequest.url()), 'state');
    await login(page, 'testuser');
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(clientBaseURL)}/callback\\?`));

    const callback = new URL(page.url());
    expect(`${callback.origin}${callback.pathname}`).toBe(`${clientBaseURL}/callback`);
    expect(callback.searchParams.get('error')).toBe('access_denied');
    expect(callback.searchParams.get('state')).toBe(sentState);
    expect(callback.searchParams.get('iss')).toBe(issuer);
    expect(callback.searchParams.get('code')).toBe(null);
    expect(callback.hash).toBe('');
    await expect(page.getByTestId('authorization-error')).toHaveText('access_denied');
    await expect(page.getByTestId('authorization-state')).toHaveText(sentState);
    await expect(page.getByTestId('authorization-issuer')).toHaveText(issuer);
  });

  test('should issue and rotate a refresh token only for an offline_access grant', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    await page.goto(
      `${clientBaseURL}/start?scope=${encodeURIComponent('openid offline_access')}&prompt=consent`,
    );
    await login(page, 'testuser');
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('heading', { name: 'Authorization Complete' })).toBeVisible();
    const refreshToken = await requiredText(page, 'token-refresh-token');
    expect(refreshToken).toHaveLength(43);

    const wrongClientResponse = await request.post(`${issuer}/token`, {
      headers: {
        Authorization: `Basic ${Buffer.from(
          'e2e-resource-server:e2e-resource-server-secret',
        ).toString('base64')}`,
      },
      form: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
    });
    expect(wrongClientResponse.status()).toBe(400);
    expect(await wrongClientResponse.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'Refresh token was issued to a different client',
    });

    const refreshResponse = await request.post(`${issuer}/token`, {
      form: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(refreshResponse.status()).toBe(200);
    const refreshed = await refreshResponse.json() as Record<string, unknown>;
    expect(refreshed.token_type).toBe('Bearer');
    expect(refreshed.expires_in).toBe(3600);
    expect(refreshed.scope).toBe('openid offline_access');
    const refreshedAccessToken = requireString(refreshed.access_token, 'refreshed access token');
    expect(refreshedAccessToken.split('.')).toHaveLength(3);
    expect(requireString(refreshed.refresh_token, 'rotated refresh token')).toHaveLength(43);
    expect(requireString(refreshed.id_token, 'refreshed ID Token').split('.')).toHaveLength(3);
    const refreshedUserInfoResponse = await request.get(`${issuer}/userinfo`, {
      headers: { Authorization: `Bearer ${refreshedAccessToken}` },
    });
    expect(refreshedUserInfoResponse.status()).toBe(200);
    expect(await refreshedUserInfoResponse.json()).toEqual({ sub: 'testuser' });
  });

  test('should require a matching browser session for prompt none with id_token_hint', async ({
    page,
    browser,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    await page.goto(`${clientBaseURL}/start`);
    await loginAndApprove(page, 'testuser');
    const testUserIdToken = await requiredText(page, 'token-id-token');

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await otherPage.goto(`${clientBaseURL}/start`);
    await loginAndApprove(otherPage, 'otheruser');
    const otherUserIdToken = await requiredText(otherPage, 'token-id-token');

    // A verified id_token_hint succeeds only when its subject matches the active session.
    await page.goto(
      `${clientBaseURL}/start?prompt=none&id_token_hint=${encodeURIComponent(testUserIdToken)}`,
    );
    await expect(page.getByRole('heading', { name: 'Authorization Complete' })).toBeVisible();
    expect((await requiredText(page, 'authorization-code')).length).toBe(43);

    const noSessionContext = await browser.newContext();
    const noSessionPage = await noSessionContext.newPage();
    // A valid hint is not a substitute for an authenticated browser session.
    await noSessionPage.goto(
      `${clientBaseURL}/start?prompt=none&id_token_hint=${encodeURIComponent(testUserIdToken)}`,
    );
    const noSessionCallback = new URL(noSessionPage.url());
    expect(noSessionCallback.searchParams.get('error')).toBe('login_required');
    expect(noSessionCallback.searchParams.get('code')).toBe(null);
    expect(noSessionCallback.searchParams.get('iss')).toBe(issuer);
    await expect(noSessionPage.getByTestId('authorization-error')).toHaveText('login_required');

    // Hint verification and session-subject matching are separate success conditions.
    await page.goto(
      `${clientBaseURL}/start?prompt=none&id_token_hint=${encodeURIComponent(otherUserIdToken)}`,
    );
    const mismatchCallback = new URL(page.url());
    expect(mismatchCallback.searchParams.get('error')).toBe('login_required');
    expect(mismatchCallback.searchParams.get('code')).toBe(null);
    expect(mismatchCallback.searchParams.get('iss')).toBe(issuer);
    await expect(page.getByTestId('authorization-error')).toHaveText('login_required');

    await noSessionContext.close();
    await otherContext.close();
  });

  // OIDC Core 1.0 §3.1.2.1: the id_token_hint rule is not conditioned on prompt.
  // With an active session for User B and a hint naming User A, the OP must not
  // silently reuse B's session (account mix-up); it falls back to the login screen.
  test('should not reuse the session of another user when id_token_hint names a different user', async ({
    page,
    browser,
  }) => {
    const hintContext = await browser.newContext();
    const hintPage = await hintContext.newPage();
    await hintPage.goto(`${clientBaseURL}/start`);
    await loginAndApprove(hintPage, 'testuser');
    const testUserIdToken = await requiredText(hintPage, 'token-id-token');

    // Session belongs to otheruser; SSO alone would issue a code for otheruser.
    await page.goto(`${clientBaseURL}/start`);
    await loginAndApprove(page, 'otheruser');

    await page.goto(`${clientBaseURL}/start?id_token_hint=${encodeURIComponent(testUserIdToken)}`);

    await expect(page).toHaveURL(/\/login\?transaction_id=/);
    const stopped = new URL(page.url());
    expect(stopped.pathname).toBe('/login');
    expect(stopped.searchParams.get('code')).toBe(null);
    expect(stopped.searchParams.get('error')).toBe(null);

    // Without the hint the same session still goes straight through (no regression).
    await page.goto(`${clientBaseURL}/start`);
    await expect(page.getByRole('heading', { name: 'Authorization Complete' })).toBeVisible();
    expect((await requiredText(page, 'authorization-code')).length).toBe(43);

    await hintContext.close();
  });
});

async function login(page: Page, username: string): Promise<void> {
  await expect(page).toHaveURL(/\/login\?transaction_id=/);
  await page.getByLabel('Username:').fill(username);
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/consent\?transaction_id=/);
}

async function loginAndApprove(page: Page, username: string): Promise<void> {
  await login(page, username);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Authorization Complete' })).toBeVisible();
}

async function requiredText(page: Page, testId: string): Promise<string> {
  const value = await page.getByTestId(testId).textContent();
  if (value === null || value.length === 0) {
    throw new Error(`${testId} text is required`);
  }
  return value;
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('Playwright baseURL is required');
  return baseURL;
}

function requireSearchParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`Missing search parameter: ${name}`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
