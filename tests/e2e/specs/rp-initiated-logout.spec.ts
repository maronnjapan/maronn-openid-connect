import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const postLogoutRedirectUri = `${clientBaseURL}/logged-out`;

/**
 * EXPERIMENTAL — OpenID Connect RP-Initiated Logout 1.0, end-to-end.
 *
 * The OP under test is a CLI-generated sample started with
 * `--enable rp-initiated-logout` and the E2E client registered in
 * OIDC_POST_LOGOUT_REDIRECT_URIS_JSON (playwright.config.ts). Both scenarios
 * verify the session is really gone by starting a fresh authorization and
 * expecting the login screen instead of SSO.
 */
test.describe('RP-Initiated Logout (RP-Initiated Logout 1.0)', () => {
  test('should log out through the RP link and return with state, ending SSO', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    await skipUnlessLogoutEnabled(request, issuer);

    const idToken = await completeAuthorizationCodeFlow(page, issuer);

    // §2: the RP hands the browser to the end_session_endpoint with the ID
    // Token it holds as the hint. Valid hint + matching session: no
    // confirmation screen, immediate logout, §3 redirect with state echoed.
    await page.goto(
      `${issuer}/logout?id_token_hint=${encodeURIComponent(idToken)}` +
        `&post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirectUri)}` +
        '&state=e2e-logout-state',
    );
    await expect(page).toHaveURL(`${postLogoutRedirectUri}?state=e2e-logout-state`);
    await expect(page.getByTestId('logged-out-state')).toHaveText('e2e-logout-state');

    await expectLoginRequired(page, issuer);
  });

  test('should require an explicit confirmation when no hint is presented', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    await skipUnlessLogoutEnabled(request, issuer);

    await completeAuthorizationCodeFlow(page, issuer);

    // §2 MUST: without a valid id_token_hint the OP asks first. Nothing is
    // deleted until the user approves the confirmation form.
    await page.goto(`${issuer}/logout`);
    await expect(page).toHaveURL(`${issuer}/logout`);
    await expect(page.getByRole('heading', { name: 'Log out' })).toBeVisible();

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('heading', { name: 'Logged out' })).toBeVisible();

    await expectLoginRequired(page, issuer);
  });
});

/** Skip on a sample OP generated without --enable rp-initiated-logout. */
async function skipUnlessLogoutEnabled(
  request: APIRequestContext,
  issuer: string,
): Promise<void> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  expect(response.status()).toBe(200);
  const metadata = await response.json() as { end_session_endpoint?: string };
  test.skip(
    metadata.end_session_endpoint === undefined,
    'This sample OP was generated without --enable rp-initiated-logout',
  );
  expect(metadata.end_session_endpoint).toBe(`${issuer}/logout`);
}

/**
 * Drive the ordinary code flow through the E2E client and return the issued
 * ID Token (the id_token_hint of the logout scenarios).
 */
async function completeAuthorizationCodeFlow(page: Page, issuer: string): Promise<string> {
  await page.goto(`${clientBaseURL}/start`);
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=`));
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();

  // A prior spec (or the first scenario) may have recorded consent for this
  // subject and client, in which case the consent screen is skipped.
  await page.waitForURL(/\/(consent|callback)\?/);
  if (new URL(page.url()).pathname === '/consent') {
    await page.getByRole('button', { name: 'Approve' }).click();
  }
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(clientBaseURL)}/callback\\?`));

  const idToken = (await page.getByTestId('token-id-token').textContent())?.trim() ?? '';
  expect(idToken.split('.')).toHaveLength(3);
  return idToken;
}

/** A fresh authorization must land on the login screen: the SSO session is gone. */
async function expectLoginRequired(page: Page, issuer: string): Promise<void> {
  await page.goto(`${clientBaseURL}/start`);
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=`));
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('Playwright baseURL is not configured');
  return baseURL.replace(/\/$/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
