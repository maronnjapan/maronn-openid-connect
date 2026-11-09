import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;

// The registered redirect target only has to be a page the browser can land on
// so the spec can read the code from the URL; the token exchange itself is done
// with the request fixture and a client assertion of the E2E RP.
const registeredRedirectUri = `${clientBaseURL}/logged-out`;
// The E2E RP (apps/client.mjs) publishes the keys it signs client assertions
// with at /jwks.json.
const jwksUri = `${clientBaseURL}/jwks.json`;

/**
 * private_key_jwt client authentication (OIDC Core 1.0 §9 / RFC 7523 §3): the
 * client signs a JWT with its private key and sends it as client_assertion,
 * and the OP verifies it with the keys the client registered (jwks, or its
 * jwks_uri, fetched again for a kid it has not seen — OIDC Core 1.0 §10.1.1),
 * checks iss, sub, aud, exp and jti, and refuses a replay.
 *
 * The clients register themselves (RFC 7591), so the spec skips when the OP
 * was generated without dynamic-client-registration.
 * playwright.config.ts starts the OP with OIDC_ALLOW_INSECURE_CLIENT_JWKS_URI=1
 * (the RP serves its keys over http on 127.0.0.1) and with
 * OIDC_CLIENT_JWKS_URI_REFETCH_INTERVAL_SECONDS=0, so a rotated key is fetched
 * at once.
 *
 * A token request whose code is unknown answers invalid_grant only after the
 * client authenticated, so invalid_grant shows an accepted assertion and
 * invalid_client a refused one, without a browser flow for every case.
 */
test.describe('private_key_jwt (OIDC Core 1.0 §9)', () => {
  test.beforeEach(async ({ request, baseURL }) => {
    const metadata = await discoveryMetadata(request, requireBaseUrl(baseURL));
    test.skip(typeof metadata['registration_endpoint'] !== 'string', 'This OP was generated without dynamic-client-registration');
  });

  // OIDC Discovery 1.0 §3 / RFC 8414 §2.
  test('should advertise private_key_jwt with its signing algs and without none', async ({ request, baseURL }) => {
    const metadata = await discoveryMetadata(request, requireBaseUrl(baseURL));

    expect(metadata['token_endpoint_auth_methods_supported']).toContain('private_key_jwt');
    expect(metadata['token_endpoint_auth_signing_alg_values_supported']).toEqual([
      'RS256',
      'RS384',
      'RS512',
      'ES256',
      'ES384',
      'ES512',
    ]);
  });

  test('should issue tokens to a client that registered its keys as jwks', async ({ page, request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const key = await newestRsaKey(request);
    const kid = requireString(key['kid'], 'kid');
    const clientId = await registerPrivateKeyJwtClient(request, issuer, { jwks: { keys: [key] } });
    const { code, codeVerifier } = await authorizeInBrowser(page, issuer, clientId);

    const response = await tokenRequest(request, issuer, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: registeredRedirectUri,
      code_verifier: codeVerifier,
      client_id: clientId,
      ...assertionParams((await clientAssertion(request, clientId, { kid })).assertion),
    });

    expect(response.status()).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['token_type']).toBe('Bearer');
    expect(typeof body['id_token']).toBe('string');
  });

  test('should issue tokens to a client that registered a jwks_uri', async ({ page, request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const clientId = await registerPrivateKeyJwtClient(request, issuer, { jwks_uri: jwksUri });
    const { code, codeVerifier } = await authorizeInBrowser(page, issuer, clientId);

    // RFC 7521 §4.2: client_id may be left out; the sub of the assertion names the client.
    const response = await tokenRequest(request, issuer, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: registeredRedirectUri,
      code_verifier: codeVerifier,
      ...assertionParams((await clientAssertion(request, clientId)).assertion),
    });

    expect(response.status()).toBe(200);
    expect(typeof ((await response.json()) as Record<string, unknown>)['access_token']).toBe('string');
  });

  // RFC 7523 §3: an assertion is used once.
  test('should refuse the second use of the same client assertion', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const clientId = await registerPrivateKeyJwtClient(request, issuer, { jwks_uri: jwksUri });
    const { assertion } = await clientAssertion(request, clientId);

    const first = await tokenRequest(request, issuer, unknownCodeGrant(clientId, assertion));
    const replayed = await tokenRequest(request, issuer, unknownCodeGrant(clientId, assertion));

    expect(((await first.json()) as Record<string, unknown>)['error']).toBe('invalid_grant');
    expect(replayed.status()).toBe(401);
    expect(await replayed.json()).toEqual({
      error: 'invalid_client',
      error_description: 'client_assertion has already been used',
    });
  });

  // RFC 7523 §3: the issuer identifies the authorization server, as the token endpoint URL does.
  test('should accept an assertion whose aud is the issuer', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const clientId = await registerPrivateKeyJwtClient(request, issuer, { jwks_uri: jwksUri });
    const { assertion } = await clientAssertion(request, clientId, { aud: issuer });

    const response = await tokenRequest(request, issuer, unknownCodeGrant(clientId, assertion));

    expect(response.status()).toBe(400);
    expect(((await response.json()) as Record<string, unknown>)['error']).toBe('invalid_grant');
  });

  // OIDC Core 1.0 §9: private_key_jwt is an asymmetric signature.
  test('should refuse an unsigned client assertion', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const clientId = await registerPrivateKeyJwtClient(request, issuer, { jwks_uri: jwksUri });
    const { assertion } = await clientAssertion(request, clientId, { alg: 'none' });

    const response = await tokenRequest(request, issuer, unknownCodeGrant(clientId, assertion));

    expect(response.status()).toBe(401);
    expect(((await response.json()) as Record<string, unknown>)['error']).toBe('invalid_client');
  });

  // OIDC Core 1.0 §10.1.1: a kid the cached keys do not have fetches the jwks_uri again.
  test('should accept an assertion signed with a key the client has just added to its jwks_uri', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const clientId = await registerPrivateKeyJwtClient(request, issuer, { jwks_uri: jwksUri });
    // The OP fetches and keeps the current keys first.
    const before = await tokenRequest(request, issuer, unknownCodeGrant(clientId, (await clientAssertion(request, clientId)).assertion));
    expect(((await before.json()) as Record<string, unknown>)['error']).toBe('invalid_grant');

    const rotated = await request.post(`${clientBaseURL}/rotate-request-object-key`);
    expect(rotated.status()).toBe(200);
    const { kid } = (await rotated.json()) as { kid: string };
    const signedWithNewKey = await clientAssertion(request, clientId, { kid });
    const after = await tokenRequest(request, issuer, unknownCodeGrant(clientId, signedWithNewKey.assertion));

    expect(signedWithNewKey.kid).toBe(kid);
    expect(after.status()).toBe(400);
    expect(((await after.json()) as Record<string, unknown>)['error']).toBe('invalid_grant');
  });
});

/** Registers a private_key_jwt client with the given keys (jwks or jwks_uri) and returns its client_id. */
async function registerPrivateKeyJwtClient(
  request: APIRequestContext,
  issuer: string,
  keys: Record<string, unknown>,
): Promise<string> {
  const response = await request.post(`${issuer}/register`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      redirect_uris: [registeredRedirectUri],
      token_endpoint_auth_method: 'private_key_jwt',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      ...keys,
    },
  });
  expect(response.status()).toBe(201);
  const registered = (await response.json()) as Record<string, unknown>;
  // RFC 7591 §3.2.1: no client_secret for a client that authenticates with its keys.
  expect(registered['client_secret']).toBeUndefined();
  return requireString(registered['client_id'], 'client_id');
}

/** A client assertion the E2E RP signed for clientId (apps/client.mjs, /client-assertion). */
async function clientAssertion(
  request: APIRequestContext,
  clientId: string,
  options: { kid?: string | null; aud?: string; alg?: string } = {},
): Promise<{ assertion: string; kid: string }> {
  const url = new URL('/client-assertion', clientBaseURL);
  url.searchParams.set('client_id', clientId);
  if (options.kid) url.searchParams.set('kid', options.kid);
  if (options.aud) url.searchParams.set('aud', options.aud);
  if (options.alg) url.searchParams.set('alg', options.alg);
  const response = await request.get(url.toString());
  expect(response.status()).toBe(200);
  return (await response.json()) as { assertion: string; kid: string };
}

/** The newest RSA key the E2E RP publishes at its jwks_uri: the one it signs RS256 assertions with. */
async function newestRsaKey(request: APIRequestContext): Promise<Record<string, unknown>> {
  const response = await request.get(jwksUri);
  expect(response.status()).toBe(200);
  const { keys } = (await response.json()) as { keys: Array<Record<string, unknown>> };
  const key = keys.filter((candidate) => candidate['kty'] === 'RSA').at(-1);
  if (key === undefined) throw new Error('The jwks_uri publishes no RSA key');
  return key;
}

/** The client authentication parameters of a client assertion (RFC 7523 §2.2). */
function assertionParams(assertion: string): Record<string, string> {
  return {
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  };
}

/** A token request for a code the OP never issued, authenticated with the assertion. */
function unknownCodeGrant(clientId: string, assertion: string): Record<string, string> {
  return {
    grant_type: 'authorization_code',
    code: base64Url(randomBytes(16)),
    redirect_uri: registeredRedirectUri,
    code_verifier: base64Url(randomBytes(32)),
    client_id: clientId,
    ...assertionParams(assertion),
  };
}

function tokenRequest(request: APIRequestContext, issuer: string, form: Record<string, string>) {
  return request.post(`${issuer}/token`, { form });
}

/** Sign in and approve in the browser, and return the code the OP redirected back with. */
async function authorizeInBrowser(
  page: Page,
  issuer: string,
  clientId: string,
): Promise<{ code: string; codeVerifier: string }> {
  const codeVerifier = base64Url(randomBytes(32));
  const authorizeUrl = new URL('/authorize', issuer);
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: registeredRedirectUri,
    response_type: 'code',
    scope: 'openid',
    state: base64Url(randomBytes(16)),
    nonce: base64Url(randomBytes(16)),
    code_challenge: base64Url(createHash('sha256').update(codeVerifier).digest()),
    code_challenge_method: 'S256',
  }).toString();

  await page.goto(authorizeUrl.toString());
  await expect(page).toHaveURL(/\/login\?transaction_id=[^&]+$/);
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/consent\?transaction_id=[^&]+$/);
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForURL((url) => url.href.startsWith(`${registeredRedirectUri}?`));
  return { code: requireString(new URL(page.url()).searchParams.get('code'), 'code'), codeVerifier };
}

async function discoveryMetadata(request: APIRequestContext, issuer: string): Promise<Record<string, unknown>> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (!baseURL) {
    throw new Error('Playwright baseURL is required');
  }
  return baseURL.replace(/\/$/, '');
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}
