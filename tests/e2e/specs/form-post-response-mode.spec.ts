import { expect, test, type Page } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const clientId = 'e2e-client';
const redirectUri = `${clientBaseURL}/callback`;

/**
 * OAuth 2.0 Form Post Response Mode.
 *
 * With response_mode=form_post the OP answers with an HTML form whose action is
 * the redirect URI, and the browser POSTs the authorization response to it
 * (§2). The E2E client (tests/e2e/apps/client.mjs) accepts the POST only with
 * a form-encoded body and no query, and reports the method it was called
 * with, so a rendered result page that says POST is the evidence.
 *
 * A sample OP generated with `--disable form-post-response-mode` does not
 * advertise form_post, and every test here skips itself.
 */
test.describe('OAuth 2.0 Form Post Response Mode', () => {
  test('should post the authorization code to the redirect URI after consent', async ({ page, request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsFormPost(request, issuer)), 'This sample OP was generated without form-post-response-mode');

    await page.goto(`${clientBaseURL}/start-form-post`);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Approve' }).click();

    // §2: the browser lands on the redirect URI itself, and nothing rides in its query.
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
    expect(page.url()).toBe(redirectUri);
    await expect(page.getByTestId('callback-method')).toHaveText('POST');
    // RFC 9207 §2: iss is posted beside code and state.
    await expect(page.getByTestId('authorization-issuer')).toHaveText(issuer);
    await expect(page.getByTestId('userinfo-sub')).toHaveText('testuser');
  });

  // RFC 6749 §4.1.2.1: the error goes back in the response mode the request asked for.
  test('should post access_denied to the redirect URI when the End-User denies consent', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsFormPost(request, issuer)), 'This sample OP was generated without form-post-response-mode');

    await page.goto(`${clientBaseURL}/start-form-post`);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Deny' }).click();

    await expect(page.getByTestId('authorization-error')).toHaveText('access_denied');
    expect(page.url()).toBe(redirectUri);
    await expect(page.getByTestId('callback-method')).toHaveText('POST');
    await expect(page.getByTestId('authorization-issuer')).toHaveText(issuer);
  });

  // The authorization endpoint itself answers in form_post when it issues the
  // code without a screen (OIDC Core 1.0 §3.1.2.1 prompt=none).
  test('should post the code from the authorization endpoint for prompt=none', async ({ page, request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsFormPost(request, issuer)), 'This sample OP was generated without form-post-response-mode');

    await page.goto(`${clientBaseURL}/start-form-post`);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');

    await page.goto(`${clientBaseURL}/start-form-post?prompt=none`);

    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
    expect(page.url()).toBe(redirectUri);
    await expect(page.getByTestId('callback-method')).toHaveText('POST');
  });

  // Form Post Response Mode §2 / Appendix A: a page of the OP, never a
  // redirect, that the User Agent is told not to store.
  test('should answer a redirectable error with a form page that must not be stored', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsFormPost(request, issuer)), 'This sample OP was generated without form-post-response-mode');

    const response = await request.get(
      `${issuer}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        '&scope=profile&state=e2e-form-post-state&response_mode=form_post' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      { maxRedirects: 0 },
    );

    expect(response.status()).toBe(200);
    expect(response.headers()['location']).toBe(undefined);
    expect(response.headers()['content-type']).toBe('text/html; charset=UTF-8');
    expect(response.headers()['cache-control']).toBe('no-cache, no-store');
    expect(response.headers()['pragma']).toBe('no-cache');
    const html = await response.text();
    expect(html).toContain(`<form method="post" action="${redirectUri}">`);
    expect(html).toContain('<input type="hidden" name="error" value="invalid_scope"/>');
    expect(html).toContain('<input type="hidden" name="state" value="e2e-form-post-state"/>');
    expect(html).toContain(`<input type="hidden" name="iss" value="${issuer}"/>`);
  });

  // OIDC Discovery 1.0 §3.
  test('should advertise form_post in discovery next to query', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const responseModes = await supportedResponseModes(request, issuer);
    test.skip(!responseModes.includes('form_post'), 'This sample OP was generated without form-post-response-mode');

    expect(responseModes.slice(0, 2)).toEqual(['query', 'form_post']);
  });

  test('should keep the plain query response for a request without response_mode', async ({ page, request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsFormPost(request, issuer)), 'This sample OP was generated without form-post-response-mode');

    await page.goto(`${clientBaseURL}/start`);
    await login(page, issuer);
    await page.getByRole('button', { name: 'Approve' }).click();

    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
    expect(page.url()).toMatch(new RegExp(`^${escapeRegExp(redirectUri)}\\?`));
    await expect(page.getByTestId('callback-method')).toHaveText('GET');
  });
});

async function login(page: Page, issuer: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login$`));
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent$`));
}

async function supportedResponseModes(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  issuer: string,
): Promise<string[]> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  return ((await response.json()) as { response_modes_supported?: string[] }).response_modes_supported ?? [];
}

async function supportsFormPost(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  issuer: string,
): Promise<boolean> {
  return (await supportedResponseModes(request, issuer)).includes('form_post');
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
