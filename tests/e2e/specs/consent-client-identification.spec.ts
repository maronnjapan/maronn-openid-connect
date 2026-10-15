import { expect, test, type Page } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL = process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const resourceServerPort = Number(process.env.E2E_RESOURCE_SERVER_PORT ?? '3030');
const resourceServerURL =
  process.env.E2E_RESOURCE_SERVER_URL ?? `http://${host}:${resourceServerPort}`;

/**
 * Consent screen client identification (OIDC Dynamic Client Registration 1.0
 * §2 / RFC 7591 §2: client_name / client_uri / policy_uri / tos_uri).
 *
 * RFC 6749 §10.2 counts on the resource owner's active involvement against
 * client impersonation, which works only while the End-User can identify the
 * client on the consent screen (OIDC Core 1.0 §3.1.2.4 requires an
 * authorization decision before information is released). The generated
 * consent screen therefore renders the registered client_name NEXT TO the
 * client_id (the name is self-asserted and spoofable, so it must not replace
 * the identifier) and the registered document URIs as links, while a client
 * that registered nothing keeps the plain client_id display.
 *
 * logo_uri is registered for the e2e client on purpose: the default view must
 * NOT render it (a client-chosen <img> URL is a default phishing surface), and
 * the <img>-free markup is pinned here.
 */
test.describe('Consent screen client identification', () => {
  test('should display the registered client_name with the client_id and document links', async ({
    page,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    await page.goto(`${clientBaseURL}/start`);
    await login(page);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent$`));

    // client_name is rendered, and the client_id stays visible beside it.
    await expect(page.locator('strong', { hasText: 'E2E Test Client' })).toBeVisible();
    await expect(page.locator('code', { hasText: 'e2e-client' })).toBeVisible();

    // The registered document URIs become links (scheme-checked http/https).
    await expect(page.getByRole('link', { name: 'Website' })).toHaveAttribute(
      'href',
      `${clientBaseURL}/`,
    );
    await expect(page.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      `${clientBaseURL}/privacy-policy`,
    );
    await expect(page.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
      'href',
      `${clientBaseURL}/terms-of-service`,
    );

    // The registered logo_uri is NOT rendered by the default view.
    await expect(page.locator('img')).toHaveCount(0);

    // The enriched screen still completes the flow.
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(clientBaseURL)}/callback\\?`));
    expect(new URL(page.url()).searchParams.get('error')).toBe(null);
  });

  test('should fall back to the client_id when the client registered no display metadata', async ({
    page,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    // e2e-resource-server registers no client_name / policy_uri / tos_uri, and
    // no client app drives it through a browser, so the authorization request
    // is built directly. The code is never redeemed; only the consent screen
    // matters, so the static S256 test vector of RFC 7636 Appendix B suffices.
    const authorizeUrl = new URL(`${issuer}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', 'e2e-resource-server');
    authorizeUrl.searchParams.set('redirect_uri', `${resourceServerURL}/unused-callback`);
    authorizeUrl.searchParams.set('scope', 'openid');
    authorizeUrl.searchParams.set('state', 'consent-display-fallback');
    authorizeUrl.searchParams.set(
      'code_challenge',
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    await page.goto(authorizeUrl.toString());
    await login(page);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent$`));

    // Unregistered metadata degrades to the plain client_id display: no name,
    // no document links.
    await expect(page.locator('strong', { hasText: 'e2e-resource-server' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Privacy Policy' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Terms of Service' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Website' })).toHaveCount(0);
  });
});

async function login(page: Page): Promise<void> {
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (!baseURL) {
    throw new Error('Playwright baseURL must be configured for the OP under test');
  }
  return baseURL;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
