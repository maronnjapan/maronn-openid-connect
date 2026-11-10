import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '../fixtures';
import type { APIRequestContext } from '@playwright/test';

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

  // OIDC Discovery 1.0 §3 / RFC 8414 §2.
  test('should advertise private_key_jwt with its signing algs and without none', async ({ request, baseURL }) => {
    const discoveryIssuer: string = requireBaseUrl(baseURL);
    const discoveryResponse = await request.get(`${discoveryIssuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.status()).toBe(200);
    const discoveryMetadata = (await discoveryResponse.json()) as Record<string, unknown>;
    test.skip(typeof discoveryMetadata['registration_endpoint'] !== 'string', 'This OP was generated without dynamic-client-registration');

    const issuer: string = requireBaseUrl(baseURL);
    const response = await request.get(`${issuer}/.well-known/openid-configuration`);
    expect(response.status()).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;

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
    const discoveryIssuer: string = requireBaseUrl(baseURL);
    const discoveryResponse = await request.get(`${discoveryIssuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.status()).toBe(200);
    const discoveryMetadata = (await discoveryResponse.json()) as Record<string, unknown>;
    test.skip(typeof discoveryMetadata['registration_endpoint'] !== 'string', 'This OP was generated without dynamic-client-registration');

    const issuer = requireBaseUrl(baseURL);
    const response4 = await request.get(jwksUri);
    expect(response4.status()).toBe(200);
    const { keys: keys3 } = (await response4.json()) as { keys: Array<Record<string, unknown>> };
    const key2 = keys3.filter((candidate) => candidate['kty'] === 'RSA').at(-1);
    if (key2 === undefined) throw new Error('The jwks_uri publishes no RSA key');
    const key = key2;
    const kid = requireString(key['kid'], 'kid');
    const keys2: Record<string, unknown> = { jwks: { keys: [key] } };
    const response2 = await request.post(`${issuer}/register`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        redirect_uris: [registeredRedirectUri],
        token_endpoint_auth_method: 'private_key_jwt',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        ...keys2,
      },
    });
    expect(response2.status()).toBe(201);
    const registered = (await response2.json()) as Record<string, unknown>;
    // RFC 7591 §3.2.1: no client_secret for a client that authenticates with its keys.
    expect(registered['client_secret']).toBeUndefined();
    const clientId = requireString(registered['client_id'], 'client_id');
    const codeVerifier2 = base64Url(randomBytes(32));
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: registeredRedirectUri,
      response_type: 'code',
      scope: 'openid',
      state: base64Url(randomBytes(16)),
      nonce: base64Url(randomBytes(16)),
      code_challenge: base64Url(createHash('sha256').update(codeVerifier2).digest()),
      code_challenge_method: 'S256',
    });

    await page.goto(`${issuer}/authorize?${params}`);
    await expect(page).toHaveURL(/\/login\?transaction_id=[^&]+$/);
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page).toHaveURL(/\/consent\?transaction_id=[^&]+$/);
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.waitForURL((url2) => url2.href.startsWith(`${registeredRedirectUri}?`));
    const { code, codeVerifier } = { code: requireString(new URL(page.url()).searchParams.get('code'), 'code'), codeVerifier: codeVerifier2 };

    const options: { kid?: string | null; aud?: string; alg?: string } = { kid };
    const url = new URL('/client-assertion', clientBaseURL);
    url.searchParams.set('client_id', clientId);
    if (options.kid) url.searchParams.set('kid', options.kid);
    if (options.aud) url.searchParams.set('aud', options.aud);
    if (options.alg) url.searchParams.set('alg', options.alg);
    const response3 = await request.get(url.toString());
    expect(response3.status()).toBe(200);
    const response = await tokenRequest(request, issuer, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: registeredRedirectUri,
      code_verifier: codeVerifier,
      client_id: clientId,
      ...assertionParams(((await response3.json()) as { assertion: string; kid: string }).assertion),
    });

    expect(response.status()).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['token_type']).toBe('Bearer');
    expect(typeof body['id_token']).toBe('string');
  });

  test('should issue tokens to a client that registered a jwks_uri', async ({ page, request, baseURL }) => {
    const discoveryIssuer: string = requireBaseUrl(baseURL);
    const discoveryResponse = await request.get(`${discoveryIssuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.status()).toBe(200);
    const discoveryMetadata = (await discoveryResponse.json()) as Record<string, unknown>;
    test.skip(typeof discoveryMetadata['registration_endpoint'] !== 'string', 'This OP was generated without dynamic-client-registration');

    const issuer = requireBaseUrl(baseURL);
    const keys: Record<string, unknown> = { jwks_uri: jwksUri };
    const response2 = await request.post(`${issuer}/register`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        redirect_uris: [registeredRedirectUri],
        token_endpoint_auth_method: 'private_key_jwt',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        ...keys,
      },
    });
    expect(response2.status()).toBe(201);
    const registered = (await response2.json()) as Record<string, unknown>;
    // RFC 7591 §3.2.1: no client_secret for a client that authenticates with its keys.
    expect(registered['client_secret']).toBeUndefined();
    const clientId = requireString(registered['client_id'], 'client_id');
    const codeVerifier2 = base64Url(randomBytes(32));
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: registeredRedirectUri,
      response_type: 'code',
      scope: 'openid',
      state: base64Url(randomBytes(16)),
      nonce: base64Url(randomBytes(16)),
      code_challenge: base64Url(createHash('sha256').update(codeVerifier2).digest()),
      code_challenge_method: 'S256',
    });

    await page.goto(`${issuer}/authorize?${params}`);
    await expect(page).toHaveURL(/\/login\?transaction_id=[^&]+$/);
    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page).toHaveURL(/\/consent\?transaction_id=[^&]+$/);
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.waitForURL((url2) => url2.href.startsWith(`${registeredRedirectUri}?`));
    const { code, codeVerifier } = { code: requireString(new URL(page.url()).searchParams.get('code'), 'code'), codeVerifier: codeVerifier2 };

    // RFC 7521 §4.2: client_id may be left out; the sub of the assertion names the client.
    const options: { kid?: string | null; aud?: string; alg?: string } = {};
    const url = new URL('/client-assertion', clientBaseURL);
    url.searchParams.set('client_id', clientId);
    if (options.kid) url.searchParams.set('kid', options.kid);
    if (options.aud) url.searchParams.set('aud', options.aud);
    if (options.alg) url.searchParams.set('alg', options.alg);
    const response3 = await request.get(url.toString());
    expect(response3.status()).toBe(200);
    const response = await tokenRequest(request, issuer, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: registeredRedirectUri,
      code_verifier: codeVerifier,
      ...assertionParams(((await response3.json()) as { assertion: string; kid: string }).assertion),
    });

    expect(response.status()).toBe(200);
    expect(typeof ((await response.json()) as Record<string, unknown>)['access_token']).toBe('string');
  });

  // RFC 7523 §3: an assertion is used once.
  test('should refuse the second use of the same client assertion', async ({ request, baseURL }) => {
    const discoveryIssuer: string = requireBaseUrl(baseURL);
    const discoveryResponse = await request.get(`${discoveryIssuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.status()).toBe(200);
    const discoveryMetadata = (await discoveryResponse.json()) as Record<string, unknown>;
    test.skip(typeof discoveryMetadata['registration_endpoint'] !== 'string', 'This OP was generated without dynamic-client-registration');

    const issuer = requireBaseUrl(baseURL);
    const keys: Record<string, unknown> = { jwks_uri: jwksUri };
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
    const clientId = requireString(registered['client_id'], 'client_id');
    const options: { kid?: string | null; aud?: string; alg?: string } = {};
    const url = new URL('/client-assertion', clientBaseURL);
    url.searchParams.set('client_id', clientId);
    if (options.kid) url.searchParams.set('kid', options.kid);
    if (options.aud) url.searchParams.set('aud', options.aud);
    if (options.alg) url.searchParams.set('alg', options.alg);
    const response2 = await request.get(url.toString());
    expect(response2.status()).toBe(200);
    const { assertion } = (await response2.json()) as { assertion: string; kid: string };

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
    const discoveryIssuer: string = requireBaseUrl(baseURL);
    const discoveryResponse = await request.get(`${discoveryIssuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.status()).toBe(200);
    const discoveryMetadata = (await discoveryResponse.json()) as Record<string, unknown>;
    test.skip(typeof discoveryMetadata['registration_endpoint'] !== 'string', 'This OP was generated without dynamic-client-registration');

    const issuer = requireBaseUrl(baseURL);
    const keys: Record<string, unknown> = { jwks_uri: jwksUri };
    const response2 = await request.post(`${issuer}/register`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        redirect_uris: [registeredRedirectUri],
        token_endpoint_auth_method: 'private_key_jwt',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        ...keys,
      },
    });
    expect(response2.status()).toBe(201);
    const registered = (await response2.json()) as Record<string, unknown>;
    // RFC 7591 §3.2.1: no client_secret for a client that authenticates with its keys.
    expect(registered['client_secret']).toBeUndefined();
    const clientId = requireString(registered['client_id'], 'client_id');
    const options: { kid?: string | null; aud?: string; alg?: string } = { aud: issuer };
    const url = new URL('/client-assertion', clientBaseURL);
    url.searchParams.set('client_id', clientId);
    if (options.kid) url.searchParams.set('kid', options.kid);
    if (options.aud) url.searchParams.set('aud', options.aud);
    if (options.alg) url.searchParams.set('alg', options.alg);
    const response3 = await request.get(url.toString());
    expect(response3.status()).toBe(200);
    const { assertion } = (await response3.json()) as { assertion: string; kid: string };

    const response = await tokenRequest(request, issuer, unknownCodeGrant(clientId, assertion));

    expect(response.status()).toBe(400);
    expect(((await response.json()) as Record<string, unknown>)['error']).toBe('invalid_grant');
  });

  // OIDC Core 1.0 §9: private_key_jwt is an asymmetric signature.
  test('should refuse an unsigned client assertion', async ({ request, baseURL }) => {
    const discoveryIssuer: string = requireBaseUrl(baseURL);
    const discoveryResponse = await request.get(`${discoveryIssuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.status()).toBe(200);
    const discoveryMetadata = (await discoveryResponse.json()) as Record<string, unknown>;
    test.skip(typeof discoveryMetadata['registration_endpoint'] !== 'string', 'This OP was generated without dynamic-client-registration');

    const issuer = requireBaseUrl(baseURL);
    const keys: Record<string, unknown> = { jwks_uri: jwksUri };
    const response2 = await request.post(`${issuer}/register`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        redirect_uris: [registeredRedirectUri],
        token_endpoint_auth_method: 'private_key_jwt',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        ...keys,
      },
    });
    expect(response2.status()).toBe(201);
    const registered = (await response2.json()) as Record<string, unknown>;
    // RFC 7591 §3.2.1: no client_secret for a client that authenticates with its keys.
    expect(registered['client_secret']).toBeUndefined();
    const clientId = requireString(registered['client_id'], 'client_id');
    const options: { kid?: string | null; aud?: string; alg?: string } = { alg: 'none' };
    const url = new URL('/client-assertion', clientBaseURL);
    url.searchParams.set('client_id', clientId);
    if (options.kid) url.searchParams.set('kid', options.kid);
    if (options.aud) url.searchParams.set('aud', options.aud);
    if (options.alg) url.searchParams.set('alg', options.alg);
    const response3 = await request.get(url.toString());
    expect(response3.status()).toBe(200);
    const { assertion } = (await response3.json()) as { assertion: string; kid: string };

    const response = await tokenRequest(request, issuer, unknownCodeGrant(clientId, assertion));

    expect(response.status()).toBe(401);
    expect(((await response.json()) as Record<string, unknown>)['error']).toBe('invalid_client');
  });

  // OIDC Core 1.0 §10.1.1: a kid the cached keys do not have fetches the jwks_uri again.
  test('should accept an assertion signed with a key the client has just added to its jwks_uri', async ({ request, baseURL }) => {
    const discoveryIssuer: string = requireBaseUrl(baseURL);
    const discoveryResponse = await request.get(`${discoveryIssuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.status()).toBe(200);
    const discoveryMetadata = (await discoveryResponse.json()) as Record<string, unknown>;
    test.skip(typeof discoveryMetadata['registration_endpoint'] !== 'string', 'This OP was generated without dynamic-client-registration');

    const issuer = requireBaseUrl(baseURL);
    const keys: Record<string, unknown> = { jwks_uri: jwksUri };
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
    const clientId = requireString(registered['client_id'], 'client_id');
    // The OP fetches and keeps the current keys first.
    const options: { kid?: string | null; aud?: string; alg?: string } = {};
    const url = new URL('/client-assertion', clientBaseURL);
    url.searchParams.set('client_id', clientId);
    if (options.kid) url.searchParams.set('kid', options.kid);
    if (options.aud) url.searchParams.set('aud', options.aud);
    if (options.alg) url.searchParams.set('alg', options.alg);
    const response2 = await request.get(url.toString());
    expect(response2.status()).toBe(200);
    const before = await tokenRequest(request, issuer, unknownCodeGrant(clientId, ((await response2.json()) as { assertion: string; kid: string }).assertion));
    expect(((await before.json()) as Record<string, unknown>)['error']).toBe('invalid_grant');

    const rotated = await request.post(`${clientBaseURL}/rotate-request-object-key`);
    expect(rotated.status()).toBe(200);
    const { kid } = (await rotated.json()) as { kid: string };
    const options2: { kid?: string | null; aud?: string; alg?: string } = { kid };
    const url2 = new URL('/client-assertion', clientBaseURL);
    url2.searchParams.set('client_id', clientId);
    if (options2.kid) url2.searchParams.set('kid', options2.kid);
    if (options2.aud) url2.searchParams.set('aud', options2.aud);
    if (options2.alg) url2.searchParams.set('alg', options2.alg);
    const response3 = await request.get(url2.toString());
    expect(response3.status()).toBe(200);
    const signedWithNewKey = (await response3.json()) as { assertion: string; kid: string };
    const after = await tokenRequest(request, issuer, unknownCodeGrant(clientId, signedWithNewKey.assertion));

    expect(signedWithNewKey.kid).toBe(kid);
    expect(after.status()).toBe(400);
    expect(((await after.json()) as Record<string, unknown>)['error']).toBe('invalid_grant');
  });
});

// Registered in playwright.config.ts with the jwks_uri of the E2E RP.
const keyClientId = 'e2e-private-key-jwt';

/**
 * The endpoints that authenticate clients besides the token endpoint (OAuth
 * 2.1 §2.3 / OIDC Core 1.0 §9): each accepts a client assertion whose aud is
 * its own URL and refuses one made for the token endpoint with 401
 * invalid_client. A test skips when the OP was generated without the feature
 * of its endpoint.
 */
test.describe('private_key_jwt at the endpoints besides the token endpoint (OIDC Core 1.0 §9)', () => {
  // RFC 7009 §2.2: the server answers 200 for a token it does not know.
  test('should authenticate a client assertion at the revocation endpoint', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const member: string = 'revocation_endpoint';
    const response3 = await request.get(`${issuer}/.well-known/openid-configuration`);
    expect(response3.status()).toBe(200);
    const value = ((await response3.json()) as Record<string, unknown>)[member];
    const endpoint = await (typeof value === 'string' ? value : undefined);
    test.skip(endpoint === undefined, 'This OP was generated without revocation');
    expect(endpoint).toBe(`${issuer}/revoke`);
    const form = { token: base64Url(randomBytes(16)), client_id: keyClientId };

    const aud: string = `${issuer}/revoke`;
    const options: { kid?: string | null; aud?: string; alg?: string } = { aud };
    const url = new URL('/client-assertion', clientBaseURL);
    url.searchParams.set('client_id', keyClientId);
    if (options.kid) url.searchParams.set('kid', options.kid);
    if (options.aud) url.searchParams.set('aud', options.aud);
    if (options.alg) url.searchParams.set('alg', options.alg);
    const response = await request.get(url.toString());
    expect(response.status()).toBe(200);
    const { assertion } = (await response.json()) as { assertion: string; kid: string };
    const accepted = await request.post(`${issuer}/revoke`, { form: { ...form, ...(assertionParams(assertion)) } });
    const aud2: string = `${issuer}/token`;
    const options2: { kid?: string | null; aud?: string; alg?: string } = { aud: aud2 };
    const url2 = new URL('/client-assertion', clientBaseURL);
    url2.searchParams.set('client_id', keyClientId);
    if (options2.kid) url2.searchParams.set('kid', options2.kid);
    if (options2.aud) url2.searchParams.set('aud', options2.aud);
    if (options2.alg) url2.searchParams.set('alg', options2.alg);
    const response2 = await request.get(url2.toString());
    expect(response2.status()).toBe(200);
    const { assertion: assertion2 } = (await response2.json()) as { assertion: string; kid: string };
    const refused = await request.post(`${issuer}/revoke`, { form: { ...form, ...(assertionParams(assertion2)) } });

    expect(accepted.status()).toBe(200);
    expect(refused.status()).toBe(401);
    expect(((await refused.json()) as Record<string, unknown>)['error']).toBe('invalid_client');
  });

  // RFC 7662 §2.2: a token the server does not know is inactive.
  test('should authenticate a client assertion at the introspection endpoint', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const member: string = 'introspection_endpoint';
    const response3 = await request.get(`${issuer}/.well-known/openid-configuration`);
    expect(response3.status()).toBe(200);
    const value = ((await response3.json()) as Record<string, unknown>)[member];
    const endpoint = await (typeof value === 'string' ? value : undefined);
    test.skip(endpoint === undefined, 'This OP was generated without introspection');
    expect(endpoint).toBe(`${issuer}/introspect`);
    const form = { token: base64Url(randomBytes(16)), client_id: keyClientId };

    const aud: string = `${issuer}/introspect`;
    const options: { kid?: string | null; aud?: string; alg?: string } = { aud };
    const url = new URL('/client-assertion', clientBaseURL);
    url.searchParams.set('client_id', keyClientId);
    if (options.kid) url.searchParams.set('kid', options.kid);
    if (options.aud) url.searchParams.set('aud', options.aud);
    if (options.alg) url.searchParams.set('alg', options.alg);
    const response = await request.get(url.toString());
    expect(response.status()).toBe(200);
    const { assertion } = (await response.json()) as { assertion: string; kid: string };
    const accepted = await request.post(`${issuer}/introspect`, { form: { ...form, ...(assertionParams(assertion)) } });
    const aud2: string = `${issuer}/token`;
    const options2: { kid?: string | null; aud?: string; alg?: string } = { aud: aud2 };
    const url2 = new URL('/client-assertion', clientBaseURL);
    url2.searchParams.set('client_id', keyClientId);
    if (options2.kid) url2.searchParams.set('kid', options2.kid);
    if (options2.aud) url2.searchParams.set('aud', options2.aud);
    if (options2.alg) url2.searchParams.set('alg', options2.alg);
    const response2 = await request.get(url2.toString());
    expect(response2.status()).toBe(200);
    const { assertion: assertion2 } = (await response2.json()) as { assertion: string; kid: string };
    const refused = await request.post(`${issuer}/introspect`, { form: { ...form, ...(assertionParams(assertion2)) } });

    expect(accepted.status()).toBe(200);
    expect(await accepted.json()).toEqual({ active: false });
    expect(refused.status()).toBe(401);
    expect(((await refused.json()) as Record<string, unknown>)['error']).toBe('invalid_client');
  });

  // RFC 9126 §2.1: the pushing client authenticates as at the token endpoint.
  test('should authenticate a client assertion at the pushed authorization request endpoint', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const member: string = 'pushed_authorization_request_endpoint';
    const response3 = await request.get(`${issuer}/.well-known/openid-configuration`);
    expect(response3.status()).toBe(200);
    const value = ((await response3.json()) as Record<string, unknown>)[member];
    const endpoint = await (typeof value === 'string' ? value : undefined);
    test.skip(endpoint === undefined, 'This OP was generated without par');
    expect(endpoint).toBe(`${issuer}/par`);
    const form = {
      client_id: keyClientId,
      response_type: 'code',
      redirect_uri: registeredRedirectUri,
      scope: 'openid',
      code_challenge: createHash('sha256').update(base64Url(randomBytes(32))).digest('base64url'),
      code_challenge_method: 'S256',
    };

    const aud: string = `${issuer}/par`;
    const options: { kid?: string | null; aud?: string; alg?: string } = { aud };
    const url = new URL('/client-assertion', clientBaseURL);
    url.searchParams.set('client_id', keyClientId);
    if (options.kid) url.searchParams.set('kid', options.kid);
    if (options.aud) url.searchParams.set('aud', options.aud);
    if (options.alg) url.searchParams.set('alg', options.alg);
    const response = await request.get(url.toString());
    expect(response.status()).toBe(200);
    const { assertion } = (await response.json()) as { assertion: string; kid: string };
    const accepted = await request.post(`${issuer}/par`, { form: { ...form, ...(assertionParams(assertion)) } });
    const aud2: string = `${issuer}/token`;
    const options2: { kid?: string | null; aud?: string; alg?: string } = { aud: aud2 };
    const url2 = new URL('/client-assertion', clientBaseURL);
    url2.searchParams.set('client_id', keyClientId);
    if (options2.kid) url2.searchParams.set('kid', options2.kid);
    if (options2.aud) url2.searchParams.set('aud', options2.aud);
    if (options2.alg) url2.searchParams.set('alg', options2.alg);
    const response2 = await request.get(url2.toString());
    expect(response2.status()).toBe(200);
    const { assertion: assertion2 } = (await response2.json()) as { assertion: string; kid: string };
    const refused = await request.post(`${issuer}/par`, { form: { ...form, ...(assertionParams(assertion2)) } });

    expect(accepted.status()).toBe(201);
    expect(((await accepted.json()) as Record<string, unknown>)['request_uri']).toMatch(/^urn:ietf:params:oauth:request_uri:/);
    expect(refused.status()).toBe(401);
    expect(((await refused.json()) as Record<string, unknown>)['error']).toBe('invalid_client');
  });

  // RFC 8628 §3.1: the client authentication of RFC 6749 §3.2.1 applies.
  test('should authenticate a client assertion at the device authorization endpoint', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const member: string = 'device_authorization_endpoint';
    const response3 = await request.get(`${issuer}/.well-known/openid-configuration`);
    expect(response3.status()).toBe(200);
    const value = ((await response3.json()) as Record<string, unknown>)[member];
    const endpoint = await (typeof value === 'string' ? value : undefined);
    test.skip(endpoint === undefined, 'This OP was generated without device-authorization-grant');
    expect(endpoint).toBe(`${issuer}/device_authorization`);
    const form = { client_id: keyClientId, scope: 'openid' };

    const aud: string = `${issuer}/device_authorization`;
    const options: { kid?: string | null; aud?: string; alg?: string } = { aud };
    const url = new URL('/client-assertion', clientBaseURL);
    url.searchParams.set('client_id', keyClientId);
    if (options.kid) url.searchParams.set('kid', options.kid);
    if (options.aud) url.searchParams.set('aud', options.aud);
    if (options.alg) url.searchParams.set('alg', options.alg);
    const response = await request.get(url.toString());
    expect(response.status()).toBe(200);
    const { assertion } = (await response.json()) as { assertion: string; kid: string };
    const accepted = await request.post(`${issuer}/device_authorization`, { form: { ...form, ...(assertionParams(assertion)) } });
    const aud2: string = `${issuer}/token`;
    const options2: { kid?: string | null; aud?: string; alg?: string } = { aud: aud2 };
    const url2 = new URL('/client-assertion', clientBaseURL);
    url2.searchParams.set('client_id', keyClientId);
    if (options2.kid) url2.searchParams.set('kid', options2.kid);
    if (options2.aud) url2.searchParams.set('aud', options2.aud);
    if (options2.alg) url2.searchParams.set('alg', options2.alg);
    const response2 = await request.get(url2.toString());
    expect(response2.status()).toBe(200);
    const { assertion: assertion2 } = (await response2.json()) as { assertion: string; kid: string };
    const refused = await request.post(`${issuer}/device_authorization`, { form: { ...form, ...(assertionParams(assertion2)) } });

    expect(accepted.status()).toBe(200);
    expect(typeof ((await accepted.json()) as Record<string, unknown>)['device_code']).toBe('string');
    expect(refused.status()).toBe(401);
    expect(((await refused.json()) as Record<string, unknown>)['error']).toBe('invalid_client');
  });

  // CIBA Core 1.0 §7.1: the client authenticates with its registered method.
  test('should authenticate a client assertion at the backchannel authentication endpoint', async ({ request, baseURL }) => {
    const issuer = requireBaseUrl(baseURL);
    const member: string = 'backchannel_authentication_endpoint';
    const response3 = await request.get(`${issuer}/.well-known/openid-configuration`);
    expect(response3.status()).toBe(200);
    const value = ((await response3.json()) as Record<string, unknown>)[member];
    const endpoint = await (typeof value === 'string' ? value : undefined);
    test.skip(endpoint === undefined, 'This OP was generated without ciba');
    expect(endpoint).toBe(`${issuer}/backchannel_authentication`);
    const form = { client_id: keyClientId, scope: 'openid', login_hint: 'testuser' };

    const aud: string = `${issuer}/backchannel_authentication`;
    const options: { kid?: string | null; aud?: string; alg?: string } = { aud };
    const url = new URL('/client-assertion', clientBaseURL);
    url.searchParams.set('client_id', keyClientId);
    if (options.kid) url.searchParams.set('kid', options.kid);
    if (options.aud) url.searchParams.set('aud', options.aud);
    if (options.alg) url.searchParams.set('alg', options.alg);
    const response = await request.get(url.toString());
    expect(response.status()).toBe(200);
    const { assertion } = (await response.json()) as { assertion: string; kid: string };
    const accepted = await request.post(`${issuer}/backchannel_authentication`, { form: { ...form, ...(assertionParams(assertion)) } });
    const aud2: string = `${issuer}/token`;
    const options2: { kid?: string | null; aud?: string; alg?: string } = { aud: aud2 };
    const url2 = new URL('/client-assertion', clientBaseURL);
    url2.searchParams.set('client_id', keyClientId);
    if (options2.kid) url2.searchParams.set('kid', options2.kid);
    if (options2.aud) url2.searchParams.set('aud', options2.aud);
    if (options2.alg) url2.searchParams.set('alg', options2.alg);
    const response2 = await request.get(url2.toString());
    expect(response2.status()).toBe(200);
    const { assertion: assertion2 } = (await response2.json()) as { assertion: string; kid: string };
    const refused = await request.post(`${issuer}/backchannel_authentication`, { form: { ...form, ...(assertionParams(assertion2)) } });

    expect(accepted.status()).toBe(200);
    expect(typeof ((await accepted.json()) as Record<string, unknown>)['auth_req_id']).toBe('string');
    expect(refused.status()).toBe(401);
    expect(((await refused.json()) as Record<string, unknown>)['error']).toBe('invalid_client');
  });
});

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
