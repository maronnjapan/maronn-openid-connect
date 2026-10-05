import { expect, test, type Page } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;

/**
 * Auth transaction cookie + csrf_token (OIDC Core 1.0 §3.1.2.3 / §3.1.2.4).
 *
 * The spec assumes the End-User who authenticates and grants consent is the one
 * behind the User-Agent that sent the authorization request, but leaves the
 * mechanism to the implementation. The generated OP hands that browser the
 * transaction id in an HttpOnly cookie and nowhere else: /login and /consent
 * carry no query, and their forms embed only the csrf_token, which is accepted
 * only together with the cookie of the transaction it belongs to.
 *
 * These run in a real browser, which is the only place the cookie attributes
 * (HttpOnly / Secure / SameSite=Lax) and the one-cookie-per-browser behavior
 * across tabs are actually exercised: the conformance tests set the Cookie
 * header by hand.
 */
test.describe('Auth transaction cookie', () => {
  test('should keep the transaction id out of the URL and the HTML, in an HttpOnly cookie', async ({
    page,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);

    await page.goto(`${clientBaseURL}/start`);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login$`));

    // Read the whole jar rather than filtering by URL: the cookie is marked
    // Secure, so a URL filter on the plain-HTTP test issuer would exclude it even
    // though the browser stores and replays it for a loopback origin.
    const cookies = await page.context().cookies();
    const transaction = cookies.find((cookie) => cookie.name === 'oidc_txn');

    // Unreadable from JavaScript, which is what keeps an XSS from lifting it.
    expect(transaction?.httpOnly).toBe(true);
    expect(transaction?.sameSite).toBe('Lax');
    expect(transaction?.path).toBe('/');
    expect((transaction?.value ?? '').length).toBe(43);
    // The form carries the csrf_token only.
    const html = await page.content();
    expect(html.includes(transaction?.value ?? '')).toBe(false);
    await expect(page.locator('input[name="csrf_token"]')).toHaveCount(1);
    await expect(page.locator('input[name="transaction_id"]')).toHaveCount(0);
  });

  test('should refuse to show the login form to a different browser opening the same URL', async ({
    page,
    browser,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);

    await page.goto(`${clientBaseURL}/start`);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login$`));

    // A second browser context is a different User-Agent with its own cookie
    // jar. The URL alone names no transaction, so there is nothing to show it.
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    const response = await otherPage.goto(page.url());

    expect((response?.status() ?? 0) >= 400).toBe(true);
    await expect(otherPage.getByRole('button', { name: 'Login' })).toHaveCount(0);
    await expect(otherPage.locator('input[name="csrf_token"]')).toHaveCount(0);
    await otherContext.close();
  });

  test('should refuse to show the consent form to a different browser opening the same URL', async ({
    page,
    browser,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);

    // The End-User's browser drives the flow up to the consent screen.
    await page.goto(`${clientBaseURL}/start`);
    await login(page);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent$`));

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    const response = await otherPage.goto(page.url());

    // The csrf_token that guards POST /consent is never handed out, and neither
    // is the form that would submit it.
    expect((response?.status() ?? 0) >= 400).toBe(true);
    await expect(otherPage.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(otherPage.locator('input[name="csrf_token"]')).toHaveCount(0);
    await otherContext.close();

    // The real End-User is not disturbed.
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(clientBaseURL)}/callback\\?`));
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
  });

  test('should clear the transaction cookie once the flow is finished', async ({ page, baseURL }) => {
    requireBaseUrl(baseURL);

    await page.goto(`${clientBaseURL}/start`);
    await login(page);
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');

    const cookies = await page.context().cookies();
    expect(cookies.some((cookie) => cookie.name === 'oidc_txn')).toBe(false);
  });

  // One cookie per browser: a second authorization request in another tab
  // replaces it. The form still open in the first tab is then refused rather
  // than completing the wrong request, and the newer flow completes.
  test('should refuse the older tab and complete the newer one when two flows share a browser', async ({
    page,
    context,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const firstTab = page;
    const secondTab = await context.newPage();

    await firstTab.goto(`${clientBaseURL}/start`);
    await expect(firstTab).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login$`));
    await secondTab.goto(`${clientBaseURL}/start`);
    await expect(secondTab).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login$`));

    await login(firstTab);
    await expect(firstTab.getByText('Invalid CSRF token.')).toBeVisible();
    await expect(firstTab.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    await login(secondTab);
    await secondTab.getByRole('button', { name: 'Approve' }).click();
    await expect(secondTab).toHaveURL(new RegExp(`^${escapeRegExp(clientBaseURL)}/callback\\?`));
    await expect(secondTab.getByTestId('token-type')).toHaveText('Bearer');

    await secondTab.close();
  });
});

async function login(page: Page): Promise<void> {
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (!baseURL) {
    throw new Error('Playwright baseURL is required');
  }
  return baseURL;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
