import { expect, test } from '../fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const invalidScreenStatus = (process.env.E2E_OP_PACKAGE ?? '').includes('nextjs') ? 404 : 400;

/**
 * Bind every interactive authorization request to the cookie, the URL and the
 * hidden transaction ID, then validate the stored CSRF token before any change.
 * Browser tests also exercise cookie attributes and stale forms across tabs.
 */
test.describe('Auth transaction cookie', () => {
  for (const screen of ['login', 'consent'] as const) {
    for (const reference of ['cookie', 'query'] as const) {
      test(`should reject the ${screen} reload after its ${reference} is replaced with another live transaction`, async ({ page, context, browser }) => {
        await openScreen(page, screen);
        const originalId = await page.locator('input[name="transaction_id"]').inputValue();
        const originalCsrf = await page.locator('input[name="csrf_token"]').inputValue();
        const other = await separateLoginTransaction(browser);
        expect(other.transactionId).not.toBe(originalId);

        await replaceScreenReference(page, context, reference, other.transactionId);
        await expect(page.locator('input[name="transaction_id"]')).toHaveValue(originalId);
        const cookiesAfterTampering = await context.cookies();

        const response = await page.reload();

        expect(response?.status()).toBe(invalidScreenStatus);
        await expect(page.locator('form')).toHaveCount(0);
        await expect(page.locator('input[name="transaction_id"]')).toHaveCount(0);
        await expect(page.locator('input[name="csrf_token"]')).toHaveCount(0);
        const html = await page.content();
        expect(html).not.toContain(originalCsrf);
        expect(html).not.toContain(other.csrfToken);
        expect(await context.cookies()).toEqual(cookiesAfterTampering);

        // Rendering the error must not repair the mismatched references.
        const repeated = await page.reload();
        expect(repeated?.status()).toBe(invalidScreenStatus);
        await expect(page.locator('form')).toHaveCount(0);
        expect(await context.cookies()).toEqual(cookiesAfterTampering);
      });
    }

    for (const query of ['', '?transaction_id=another-flow', '?transaction_id=one&transaction_id=two']) {
      test(`should refuse the ${screen} screen with an absent, mismatched or repeated URL reference (${query})`, async ({ page, baseURL }) => {
        const issuer = requireBaseUrl(baseURL);
        await page.goto(`${clientBaseURL}/start`);
        const response = await page.goto(`${issuer}/${screen}${query}`);

        expect(response?.status()).toBeGreaterThanOrEqual(400);
        await expect(page.locator('input[name="csrf_token"]')).toHaveCount(0);
      });
    }

    for (const mutation of ['missing-url', 'wrong-url', 'repeated-url', 'missing-hidden', 'wrong-hidden', 'missing-csrf', 'wrong-csrf', 'missing-cookie', 'wrong-cookie'] as const) {
      test(`should refuse the ${screen} submission with ${mutation} before advancing the flow`, async ({ page, context, baseURL }) => {
        const issuer = requireBaseUrl(baseURL);
        await openScreen(page, screen);
        const sessionsBefore = (await context.cookies()).filter((cookie) => cookie.name === 'session_id');
        await expect(page.locator('input[name="transaction_id"]')).toHaveCount(1);

        await tamperSubmission(page, context, mutation);
        await submitScreen(page, screen);

        await expect(page.locator('input[name="csrf_token"]')).toHaveCount(0);
        expect(new URL(page.url()).origin).toBe(new URL(issuer).origin);
        expect(new URL(page.url()).searchParams.get('code')).toBe(null);
        expect((await context.cookies()).filter((cookie) => cookie.name === 'session_id')).toEqual(sessionsBefore);
      });
    }
  }

  test('should preserve the transaction ID across a failed login and a successful retry', async ({ page }) => {
    await page.goto(`${clientBaseURL}/start`);
    const transactionId = new URL(page.url()).searchParams.get('transaction_id');
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('incorrect-password');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page.getByText(/Invalid credentials/)).toBeVisible();
    expect(new URL(page.url()).searchParams.get('transaction_id')).toBe(transactionId);
    await expect(page.locator('input[name="transaction_id"]')).toHaveValue(transactionId ?? '');

    await login(page);
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('transaction_id')).toBe(transactionId);
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
  });

  test('should match the URL and hidden transaction IDs to the HttpOnly cookie', async ({
    page,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);

    await page.goto(`${clientBaseURL}/start`);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=[^&]+$`));

    // Read the whole jar rather than filtering by URL: the cookie is marked
    // Secure, so a URL filter on the plain-HTTP test issuer would exclude it even
    // though the browser stores and replays it for a loopback origin.
    const cookies = await page.context().cookies();
    const transaction = cookies.find((cookie) => cookie.name === '__Host-oidc_txn');

    // The browser still protects the cookie with HttpOnly and the host prefix.
    expect(transaction?.httpOnly).toBe(true);
    expect(transaction?.sameSite).toBe('Lax');
    expect(transaction?.path).toBe('/');
    expect((transaction?.value ?? '').length).toBe(43);
    expect(new URL(page.url()).searchParams.get('transaction_id')).toBe(transaction?.value);
    await expect(page.locator('input[name="transaction_id"]')).toHaveValue(transaction?.value ?? '');
    await expect(page.locator('input[name="csrf_token"]')).toHaveCount(1);
    await expect(page.locator('input[name="transaction_id"]')).toHaveCount(1);
  });

  test('should refuse to show the login form to a different browser opening the same URL', async ({
    page,
    browser,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);

    await page.goto(`${clientBaseURL}/start`);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=[^&]+$`));

    // A second browser context is a different User-Agent with its own cookie
    // jar. Knowing the URL never replaces the matching transaction cookie.
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
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=[^&]+$`));

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

  // The URL and cookie must continue to agree until the consent decision, so a
  // reload re-renders the same transaction's form instead of stranding the
  // End-User.
  test('should keep the login and consent pages working across a reload', async ({ page, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);

    await page.goto(`${clientBaseURL}/start`);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=[^&]+$`));
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=[^&]+$`));
    await login(page);

    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=[^&]+$`));
    await page.reload();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(clientBaseURL)}/callback\\?`));
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
  });

  // A stored copy could show the csrf_token of one transaction to another browser or to
  // a later flow (RFC 9111 §5.2.2.5). Every OP sends the same header: on
  // Next.js, next.config.mjs sets it over the one Next.js sends for dynamic
  // pages.
  test('should forbid caches from storing the login and consent pages', async ({ page, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);

    const loginResponse = await page.goto(`${clientBaseURL}/start`);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=[^&]+$`));
    expect(loginResponse?.headers()['cache-control']).toBe('no-store');

    await login(page);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=[^&]+$`));
    // Reloading must preserve both the transaction query and no-store policy.
    const consentResponse = await page.reload();
    expect(consentResponse?.headers()['cache-control']).toBe('no-store');

    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
  });

  test('should clear the transaction cookie once the flow is finished', async ({ page, baseURL }) => {
    requireBaseUrl(baseURL);

    await page.goto(`${clientBaseURL}/start`);
    await login(page);
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');

    const cookies = await page.context().cookies();
    expect(cookies.some((cookie) => cookie.name === '__Host-oidc_txn')).toBe(false);
  });

  // The E2E client (another port on the same host) is same-site but
  // cross-origin, the shape of a sibling subdomain: the browser attaches the
  // SameSite=Lax transaction cookie to its form POST. The forged form copies
  // every hidden field of the real one to model an attacker who knows them all. Only the
  // browser's own Origin / Sec-Fetch-Site gives the submission away.
  test('should not sign in through a login form posted from another origin of the same site', async ({
    page,
    context,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);

    await page.goto(`${clientBaseURL}/start`);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=[^&]+$`));
    const hiddenFields = await page
      .locator('form input[type="hidden"]')
      .evaluateAll((inputs) =>
        inputs.map((input): [string, string] => [
          (input as HTMLInputElement).name,
          (input as HTMLInputElement).value,
        ]),
      );
    // Keep the real form's action query and encoding.
    const action = await page.locator('form').first().evaluate((form) => (form as HTMLFormElement).action);
    const enctype = await page.locator('form').first().evaluate((form) => (form as HTMLFormElement).enctype);

    const attackerPage = await context.newPage();
    await attackerPage.goto(clientBaseURL);
    await Promise.all([
      attackerPage.waitForNavigation(),
      attackerPage.evaluate(
        ({ action, encoding, fields }) => {
          const form = document.createElement('form');
          form.method = 'POST';
          form.action = action;
          form.enctype = encoding;
          for (const [name, value] of fields) {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = name;
            input.value = value;
            form.append(input);
          }
          document.body.append(form);
          form.submit();
        },
        {
          action,
          encoding: enctype,
          fields: [...hiddenFields, ['username', 'testuser'], ['password', 'password']] as Array<[string, string]>,
        },
      ),
    ]);

    await expect(attackerPage).not.toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=[^&]+$`));
    const cookies = await context.cookies();
    expect(cookies.some((cookie) => cookie.name === 'session_id')).toBe(false);
    await attackerPage.close();

    // The End-User's own form, submitted from the OP's page, still works.
    await login(page);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=[^&]+$`));
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
    await expect(firstTab).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=[^&]+$`));
    await secondTab.goto(`${clientBaseURL}/start`);
    await expect(secondTab).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=[^&]+$`));

    await login(firstTab);
    await expect(firstTab.getByText('Invalid authorization transaction.')).toBeVisible();
    await expect(firstTab.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    await login(secondTab);
    await secondTab.getByRole('button', { name: 'Approve' }).click();
    await expect(secondTab).toHaveURL(new RegExp(`^${escapeRegExp(clientBaseURL)}/callback\\?`));
    await expect(secondTab.getByTestId('token-type')).toHaveText('Bearer');

    await secondTab.close();
  });
});

/** Start another live authorization transaction without changing the original browser's cookies. */
async function separateLoginTransaction(browser: Browser): Promise<{ transactionId: string; csrfToken: string }> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openScreen(page, 'login');
    return {
      transactionId: await page.locator('input[name="transaction_id"]').inputValue(),
      csrfToken: await page.locator('input[name="csrf_token"]').inputValue(),
    };
  } finally {
    await context.close();
  }
}

/** Replace just the cookie or displayed URL reference while leaving the current form untouched. */
async function replaceScreenReference(
  page: Page,
  context: BrowserContext,
  reference: 'cookie' | 'query',
  transactionId: string,
): Promise<void> {
  if (reference === 'cookie') {
    const cookie = (await context.cookies()).find((cookie) => cookie.name === '__Host-oidc_txn');
    if (!cookie) throw new Error('The authorization response must set the transaction cookie');
    await context.addCookies([{ ...cookie, value: transactionId }]);
    return;
  }
  const url = new URL(page.url());
  url.searchParams.set('transaction_id', transactionId);
  await page.evaluate((value) => window.history.replaceState(null, '', value), url.toString());
}

/** Open the requested screen using the real authorization and password flow. */
async function openScreen(page: Page, screen: 'login' | 'consent'): Promise<void> {
  await page.goto(`${clientBaseURL}/start`);
  if (screen === 'consent') await login(page);
}

/** Submit credentials or an explicit approval from the displayed screen. */
async function submitScreen(page: Page, screen: 'login' | 'consent'): Promise<void> {
  if (screen === 'login') await login(page);
  else await page.getByRole('button', { name: 'Approve' }).click();
}

/** Change one reference while preserving the other form fields and browser cookies. */
async function tamperSubmission(page: Page, context: BrowserContext, mutation: string): Promise<void> {
  await page.locator('form').first().evaluate((form, change) => {
    const element = form as HTMLFormElement;
    // Consent's button named action shadows form.action in the DOM.
    const target = new URL(element.getAttribute('action') ?? '', window.location.href);
    if (change === 'missing-url') target.searchParams.delete('transaction_id');
    if (change === 'wrong-url') target.searchParams.set('transaction_id', 'another-flow');
    if (change === 'repeated-url') target.searchParams.append('transaction_id', target.searchParams.get('transaction_id') ?? '');
    element.setAttribute('action', target.toString());
    const hidden = element.querySelector<HTMLInputElement>('input[name="transaction_id"]');
    if (change === 'missing-hidden') hidden?.remove();
    if (change === 'wrong-hidden' && hidden) hidden.value = 'another-flow';
    const csrf = element.querySelector<HTMLInputElement>('input[name="csrf_token"]');
    if (change === 'missing-csrf') csrf?.remove();
    if (change === 'wrong-csrf' && csrf) csrf.value = 'another-csrf';
  }, mutation);
  if (mutation === 'missing-cookie') await context.clearCookies({ name: '__Host-oidc_txn' });
  if (mutation === 'wrong-cookie') {
    const cookie = (await context.cookies()).find((cookie) => cookie.name === '__Host-oidc_txn');
    if (!cookie) throw new Error('The authorization response must set the transaction cookie');
    await context.addCookies([{ ...cookie, value: 'another-flow' }]);
  }
}

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
