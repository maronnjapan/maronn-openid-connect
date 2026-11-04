import { expect, test } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const clientId = 'e2e-client';
const clientSecret = 'e2e-client-secret';

// The demo type the app OPs register (apps/*/src/rar-demo.ts): the
// payment_initiation example of RFC 9396 §2.1 Figure 1.
const PAYMENT_DETAIL = {
  type: 'payment_initiation',
  actions: ['initiate'],
  locations: ['https://example.com/payments'],
  instructedAmount: { currency: 'EUR', amount: '123.50' },
};

/**
 * EXPERIMENTAL — Rich Authorization Requests (RFC 9396).
 *
 * Only an OP generated with `--enable rar` (and with type definitions
 * registered) advertises authorization_details_types_supported, so most tests
 * here skip when discovery does not advertise the demo type. That keeps the
 * shared spec suite green across all sample OPs; the one test that runs
 * without the feature shows the parameter is ignored as before.
 */
test.describe('Rich Authorization Requests (RAR)', () => {
  test('should carry the approved details to the token response, the refresh and introspection', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await rarAdvertised(request, issuer)), 'This OP was generated without --enable rar');

    await page.goto(`${clientBaseURL}/start-rar`);
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent$`));

    // RFC 9396 §3.1: the consent screen lists the requested details next to
    // the scopes, with the display line the type definition built.
    await expect(page.getByText('Initiate a payment of EUR 123.50')).toBeVisible();

    await page.getByRole('button', { name: 'Approve' }).click();

    // §7: the token response of the code grant carries the approved details,
    // and a refresh of the same grant carries them unchanged.
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
    await expect(page.getByTestId('rar-token-details')).toHaveText(JSON.stringify([PAYMENT_DETAIL]));
    await expect(page.getByTestId('rar-refresh-details')).toHaveText(JSON.stringify([PAYMENT_DETAIL]));

    // §9.2: introspection reports them as a top-level member.
    await expect(page.getByTestId('rar-introspection-active')).toHaveText('true');
    await expect(page.getByTestId('rar-introspection-details')).toHaveText(JSON.stringify([PAYMENT_DETAIL]));
  });

  test('should advertise the registered types in discovery', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const types = await advertisedTypes(request, issuer);
    test.skip(types === undefined, 'This OP was generated without --enable rar');

    // RFC 9396 §10: exactly the registered demo type.
    expect(types).toEqual(['payment_initiation']);
  });

  test('should reject an unknown type with an invalid_authorization_details redirect', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await rarAdvertised(request, issuer)), 'This OP was generated without --enable rar');

    // RFC 9396 §5: a request with a type the OP does not understand MUST be
    // refused. The error redirects to the client with the registered code.
    await page.goto(`${clientBaseURL}/start-rar?type=account_information`);
    await expect(page.getByTestId('authorization-error')).toHaveText('invalid_authorization_details');
    // The fixed description carries no detail values (RFC 9396 §13).
    await expect(page.getByTestId('authorization-error-description')).toHaveText(
      'The authorization_details parameter is invalid',
    );
  });

  test('should answer prompt=none with consent_required', async ({ page, request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await rarAdvertised(request, issuer)), 'This OP was generated without --enable rar');

    // Details always need fresh consent, and prompt=none forbids showing the
    // consent screen (OIDC Core 1.0 §3.1.2.1), so the request fails up front.
    await page.goto(`${clientBaseURL}/start-rar?prompt=none`);
    await expect(page.getByTestId('authorization-error')).toHaveText('consent_required');
  });

  test('should reject authorization_details at the token endpoint before any side effect', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(!(await rarAdvertised(request, issuer)), 'This OP was generated without --enable rar');

    await page.goto(`${clientBaseURL}/start-rar`);
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
    const refreshToken = await page.getByTestId('rar-refresh-token').textContent();
    expect(refreshToken).not.toBe('');

    // RFC 9396 §6 narrowing is not supported: the request is refused with the
    // registered error code instead of being silently ignored.
    const rejected = await request.post(`${issuer}/token`, {
      form: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken ?? '',
        client_id: clientId,
        client_secret: clientSecret,
        authorization_details: JSON.stringify([PAYMENT_DETAIL]),
      },
    });
    expect(rejected.status()).toBe(400);
    expect(await rejected.json()).toEqual({
      error: 'invalid_authorization_details',
      error_description: 'authorization_details is not accepted at the token endpoint',
    });

    // The rejection happened before any side effect: the presented refresh
    // token was neither rotated nor revoked, so the same token still works.
    const retried = await request.post(`${issuer}/token`, {
      form: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken ?? '',
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(retried.status()).toBe(200);
    const retriedBody = (await retried.json()) as { token_type: string; authorization_details?: unknown };
    expect(retriedBody.token_type).toBe('Bearer');
    expect(retriedBody.authorization_details).toEqual([PAYMENT_DETAIL]);
  });

  test('should complete the flow as before when the OP was generated without rar', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    test.skip(await rarAdvertised(request, issuer), 'This OP answers authorization_details');

    // Without the feature the parameter is an unknown request parameter: the
    // flow completes and no channel carries authorization_details.
    await page.goto(`${clientBaseURL}/start-rar`);
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent$`));
    await page.getByRole('button', { name: 'Approve' }).click();

    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
    await expect(page.getByTestId('rar-token-details')).toHaveText('null');
    await expect(page.getByTestId('rar-refresh-details')).toHaveText('null');
    await expect(page.getByTestId('rar-introspection-details')).toHaveText('null');
  });
});

interface DiscoveryMetadata {
  authorization_details_types_supported?: string[];
}

async function advertisedTypes(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  issuer: string,
): Promise<string[] | undefined> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  const metadata = (await response.json()) as DiscoveryMetadata;
  return metadata.authorization_details_types_supported;
}

async function rarAdvertised(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  issuer: string,
): Promise<boolean> {
  return ((await advertisedTypes(request, issuer)) ?? []).includes('payment_initiation');
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
