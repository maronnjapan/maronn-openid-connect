import { expect, test } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const clientId = 'e2e-client';

/**
 * EXPERIMENTAL — JWT Secured Authorization Response Mode (JARM).
 *
 * Only the samples generated with `--enable jarm` interpret the JWT response
 * modes, so every test here skips when discovery does not advertise them. That
 * keeps the shared spec suite green across all sample OPs.
 *
 * The client half of the contract (JARM §2.4: verify the JWS with a key from the
 * OP's jwks_uri, check iss / aud / exp, reject alg=none) lives in
 * tests/e2e/apps/client.mjs and throws on any violation — so a rendered result
 * page is itself evidence that verification passed.
 */
test.describe('JWT Secured Authorization Response Mode (JARM)', () => {
  test('should return the authorization response as a verifiable signed JWT', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const responseModes = await supportedResponseModes(request, issuer);
    test.skip(
      !responseModes.includes('query.jwt'),
      'This sample OP was generated without --enable jarm',
    );

    const redirectUri = `${clientBaseURL}/callback`;

    await page.goto(`${clientBaseURL}/start-jarm`);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=`));

    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=`));

    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(redirectUri)}\\?response=`));

    // JARM §2.3.1: `response` is the only query parameter. The plain code /
    // state / iss parameters are gone — the JWT's iss claim replaces RFC 9207's
    // iss parameter (RFC 9700 §2.1 accepts JARM for issuer identification).
    const callbackUrl = new URL(page.url());
    expect([...callbackUrl.searchParams.keys()]).toEqual(['response']);

    // JARM §2.1 / §2.4, checked by the client before it used the code.
    await expect(page.getByTestId('jarm-alg')).toHaveText('RS256');
    await expect(page.getByTestId('jarm-iss')).toHaveText(issuer);
    await expect(page.getByTestId('jarm-aud')).toHaveText(clientId);
    await expect(page.getByTestId('jarm-signature-valid')).toHaveText('true');
    await expect(page.getByTestId('jarm-claim-names')).toHaveText('aud code exp iss state');

    // The code carried by the JWT is an ordinary authorization code: the token
    // endpoint and UserInfo are untouched by JARM.
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');
    await expect(page.getByTestId('userinfo-sub')).toHaveText('testuser');
  });

  test('should return a signed error JWT when the End-User denies consent', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const responseModes = await supportedResponseModes(request, issuer);
    test.skip(
      !responseModes.includes('query.jwt'),
      'This sample OP was generated without --enable jarm',
    );

    const redirectUri = `${clientBaseURL}/callback`;

    await page.goto(`${clientBaseURL}/start-jarm`);
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=`));

    await page.getByRole('button', { name: 'Deny' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(redirectUri)}\\?response=`));

    const callbackUrl = new URL(page.url());
    expect([...callbackUrl.searchParams.keys()]).toEqual(['response']);

    // JARM §2.1 error example: an error response is the same signed JWT shape,
    // so the client can verify that the OP it trusts is the one that refused.
    await expect(page.getByTestId('authorization-error')).toHaveText('access_denied');
    await expect(page.getByTestId('jarm-alg')).toHaveText('RS256');
    await expect(page.getByTestId('jarm-signature-valid')).toHaveText('true');
    await expect(page.getByTestId('jarm-claim-names')).toHaveText('aud error exp iss state');
  });

  test('should reject an unsupported JWT response mode with a plain error', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const responseModes = await supportedResponseModes(request, issuer);
    test.skip(
      !responseModes.includes('query.jwt'),
      'This sample OP was generated without --enable jarm',
    );

    // JARM §2.3.2: fragment.jwt is for response types that return tokens in the
    // fragment, which this OP does not implement. The rejection cannot itself be
    // delivered in that mode, so it comes back as a plain query error.
    const response = await request.get(
      `${issuer}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(`${clientBaseURL}/callback`)}` +
        '&scope=openid&state=e2e-jarm-state&response_mode=fragment.jwt' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      { maxRedirects: 0 },
    );

    expect(response.status()).toBe(302);
    const location = new URL(response.headers()['location'] ?? '');
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('error_description')).toBe(
      'response_mode fragment.jwt is not supported',
    );
    expect(location.searchParams.get('state')).toBe('e2e-jarm-state');
    expect(location.searchParams.get('response')).toBe(null);
  });

  test('should advertise the JWT response modes and signing algorithm in discovery', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const metadata = await discoveryMetadata(request, issuer);
    test.skip(
      !(metadata.response_modes_supported ?? []).includes('query.jwt'),
      'This sample OP was generated without --enable jarm',
    );

    // JARM §4: both AS metadata members the specification defines for JARM.
    expect(metadata.response_modes_supported).toEqual(['query', 'query.jwt', 'jwt']);
    expect(metadata.authorization_signing_alg_values_supported).toEqual(['RS256']);
  });

  test('should keep the plain query response for a request without response_mode', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const responseModes = await supportedResponseModes(request, issuer);
    test.skip(
      !responseModes.includes('query.jwt'),
      'This sample OP was generated without --enable jarm',
    );

    // Enabling JARM must not change anything for a client that did not ask for
    // it: the default response is still the plain query one.
    await page.goto(`${clientBaseURL}/start`);
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await page.getByRole('button', { name: 'Approve' }).click();

    const callbackUrl = new URL(page.url());
    expect([...callbackUrl.searchParams.keys()].sort()).toEqual(['code', 'iss', 'state']);
    expect(callbackUrl.searchParams.get('iss')).toBe(issuer);
  });
});

interface DiscoveryMetadata {
  response_modes_supported?: string[];
  authorization_signing_alg_values_supported?: string[];
}

async function discoveryMetadata(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  issuer: string,
): Promise<DiscoveryMetadata> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  return (await response.json()) as DiscoveryMetadata;
}

async function supportedResponseModes(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  issuer: string,
): Promise<string[]> {
  return (await discoveryMetadata(request, issuer)).response_modes_supported ?? [];
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
