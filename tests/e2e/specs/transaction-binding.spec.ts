import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const clientId = 'e2e-client';

/**
 * Auth transaction / User-Agent binding (OIDC Core 1.0 §3.1.2.3 / §3.1.2.4).
 *
 * The spec assumes the End-User who authenticates and grants consent is the one
 * behind the User-Agent that sent the authorization request, but leaves the
 * mechanism to the implementation. The generated OP hands that browser a secret
 * in an HttpOnly cookie named per transaction, so `transaction_id` — which rides
 * in the URL and leaks through history, logs and shared screens — is not on its
 * own enough to drive any step of the flow.
 *
 * These run in a real browser, which is the only place the cookie attributes
 * (HttpOnly / Secure / SameSite=Lax / per-transaction name) are actually
 * exercised: the conformance tests set the Cookie header by hand.
 *
 * This is an OPT-IN feature (`--enable transaction-binding`): no spec clause
 * requires it, and making it mandatory would force a cookie jar on anyone
 * driving the OP by hand, which is the primary way this library gets used. So
 * every test here skips when the sample OP was generated without it — the same
 * shape as the PAR / token-exchange specs. The cookie-free default is pinned as
 * a contract by the generated conformance.test.ts instead.
 */
test.describe('Auth transaction User-Agent binding', () => {
  const UNBOUND_MESSAGE = 'This authorization transaction was not started by this browser.';

  /**
   * Probe the OP itself rather than discovery: transaction binding is not an
   * advertised metadata capability (no spec defines one), so the observable
   * signal is whether /authorize hands the browser a per-transaction cookie.
   */
  async function supportsTransactionBinding(
    request: APIRequestContext,
    issuer: string,
  ): Promise<boolean> {
    const res = await request.get(
      `${issuer}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(`${clientBaseURL}/callback`)}` +
        '&scope=openid&state=binding-probe' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      { maxRedirects: 0 },
    );
    return (res.headers()['set-cookie'] ?? '').includes('oidc_txn_');
  }

  test('should refuse to show the consent form to a different browser holding the same transaction_id', async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(
      !(await supportsTransactionBinding(request, issuer)),
      'This sample OP was generated without --enable transaction-binding',
    );

    // Victim's browser drives the flow up to the consent screen.
    await page.goto(`${clientBaseURL}/start`);
    await login(page);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=`));
    const consentUrl = page.url();

    // A second browser context is a different User-Agent with its own cookie
    // jar: it has the URL (so it has transaction_id) but not the binding secret.
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await otherPage.goto(consentUrl);

    await expect(otherPage.getByText(UNBOUND_MESSAGE)).toBeVisible();
    // The csrf_token that guards POST /consent is never handed out, and neither
    // is the form that would submit it.
    await expect(otherPage.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(otherPage.locator('input[name="csrf_token"]')).toHaveCount(0);
    await otherContext.close();

    // The binding blocks the impostor without disturbing the real End-User.
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(clientBaseURL)}/callback\\?`));
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
  });

  test('should refuse to show the login form to a different browser holding the same transaction_id', async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(
      !(await supportsTransactionBinding(request, issuer)),
      'This sample OP was generated without --enable transaction-binding',
    );

    await page.goto(`${clientBaseURL}/start`);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=`));
    const loginUrl = page.url();

    // Attack shape the RP's state check cannot catch: the attacker starts a flow
    // with their own client and lures the victim to authenticate into it. The
    // victim's browser holds no binding secret for that transaction.
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await otherPage.goto(loginUrl);

    await expect(otherPage.getByText(UNBOUND_MESSAGE)).toBeVisible();
    await expect(otherPage.getByRole('button', { name: 'Login' })).toHaveCount(0);
    await expect(otherPage.locator('input[name="csrf_token"]')).toHaveCount(0);
    await otherContext.close();
  });

  test('should keep the binding cookie HttpOnly and scoped to its own transaction', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(
      !(await supportsTransactionBinding(request, issuer)),
      'This sample OP was generated without --enable transaction-binding',
    );

    await page.goto(`${clientBaseURL}/start`);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=`));
    const transactionId = requireSearchParam(new URL(page.url()), 'transaction_id');

    // Read the whole jar rather than filtering by URL: the cookie is marked
    // Secure, so a URL filter on the plain-HTTP test issuer would exclude it even
    // though the browser stores and replays it for a loopback origin.
    const cookies = await page.context().cookies();
    const binding = cookies.find((cookie) => cookie.name === `oidc_txn_${transactionId}`);

    // Named per transaction (so concurrent tabs do not overwrite each other) and
    // unreadable from JavaScript, which is what keeps an XSS from lifting it.
    expect(binding?.name).toBe(`oidc_txn_${transactionId}`);
    expect(binding?.httpOnly).toBe(true);
    expect(binding?.sameSite).toBe('Lax');
    expect(binding?.path).toBe('/');
    // The cookie carries the secret itself; only its hash is stored server-side.
    expect((binding?.value ?? '').length).toBe(43);
  });

  test('should complete two concurrent authorization flows in the same browser', async ({
    page,
    context,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(
      !(await supportsTransactionBinding(request, issuer)),
      'This sample OP was generated without --enable transaction-binding',
    );

    // Two tabs, one cookie jar. A single shared binding cookie would make the
    // second /authorize overwrite the first tab's secret and break it.
    const firstTab = page;
    const secondTab = await context.newPage();

    await firstTab.goto(`${clientBaseURL}/start`);
    await expect(firstTab).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=`));
    await secondTab.goto(`${clientBaseURL}/start`);
    await expect(secondTab).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=`));

    await login(firstTab);
    await login(secondTab);

    await firstTab.getByRole('button', { name: 'Approve' }).click();
    await secondTab.getByRole('button', { name: 'Approve' }).click();

    await expect(firstTab).toHaveURL(new RegExp(`^${escapeRegExp(clientBaseURL)}/callback\\?`));
    await expect(secondTab).toHaveURL(new RegExp(`^${escapeRegExp(clientBaseURL)}/callback\\?`));
    await expect(firstTab.getByTestId('token-type')).toHaveText('Bearer');
    await expect(secondTab.getByTestId('token-type')).toHaveText('Bearer');

    const firstCode = requireSearchParam(new URL(firstTab.url()), 'code');
    const secondCode = requireSearchParam(new URL(secondTab.url()), 'code');
    expect(firstCode === secondCode).toBe(false);

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

function requireSearchParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new Error(`Missing search parameter: ${name}`);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
