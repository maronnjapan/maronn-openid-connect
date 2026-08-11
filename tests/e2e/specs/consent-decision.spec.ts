import { expect, test, type Page } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;

/**
 * Consent decision value (OIDC Core 1.0 §3.1.2.4).
 *
 * "Once the End-User is authenticated, the Authorization Server MUST obtain an
 * authorization decision before releasing information to the Relying Party."
 * The generated OP therefore detects the affirmative decision on an allowlist
 * (`action=approve`): a consent POST that carries no decision, or one the OP
 * never agreed to accept, is "no decision obtained" and must not mint a code.
 *
 * These belong in a real browser because the failure modes are browser-shaped:
 * a form submitted programmatically sends no submit-button entry at all, and a
 * customized Approve button sends whatever value the markup carries. The
 * generated conformance tests build the POST body by hand, so they cannot show
 * that the browser really omits / rewrites the field on these paths.
 */
test.describe('Consent decision value', () => {
  const INVALID_DECISION_MESSAGE =
    'Invalid consent decision. Please use the Approve or Deny button.';

  test('should issue an authorization code when the End-User clicks Approve', async ({
    page,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    await page.goto(`${clientBaseURL}/start`);
    await login(page);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=`));

    await page.getByRole('button', { name: 'Approve' }).click();

    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(clientBaseURL)}/callback\\?`));
    expect(new URL(page.url()).searchParams.get('error')).toBe(null);
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
  });

  // form.submit() is the shape a script, a bookmarklet or a rebuilt form takes:
  // the browser serializes the form without any submit-button entry, so `action`
  // never reaches the OP even though transaction_id and csrf_token do.
  test('should not issue an authorization code when the consent form is submitted without the Approve button', async ({
    page,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    await page.goto(`${clientBaseURL}/start`);
    await login(page);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=`));

    await page.evaluate(() => {
      document.querySelector('form')?.submit();
    });

    await expect(page.getByText(INVALID_DECISION_MESSAGE)).toBeVisible();
    expect(new URL(page.url()).origin).toBe(new URL(issuer).origin);
  });

  // The realistic regression the allowlist exists for: a user customizes the
  // consent view and renames the Approve button's value. The Deny button keeps
  // working, so the screen looks healthy — but the approval must now fail loudly
  // instead of being accepted as "not deny".
  test('should not issue an authorization code when the Approve button carries an unknown value', async ({
    page,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    await page.goto(`${clientBaseURL}/start`);
    await login(page);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=`));

    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('button[value="approve"]')?.setAttribute(
        'value',
        'allow',
      );
    });
    await page.getByRole('button', { name: 'Approve' }).click();

    await expect(page.getByText(INVALID_DECISION_MESSAGE)).toBeVisible();
    expect(new URL(page.url()).origin).toBe(new URL(issuer).origin);
  });

  // access_denied means the End-User denied the request (OIDC Core 1.0 §3.1.2.6),
  // which the allowlist must leave untouched: only the affirmative value moved.
  test('should redirect with access_denied when the End-User clicks Deny', async ({
    page,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    await page.goto(`${clientBaseURL}/start`);
    await login(page);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=`));

    await page.getByRole('button', { name: 'Deny' }).click();

    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(clientBaseURL)}/callback\\?`));
    const callbackUrl = new URL(page.url());
    expect(callbackUrl.searchParams.get('error')).toBe('access_denied');
    expect(callbackUrl.searchParams.get('code')).toBe(null);
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
