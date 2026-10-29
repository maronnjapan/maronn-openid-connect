import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;

// The registered redirect target only has to be a page the browser can land on
// so the spec can read code and state from the URL; the token exchange itself
// is done with the request fixture and the issued credentials. The client
// app's static /logged-out page serves exactly that (as in the
// dynamic-client-registration spec).
const registeredRedirectUri = `${clientBaseURL}/logged-out`;

/**
 * Request Objects passed by reference (OIDC Core 1.0 §6.2).
 *
 * The client app (apps/client.mjs) hosts a Request Object the spec PUTs there,
 * and the OP fetches it with a GET when the authorization request names its
 * URL as request_uri. The client is registered through POST /register with
 * the URL as request_uris and the spec's public key as jwks, so the tests also
 * cover the registration metadata of OIDC Dynamic Client Registration 1.0 §2.
 * They skip on a sample OP generated without dynamic-client-registration, or
 * one that does not advertise request_uri_parameter_supported.
 */
test.describe('Request Object by reference (OIDC Core 1.0 §6.2)', () => {
  test('should advertise request_uri support and require the registration of request_uri values', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const metadata = await discoveryMetadata(request, issuer);
    test.skip(metadata.request_uri_parameter_supported !== true, SKIP_REASON);

    expect(metadata.request_parameter_supported).toBe(true);
    expect(metadata.require_request_uri_registration).toBe(true);
    expect(metadata.request_object_signing_alg_values_supported).toEqual(['RS256']);
  });

  test('should complete the Authorization Code Flow with a signed Request Object fetched from a registered request_uri', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const metadata = await discoveryMetadata(request, issuer);
    test.skip(metadata.request_uri_parameter_supported !== true, SKIP_REASON);
    test.skip(metadata.registration_endpoint === undefined, REGISTRATION_SKIP_REASON);

    const key = generateRs256Key('e2e-request-uri-key');
    const requestUri = `${clientBaseURL}/request-objects/${base64Url(randomBytes(16))}`;
    const registered = await registerClient(request, issuer, {
      redirect_uris: [registeredRedirectUri],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: 'E2E request_uri Client',
      jwks: { keys: [key.publicJwk] },
      request_uris: [requestUri],
      request_object_signing_alg: 'RS256',
    });
    const clientId = requireString(registered.client_id, 'client_id');
    const clientSecret = requireString(registered.client_secret, 'client_secret');
    // OIDC Dynamic Client Registration 1.0 §2: the registered values come back.
    expect(registered.request_uris).toEqual([requestUri]);
    expect(registered.request_object_signing_alg).toBe('RS256');

    // OIDC Core 1.0 §6.1: every parameter but response_type and client_id
    // travels inside the Request Object; the query repeats those two.
    const codeVerifier = base64Url(randomBytes(32));
    const requestState = base64Url(randomBytes(16));
    const nonce = base64Url(randomBytes(16));
    const requestObject = signRs256Jwt(
      {
        iss: clientId,
        aud: issuer,
        response_type: 'code',
        client_id: clientId,
        redirect_uri: registeredRedirectUri,
        scope: 'openid',
        state: requestState,
        nonce,
        code_challenge: base64Url(createHash('sha256').update(codeVerifier).digest()),
        code_challenge_method: 'S256',
      },
      key,
    );
    await hostRequestObject(request, requestUri, requestObject);

    const authorizeUrl = new URL('/authorize', issuer);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'openid');
    authorizeUrl.searchParams.set('request_uri', requestUri);
    await page.goto(authorizeUrl.toString());
    await loginAndApprove(page, issuer, clientId);

    // The state and the redirect_uri came from the fetched Request Object.
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(registeredRedirectUri)}\\?`));
    const callbackUrl = new URL(page.url());
    expect(callbackUrl.searchParams.get('state')).toBe(requestState);
    expect(callbackUrl.searchParams.get('iss')).toBe(issuer);
    const code = requireString(callbackUrl.searchParams.get('code'), 'code');

    const tokenResponse = await request.post(`${issuer}/token`, {
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: registeredRedirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
      },
    });
    expect(tokenResponse.status()).toBe(200);
    const tokens = await tokenResponse.json() as Record<string, unknown>;
    const idToken = decodeJwtPayload(requireString(tokens.id_token, 'id_token'));
    // The nonce of the Request Object reached the ID Token.
    expect(idToken.nonce).toBe(nonce);
    expect(idToken.aud).toBe(clientId);
  });

  // RFC 7591 §2 jwks_uri: the OP fetches the client's JWK Set document from
  // the registered URL when it has to verify the client's signed Request Object.
  test('should verify a signed Request Object with the keys fetched from the registered jwks_uri', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const metadata = await discoveryMetadata(request, issuer);
    test.skip(metadata.request_parameter_supported !== true, 'This sample OP does not advertise request_parameter_supported');
    test.skip(metadata.registration_endpoint === undefined, REGISTRATION_SKIP_REASON);

    const key = generateRs256Key('e2e-jwks-uri-key');
    const jwksUri = `${clientBaseURL}/jwks/${base64Url(randomBytes(16))}`;
    const hosted = await request.put(jwksUri, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ keys: [key.publicJwk] }),
    });
    expect(hosted.status()).toBe(204);
    const registered = await registerClient(request, issuer, {
      redirect_uris: [registeredRedirectUri],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: 'E2E jwks_uri Client',
      jwks_uri: jwksUri,
    });
    const clientId = requireString(registered.client_id, 'client_id');
    const clientSecret = requireString(registered.client_secret, 'client_secret');
    expect(registered.jwks_uri).toBe(jwksUri);
    expect(Object.hasOwn(registered, 'jwks')).toBe(false);

    const codeVerifier = base64Url(randomBytes(32));
    const requestState = base64Url(randomBytes(16));
    const nonce = base64Url(randomBytes(16));
    const requestObject = signRs256Jwt(
      {
        iss: clientId,
        aud: issuer,
        response_type: 'code',
        client_id: clientId,
        redirect_uri: registeredRedirectUri,
        scope: 'openid',
        state: requestState,
        nonce,
        code_challenge: base64Url(createHash('sha256').update(codeVerifier).digest()),
        code_challenge_method: 'S256',
      },
      key,
    );

    // OIDC Core 1.0 §6.1: the Request Object by value, verified with the keys of the jwks_uri.
    const authorizeUrl = new URL('/authorize', issuer);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'openid');
    authorizeUrl.searchParams.set('request', requestObject);
    await page.goto(authorizeUrl.toString());
    await loginAndApprove(page, issuer, clientId);

    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(registeredRedirectUri)}\\?`));
    const callbackUrl = new URL(page.url());
    expect(callbackUrl.searchParams.get('state')).toBe(requestState);
    const code = requireString(callbackUrl.searchParams.get('code'), 'code');

    const tokenResponse = await request.post(`${issuer}/token`, {
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: registeredRedirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
      },
    });
    expect(tokenResponse.status()).toBe(200);
    const tokens = await tokenResponse.json() as Record<string, unknown>;
    expect(decodeJwtPayload(requireString(tokens.id_token, 'id_token')).nonce).toBe(nonce);
  });

  // OIDC Core 1.0 §3.1.2.6: invalid_request_uri, and nothing is fetched or
  // redirected to — the request_uri was never registered for the client.
  test('should keep a request_uri the client did not register on the OP with invalid_request_uri', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const metadata = await discoveryMetadata(request, issuer);
    test.skip(metadata.request_uri_parameter_supported !== true, SKIP_REASON);
    test.skip(metadata.registration_endpoint === undefined, REGISTRATION_SKIP_REASON);

    const registered = await registerClient(request, issuer, { redirect_uris: [registeredRedirectUri] });
    const clientId = requireString(registered.client_id, 'client_id');
    const requestUri = `${clientBaseURL}/request-objects/${base64Url(randomBytes(16))}`;
    await hostRequestObject(request, requestUri, 'eyJhbGciOiJub25lIn0.e30.');

    const authorizeUrl = new URL('/authorize', issuer);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'openid');
    authorizeUrl.searchParams.set('request_uri', requestUri);
    const response = await request.get(authorizeUrl.toString(), {
      headers: { Accept: 'application/json' },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request_uri',
      error_description: 'request_uri is not registered for this client',
    });
  });

  // OIDC Core 1.0 §6: a request carries its Request Object by value or by
  // reference, never both.
  test('should reject a request carrying both request and request_uri with invalid_request', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const metadata = await discoveryMetadata(request, issuer);
    test.skip(metadata.request_uri_parameter_supported !== true, SKIP_REASON);
    test.skip(metadata.registration_endpoint === undefined, REGISTRATION_SKIP_REASON);

    const requestUri = `${clientBaseURL}/request-objects/${base64Url(randomBytes(16))}`;
    const registered = await registerClient(request, issuer, {
      redirect_uris: [registeredRedirectUri],
      request_uris: [requestUri],
    });
    const clientId = requireString(registered.client_id, 'client_id');

    const authorizeUrl = new URL('/authorize', issuer);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'openid');
    authorizeUrl.searchParams.set('request', 'eyJhbGciOiJub25lIn0.e30.');
    authorizeUrl.searchParams.set('request_uri', requestUri);
    const response = await request.get(authorizeUrl.toString(), {
      headers: { Accept: 'application/json' },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'request and request_uri must not both be present',
    });
  });
});

const SKIP_REASON = 'This sample OP does not advertise request_uri_parameter_supported';
const REGISTRATION_SKIP_REASON =
  'This sample OP was generated without --enable dynamic-client-registration';

interface Rs256Key {
  privateKey: KeyObject;
  publicJwk: Record<string, string>;
}

/** An RS256 key pair, its public half as the JWK the registration carries. */
function generateRs256Key(kid: string): Rs256Key {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { n, e } = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return { privateKey, publicJwk: { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n, e } };
}

/** A compact JWS signed with RS256 (RFC 7515), the kid of the key in its header. */
function signRs256Jwt(payload: Record<string, unknown>, key: Rs256Key): string {
  const encode = (value: unknown): string => base64Url(Buffer.from(JSON.stringify(value), 'utf8'));
  const signingInput = `${encode({ alg: 'RS256', kid: key.publicJwk['kid'], typ: 'oauth-authz-req+jwt' })}.${encode(payload)}`;
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), key.privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

/** Put the Request Object where the client app serves it (apps/client.mjs). */
async function hostRequestObject(request: APIRequestContext, requestUri: string, requestObject: string): Promise<void> {
  const response = await request.put(requestUri, {
    headers: { 'Content-Type': 'application/oauth-authz-req+jwt' },
    data: requestObject,
  });
  expect(response.status()).toBe(204);
}

/** Register a client and return the parsed 201 body. */
async function registerClient(
  request: APIRequestContext,
  issuer: string,
  metadata: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await request.post(`${issuer}/register`, {
    headers: { 'Content-Type': 'application/json' },
    data: metadata,
  });
  expect(response.status()).toBe(201);
  return await response.json() as Record<string, unknown>;
}

/** Log in as testuser and approve the consent screen, which names the registered client. */
async function loginAndApprove(page: Page, issuer: string, clientId: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login$`));
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();

  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent$`));
  await expect(page.locator('strong')).toHaveText(clientId);
  await page.getByRole('button', { name: 'Approve' }).click();
}

async function discoveryMetadata(request: APIRequestContext, issuer: string): Promise<Record<string, unknown>> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  expect(response.status()).toBe(200);
  return await response.json() as Record<string, unknown>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const segments = jwt.split('.');
  expect(segments).toHaveLength(3);
  return JSON.parse(Buffer.from(segments[1] as string, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function requireBaseUrl(baseURL: string | undefined): string {
  expect(baseURL).toBeTruthy();
  return (baseURL as string).replace(/\/$/, '');
}

function requireString(value: unknown, label: string): string {
  expect(typeof value, `${label} should be a string`).toBe('string');
  return value as string;
}
