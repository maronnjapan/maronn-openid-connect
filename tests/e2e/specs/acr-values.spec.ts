import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const clientId = 'e2e-client';
const clientSecret = 'e2e-client-secret';
const resourceServerClientId = 'e2e-resource-server';
const resourceServerClientSecret = 'e2e-resource-server-secret';

/**
 * OIDC Core 1.0 §3.1.2.1: acr_values is an OPTIONAL, space-separated list of
 * the acr values the client asks for, in order of preference. The OP puts the
 * acr it settles on into the ID Token (§2) and the access token (RFC 9068
 * §2.2.1), stores it with the access token so introspection reports it
 * (RFC 9470 §6.2), and keeps it on a refresh (§12.1).
 *
 * Every sample OP echoes the most preferred requested value: the Hono /
 * Express / Fastify samples pass an acrResolver that also reports amr pwd, and
 * the Next.js sample has the same resolver in the generated provider.ts.
 */
test.describe('acr_values', () => {
  test('should carry the most preferred requested acr in the ID Token, the access token and introspection', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    await authorize(page, 'urn:example:loa:3 urn:example:loa:2');

    const idToken = parseJwtPayload(await requiredText(page, 'token-id-token'));
    expect(idToken).toMatchObject({
      iss: issuer,
      sub: 'testuser',
      aud: clientId,
      acr: 'urn:example:loa:3',
      amr: ['pwd'],
    });

    const accessToken = await requiredText(page, 'token-access-token');
    expect(parseJwtPayload(accessToken)).toMatchObject({
      iss: issuer,
      sub: 'testuser',
      client_id: clientId,
      acr: 'urn:example:loa:3',
    });

    const introspection = await introspect(request, issuer, accessToken);
    expect(introspection).toMatchObject({
      active: true,
      sub: 'testuser',
      client_id: clientId,
      acr: 'urn:example:loa:3',
    });
  });

  // OIDC Core 1.0 §12.1: a refreshed ID Token keeps the acr / amr of the first
  // authentication, and the refreshed access token keeps the same acr.
  test('should keep the acr of the first authentication when the tokens are refreshed', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    await authorize(page, 'urn:example:loa:2');
    const refreshToken = await requiredText(page, 'token-refresh-token');

    const refreshResponse = await request.post(`${issuer}/token`, {
      form: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(refreshResponse.status()).toBe(200);
    const refreshed = (await refreshResponse.json()) as Record<string, unknown>;

    expect(parseJwtPayload(requireString(refreshed.id_token, 'refreshed ID Token'))).toMatchObject({
      sub: 'testuser',
      acr: 'urn:example:loa:2',
      amr: ['pwd'],
    });
    const refreshedAccessToken = requireString(refreshed.access_token, 'refreshed access token');
    expect(parseJwtPayload(refreshedAccessToken)).toMatchObject({
      sub: 'testuser',
      acr: 'urn:example:loa:2',
    });
    expect(await introspect(request, issuer, refreshedAccessToken)).toMatchObject({
      active: true,
      acr: 'urn:example:loa:2',
    });
  });

  test('should leave acr out of the tokens when the request has no acr_values', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    await authorize(page, undefined);

    const idToken = parseJwtPayload(await requiredText(page, 'token-id-token'));
    expect(idToken.sub).toBe('testuser');
    expect(idToken.acr).toBeUndefined();
    expect(idToken.amr).toBeUndefined();

    const accessToken = await requiredText(page, 'token-access-token');
    const accessTokenClaims = parseJwtPayload(accessToken);
    expect(accessTokenClaims.sub).toBe('testuser');
    expect(accessTokenClaims.acr).toBeUndefined();

    const introspection = await introspect(request, issuer, accessToken);
    expect(introspection.active).toBe(true);
    expect(introspection.acr).toBeUndefined();
  });

  // A value outside the scope-token characters of RFC 6749 §3.3 (here a
  // double quote) is a malformed request: invalid_request, sent back to the
  // client's redirect_uri with the state (OIDC Core 1.0 §3.1.2.6).
  test('should return invalid_request to the client when acr_values holds a disallowed character', async ({
    page,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    await page.goto(`${clientBaseURL}/start?acr_values=${encodeURIComponent('urn:example:loa:2 "loa1"')}`);

    await expect(page.getByRole('heading', { name: 'Authorization Error' })).toBeVisible();
    await expect(page.getByTestId('authorization-error')).toHaveText('invalid_request');
    await expect(page.getByTestId('authorization-error-description')).toHaveText(
      'acr_values must be space-separated values of visible ASCII characters other than double quote and backslash',
    );
    await expect(page.getByTestId('authorization-issuer')).toHaveText(issuer);
    expect(new URL(page.url()).searchParams.get('code')).toBe(null);
  });
});

/** Run the code flow through the E2E client, with acr_values when given. */
async function authorize(page: Page, acrValues: string | undefined): Promise<void> {
  const query = acrValues === undefined ? '' : `?acr_values=${encodeURIComponent(acrValues)}`;
  await page.goto(`${clientBaseURL}/start${query}`);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/consent$/);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Authorization Complete' })).toBeVisible();
}

/** RFC 7662 §2.1: introspect as the resource server (client_secret_basic). */
async function introspect(
  request: APIRequestContext,
  issuer: string,
  token: string,
): Promise<Record<string, unknown>> {
  const response = await request.post(`${issuer}/introspect`, {
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${resourceServerClientId}:${resourceServerClientSecret}`,
      ).toString('base64')}`,
    },
    form: { token, token_type_hint: 'access_token' },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function requiredText(page: Page, testId: string): Promise<string> {
  const value = await page.getByTestId(testId).textContent();
  if (value === null || value.length === 0) {
    throw new Error(`${testId} text is required`);
  }
  return value;
}

function parseJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('JWT must have three compact serialization segments');
  }
  return JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (!baseURL) {
    throw new Error('Playwright baseURL is required');
  }
  return baseURL;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}
