import { expect, test } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const clientId = 'e2e-client';
const clientSecret = 'e2e-client-secret';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

interface StartedDeviceFlow {
  flow_id: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface DeviceResult {
  status: 'pending' | 'complete' | 'failed';
  error: string | null;
  user_code: string;
  access_token: string | null;
  id_token: string | null;
  scope: string | null;
  token_type: string | null;
}

/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * Only the samples generated with `--enable device-authorization-grant` expose
 * the endpoint, so every test here skips when discovery does not advertise it.
 * That keeps the shared spec suite green across all sample OPs.
 *
 * The device side runs inside the E2E client (`/start-device`), which polls the
 * token endpoint in the background while Playwright drives the browser through
 * the verification UI — the real two-device shape of the flow.
 */
test.describe('Device Authorization Grant (RFC 8628)', () => {
  test('should issue tokens after the user approves on a second device', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await deviceAuthorizationEndpoint(request, issuer);
    test.skip(
      endpoint === undefined,
      'This sample OP was generated without --enable device-authorization-grant',
    );
    expect(endpoint).toBe(`${issuer}/device_authorization`);

    const flow = await startDeviceFlow(request);
    expect(flow.interval).toBe(5);
    expect(flow.expires_in).toBe(600);
    expect(flow.verification_uri).toBe(`${issuer}/device`);

    // RFC 8628 §3.3.1: following verification_uri_complete pre-fills the code.
    await page.goto(flow.verification_uri_complete);
    await expect(page.getByLabel('Code:')).toHaveValue(flow.user_code);

    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();

    // RFC 8628 §5.4: the approval screen repeats the code so the user can check
    // it against the device in front of them.
    await expect(page.getByRole('heading', { name: 'Authorize Device' })).toBeVisible();
    await expect(page.locator('strong').first()).toHaveText(flow.user_code);
    await expect(page.locator('li')).toHaveText(['openid', 'profile', 'email']);

    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('You can close this page and go back to your device.')).toBeVisible();

    const result = await waitForDeviceResult(request, flow.flow_id);
    expect(result.status).toBe('complete');
    expect(result.token_type).toBe('Bearer');
    expect(result.scope).toBe('openid profile email');
    expect(typeof result.id_token).toBe('string');

    // The device's own token reaches the UserInfo endpoint.
    const userInfo = await request.get(`${issuer}/userinfo`, {
      headers: { Authorization: `Bearer ${result.access_token}` },
    });
    expect(userInfo.status()).toBe(200);
    expect((await userInfo.json()).sub).toBe('testuser');
  });

  test('should report access_denied to the device when the user denies', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await deviceAuthorizationEndpoint(request, issuer);
    test.skip(
      endpoint === undefined,
      'This sample OP was generated without --enable device-authorization-grant',
    );

    const flow = await startDeviceFlow(request);

    await page.goto(flow.verification_uri_complete);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect(page.getByText('You can close this page and go back to your device.')).toBeVisible();

    const result = await waitForDeviceResult(request, flow.flow_id);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('access_denied');
    expect(result.access_token).toBe(null);
  });

  test('should answer authorization_pending while the user has not decided', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await deviceAuthorizationEndpoint(request, issuer);
    test.skip(
      endpoint === undefined,
      'This sample OP was generated without --enable device-authorization-grant',
    );

    const authorization = await request.post(`${issuer}/device_authorization`, {
      form: { client_id: clientId, client_secret: clientSecret, scope: 'openid' },
    });
    expect(authorization.status()).toBe(200);
    expect(authorization.headers()['cache-control']).toBe('no-store');
    const codes = await authorization.json() as { device_code: string };

    const poll = await request.post(`${issuer}/token`, {
      form: {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: codes.device_code,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });

    expect(poll.status()).toBe(400);
    expect(await poll.json()).toEqual({
      error: 'authorization_pending',
      error_description: 'The authorization request is still pending',
    });
  });

  test('should refuse the verification steps without the browser binding cookie', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await deviceAuthorizationEndpoint(request, issuer);
    test.skip(
      endpoint === undefined,
      'This sample OP was generated without --enable device-authorization-grant',
    );

    const authorization = await request.post(`${issuer}/device_authorization`, {
      form: { client_id: clientId, client_secret: clientSecret, scope: 'openid' },
    });
    const codes = await authorization.json() as { user_code: string };

    // The attacker knows the user_code (they could have started the flow), so
    // they can obtain a valid csrf_token. Without the binding cookie it is worth
    // nothing: a forged cross-site POST is refused.
    const matched = await request.post(`${issuer}/device`, {
      form: { user_code: codes.user_code },
    });
    const csrfToken = csrfTokenFrom(await matched.text());
    expect(csrfToken.length > 0).toBe(true);

    const forged = await request.post(`${issuer}/device/login`, {
      form: {
        user_code: codes.user_code,
        csrf_token: csrfToken,
        username: 'testuser',
        password: 'password',
      },
      // Playwright's request context keeps cookies, so start from a clean state
      // to model a browser that never held this record's binding cookie.
      headers: { Cookie: '' },
    });

    expect(forged.status()).toBe(403);
  });

  test('should reject a device_code presented by a different client', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await deviceAuthorizationEndpoint(request, issuer);
    test.skip(
      endpoint === undefined,
      'This sample OP was generated without --enable device-authorization-grant',
    );

    const authorization = await request.post(`${issuer}/device_authorization`, {
      form: { client_id: clientId, client_secret: clientSecret, scope: 'openid' },
    });
    const codes = await authorization.json() as { device_code: string };

    // RFC 8628 §3.4: the code belongs to the client it was issued to.
    // e2e-device-other authenticates fine and is registered for the device
    // grant, so the only thing that stops it is the code's client binding.
    const poll = await request.post(`${issuer}/token`, {
      form: {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: codes.device_code,
        client_id: 'e2e-device-other',
        client_secret: 'e2e-device-other-secret',
      },
    });

    expect(poll.status()).toBe(400);
    // The wording matches the unknown-code case so existence is not leaked.
    expect(await poll.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'The device_code is invalid, expired, or was issued to another client',
    });
  });
});

async function startDeviceFlow(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
): Promise<StartedDeviceFlow> {
  const response = await request.get(`${clientBaseURL}/start-device`);
  return await response.json() as StartedDeviceFlow;
}

/**
 * Poll the E2E client until its background device polling settles.
 *
 * The OP's interval is 5 seconds, so the device needs a couple of poll cycles
 * after the browser finishes; 45 seconds leaves room for a slow_down bump.
 */
async function waitForDeviceResult(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  flowId: string,
): Promise<DeviceResult> {
  const deadline = Date.now() + 45_000;
  let result = await readDeviceResult(request, flowId);
  while (result.status === 'pending' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    result = await readDeviceResult(request, flowId);
  }
  return result;
}

async function readDeviceResult(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  flowId: string,
): Promise<DeviceResult> {
  const response = await request.get(`${clientBaseURL}/device-result?flow_id=${flowId}`);
  return await response.json() as DeviceResult;
}

async function deviceAuthorizationEndpoint(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  issuer: string,
): Promise<string | undefined> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  const metadata = await response.json() as { device_authorization_endpoint?: string };
  return metadata.device_authorization_endpoint;
}

function csrfTokenFrom(html: string): string {
  return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (baseURL === undefined) {
    throw new Error('baseURL is not configured');
  }
  return baseURL;
}
