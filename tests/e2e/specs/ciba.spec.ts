import { expect, test } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const clientId = 'e2e-client';
const clientSecret = 'e2e-client-secret';
const CIBA_GRANT_TYPE = 'urn:openid:params:grant-type:ciba';

interface StartedCibaFlow {
  flow_id: string;
  auth_req_id: string;
  expires_in: number;
  interval: number;
}

interface CibaResult {
  status: 'pending' | 'complete' | 'failed';
  error: string | null;
  access_token: string | null;
  id_token: string | null;
  scope: string | null;
  token_type: string | null;
}

/**
 * EXPERIMENTAL — OpenID Connect Client-Initiated Backchannel Authentication
 * (CIBA Core 1.0, poll mode).
 *
 * Only the samples generated with `--enable ciba` expose the endpoint, so every
 * test here skips when discovery does not advertise it. That keeps the shared
 * spec suite green across all sample OPs.
 *
 * The consumption-device side runs inside the E2E client (`/start-ciba`), which
 * polls the token endpoint in the background while Playwright drives the
 * browser through the authentication device UI — the real two-device shape of
 * the flow. Each flow carries a unique binding_message so the spec can pick its
 * own request out of the pending list even when earlier tests left records
 * behind (the OP process persists across tests).
 */
test.describe('CIBA (CIBA Core 1.0, poll mode)', () => {
  test('should issue tokens after the user approves on their own browser', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await backchannelAuthenticationEndpoint(request, issuer);
    test.skip(
      endpoint === undefined,
      'This sample OP was generated without --enable ciba',
    );
    expect(endpoint).toBe(`${issuer}/backchannel_authentication`);

    const bindingMessage = `E2E-${Date.now()}`;
    const flow = await startCibaFlow(request, bindingMessage);
    expect(flow.interval).toBe(5);
    expect(flow.expires_in).toBe(120);

    // The user signs in on their own device (no session yet in this context).
    await page.goto(`${issuer}/ciba`);
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();

    // The pending request shows the client, the scopes and the binding message
    // so the user can match it against the device that started it (§7.1).
    await expect(page.getByRole('heading', { name: 'Sign-in Requests' })).toBeVisible();
    const section = page.locator('section', { hasText: bindingMessage });
    await expect(section.locator('strong').first()).toHaveText(clientId);
    await expect(section.locator('li')).toHaveText(['openid', 'profile', 'email']);

    await section.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('You can close this page and go back to your device.')).toBeVisible();

    const result = await waitForCibaResult(request, flow.flow_id);
    expect(result.status).toBe('complete');
    expect(result.token_type).toBe('Bearer');
    expect(result.scope).toBe('openid profile email');
    expect(typeof result.id_token).toBe('string');

    // The consumption device's own token reaches the UserInfo endpoint.
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
    const endpoint = await backchannelAuthenticationEndpoint(request, issuer);
    test.skip(
      endpoint === undefined,
      'This sample OP was generated without --enable ciba',
    );

    const bindingMessage = `E2E-DENY-${Date.now()}`;
    const flow = await startCibaFlow(request, bindingMessage);

    await page.goto(`${issuer}/ciba`);
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await page
      .locator('section', { hasText: bindingMessage })
      .getByRole('button', { name: 'Deny' })
      .click();
    await expect(page.getByText('You can close this page and go back to your device.')).toBeVisible();

    const result = await waitForCibaResult(request, flow.flow_id);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('access_denied');
    expect(result.access_token).toBe(null);
  });

  test('should answer authorization_pending while the user has not decided', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await backchannelAuthenticationEndpoint(request, issuer);
    test.skip(
      endpoint === undefined,
      'This sample OP was generated without --enable ciba',
    );

    const authentication = await request.post(`${issuer}/backchannel_authentication`, {
      form: {
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'openid',
        login_hint: 'testuser',
      },
    });
    expect(authentication.status()).toBe(200);
    expect(authentication.headers()['cache-control']).toBe('no-store');
    const codes = await authentication.json() as { auth_req_id: string };

    const poll = await request.post(`${issuer}/token`, {
      form: {
        grant_type: CIBA_GRANT_TYPE,
        auth_req_id: codes.auth_req_id,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });

    expect(poll.status()).toBe(400);
    expect(await poll.json()).toEqual({
      error: 'authorization_pending',
      error_description: 'The authentication request is still pending',
    });
  });

  test('should refuse the login form without the browser binding cookie', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await backchannelAuthenticationEndpoint(request, issuer);
    test.skip(
      endpoint === undefined,
      'This sample OP was generated without --enable ciba',
    );

    // The attacker can load /ciba themselves and read a valid transaction id +
    // csrf_token pair. Without the binding cookie the pair is worth nothing: a
    // forged cross-site POST is refused, so no OP session can be planted.
    const form = await request.get(`${issuer}/ciba`);
    const html = await form.text();
    const loginTransactionId = html.match(/name="login_transaction_id" value="([^"]+)"/)?.[1] ?? '';
    const csrfToken = csrfTokenFrom(html);
    expect(loginTransactionId.length > 0).toBe(true);
    expect(csrfToken.length > 0).toBe(true);

    const forged = await request.post(`${issuer}/ciba/login`, {
      form: {
        login_transaction_id: loginTransactionId,
        csrf_token: csrfToken,
        username: 'testuser',
        password: 'password',
      },
      // Playwright's request context keeps cookies, so start from a clean state
      // to model a browser that never held this transaction's binding cookie.
      headers: { Cookie: '' },
    });

    expect(forged.status()).toBe(403);
  });

  test('should reject an auth_req_id presented by a different client', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await backchannelAuthenticationEndpoint(request, issuer);
    test.skip(
      endpoint === undefined,
      'This sample OP was generated without --enable ciba',
    );

    const authentication = await request.post(`${issuer}/backchannel_authentication`, {
      form: {
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'openid',
        login_hint: 'testuser',
      },
    });
    const codes = await authentication.json() as { auth_req_id: string };

    // CIBA Core 1.0 §11: the auth_req_id belongs to the client it was issued
    // to. e2e-ciba-other authenticates fine and is registered for the CIBA
    // grant, so the only thing that stops it is the id's client binding.
    const poll = await request.post(`${issuer}/token`, {
      form: {
        grant_type: CIBA_GRANT_TYPE,
        auth_req_id: codes.auth_req_id,
        client_id: 'e2e-ciba-other',
        client_secret: 'e2e-ciba-other-secret',
      },
    });

    expect(poll.status()).toBe(400);
    // The wording matches the unknown-id case so existence is not leaked.
    expect(await poll.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'The auth_req_id is invalid, expired, or was issued to another client',
    });
  });
});

async function startCibaFlow(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  bindingMessage: string,
): Promise<StartedCibaFlow> {
  const response = await request.get(
    `${clientBaseURL}/start-ciba?binding_message=${encodeURIComponent(bindingMessage)}`,
  );
  return await response.json() as StartedCibaFlow;
}

/**
 * Poll the E2E client until its background CIBA polling settles.
 *
 * The OP's interval is 5 seconds, so the device needs a couple of poll cycles
 * after the browser finishes; 45 seconds leaves room for a slow_down bump.
 */
async function waitForCibaResult(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  flowId: string,
): Promise<CibaResult> {
  const deadline = Date.now() + 45_000;
  let result = await readCibaResult(request, flowId);
  while (result.status === 'pending' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    result = await readCibaResult(request, flowId);
  }
  return result;
}

async function readCibaResult(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  flowId: string,
): Promise<CibaResult> {
  const response = await request.get(`${clientBaseURL}/ciba-result?flow_id=${flowId}`);
  return await response.json() as CibaResult;
}

async function backchannelAuthenticationEndpoint(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  issuer: string,
): Promise<string | undefined> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  const metadata = await response.json() as { backchannel_authentication_endpoint?: string };
  return metadata.backchannel_authentication_endpoint;
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
