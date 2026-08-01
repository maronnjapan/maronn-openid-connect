import { expect, test } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const resourceServerPort = Number(process.env.E2E_RESOURCE_SERVER_PORT ?? '3030');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const resourceServerURL =
  process.env.E2E_RESOURCE_SERVER_URL ?? `http://${host}:${resourceServerPort}`;
const clientId = 'e2e-client';
const clientSecret = 'e2e-client-secret';
const EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/**
 * EXPERIMENTAL — OAuth 2.0 Token Exchange (RFC 8693).
 *
 * Only samples generated with `--enable token-exchange` dispatch the grant, so
 * every test here skips when discovery does not advertise the URN. That keeps
 * the shared spec suite green across all sample OPs.
 */
test.describe('Token Exchange (RFC 8693)', () => {
  test('should exchange a browser-obtained access token for a narrowed one', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const supported = await supportsTokenExchange(request, issuer);
    test.skip(!supported, 'This sample OP was generated without --enable token-exchange');

    // The full Authorization Code Flow runs in a real browser first; the client
    // then exchanges the resulting access token over the back channel.
    await page.goto(`${clientBaseURL}/start-exchange`);
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await page.getByRole('button', { name: 'Approve' }).click();

    // RFC 8693 §2.2.1 response members.
    await expect(page.getByTestId('exchange-subject-scope')).toHaveText('openid profile email');
    await expect(page.getByTestId('exchange-issued-token-type')).toHaveText(ACCESS_TOKEN_TYPE);
    await expect(page.getByTestId('exchange-token-type')).toHaveText('Bearer');
    // The exchange asked for a subset of the subject token's scope.
    await expect(page.getByTestId('exchange-scope')).toHaveText('openid profile');
    // RFC 8693 §2.2.1: no refresh token is issued for an exchange.
    await expect(page.getByTestId('exchange-refresh-token')).toHaveText('');

    // RFC 8693 §1.1 impersonation: the exchanged token still acts as the user.
    await expect(page.getByTestId('exchange-userinfo-sub')).toHaveText('testuser');
    // email was dropped from the scope, so the UserInfo response no longer carries it.
    await expect(page.getByTestId('exchange-userinfo-email')).toHaveText('');

    // The exchanged token inherited the subject token's audience, so the
    // resource server's aud check still passes.
    await expect(page.getByTestId('exchange-resource-subject')).toHaveText('testuser');
    await expect(page.getByTestId('exchange-resource-client-id')).toHaveText(clientId);
    await expect(page.getByTestId('exchange-resource-scope')).toHaveText('openid profile');
    await expect(page.getByTestId('exchange-resource-audience')).toContainText(resourceServerURL);
  });

  test('should advertise the exchange grant in discovery', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const supported = await supportsTokenExchange(request, issuer);
    test.skip(!supported, 'This sample OP was generated without --enable token-exchange');

    const metadata = await grantTypesSupported(request, issuer);

    expect(metadata.includes(EXCHANGE_GRANT_TYPE)).toBe(true);
  });

  test('should reject an unauthenticated exchange', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const supported = await supportsTokenExchange(request, issuer);
    test.skip(!supported, 'This sample OP was generated without --enable token-exchange');

    const response = await request.post(`${issuer}/token`, {
      form: {
        grant_type: EXCHANGE_GRANT_TYPE,
        subject_token: 'irrelevant',
        subject_token_type: ACCESS_TOKEN_TYPE,
        client_id: clientId,
      },
    });

    expect(response.status()).toBe(401);
    expect((await response.json()).error).toBe('invalid_client');
  });

  // RFC 8693 §2.2.2 routes an invalid subject_token to invalid_request, not to
  // invalid_grant, and the description does not reveal why it failed.
  test('should reject an unknown subject_token with invalid_request', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const supported = await supportsTokenExchange(request, issuer);
    test.skip(!supported, 'This sample OP was generated without --enable token-exchange');

    const response = await request.post(`${issuer}/token`, {
      form: {
        grant_type: EXCHANGE_GRANT_TYPE,
        subject_token: 'never-issued-token',
        subject_token_type: ACCESS_TOKEN_TYPE,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });

    expect(response.status()).toBe(400);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'The provided subject_token is not valid',
    });
  });

  // Delegation (RFC 8693 §1.1 / §4) is out of scope for this feature and is
  // refused before the subject token is even looked up.
  test('should reject a delegation request carrying actor_token', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const supported = await supportsTokenExchange(request, issuer);
    test.skip(!supported, 'This sample OP was generated without --enable token-exchange');

    const response = await request.post(`${issuer}/token`, {
      form: {
        grant_type: EXCHANGE_GRANT_TYPE,
        subject_token: 'never-issued-token',
        subject_token_type: ACCESS_TOKEN_TYPE,
        actor_token: 'never-issued-token',
        actor_token_type: ACCESS_TOKEN_TYPE,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description:
        'Delegation is not supported: actor_token and actor_token_type must not be present.',
    });
  });

  // The target policy (allowedTargets, including invalid_target) needs a live
  // subject token, so it is covered by the generated conformance contract tests
  // rather than duplicated here.
});

async function grantTypesSupported(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  issuer: string,
): Promise<string[]> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  const metadata = (await response.json()) as { grant_types_supported?: string[] };
  return metadata.grant_types_supported ?? [];
}

async function supportsTokenExchange(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  issuer: string,
): Promise<boolean> {
  return (await grantTypesSupported(request, issuer)).includes(EXCHANGE_GRANT_TYPE);
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (baseURL === undefined) {
    throw new Error('baseURL is not configured');
  }
  return baseURL;
}
