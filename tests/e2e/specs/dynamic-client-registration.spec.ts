import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
// EXPERIMENTAL (RFC 7591): a second OP instance started by playwright.config.ts
// with a small inventory cap, so the 429 path can be exercised without filling
// the open registration the other tests rely on. The verifier functions of the
// registration config (initial access token, software statement) are code, not
// environment, so their paths are covered by the in-process tests of the apps.
const dcrOpPort = Number(process.env.E2E_DCR_OP_PORT ?? '3050');
const restrictedIssuer = process.env.E2E_DCR_ISSUER ?? `http://${host}:${dcrOpPort}`;
const restrictedMaxClients = 3;

// The registered redirect target only has to be a page the browser can land on
// so the spec can read code and state from the URL; the token exchange itself
// is done with the request fixture and the issued credentials. The client
// app's static /logged-out page serves exactly that.
const registeredRedirectUri = `${clientBaseURL}/logged-out`;

/**
 * EXPERIMENTAL — Dynamic Client Registration (RFC 7591).
 *
 * Only the samples generated with `--enable dynamic-client-registration`
 * expose the endpoint, so every test here skips when discovery does not
 * advertise registration_endpoint — which is also the advertised/implemented
 * consistency check: a sample without the feature never shows the field and
 * this whole file stays skipped. That keeps the shared spec suite green
 * across all sample OPs.
 */
test.describe('Dynamic Client Registration (RFC 7591)', () => {
  test('should advertise registration_endpoint only through discovery and serve it', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);
    expect(endpoint).toBe(`${issuer}/register`);
  });

  test('should register with defaults applied and return the issued values (RFC 7591 §3.2.1)', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);

    const response = await request.post(`${issuer}/register`, {
      headers: { 'Content-Type': 'application/json' },
      data: { redirect_uris: [registeredRedirectUri], client_name: 'E2E Minimal Client' },
    });

    expect(response.status()).toBe(201);
    // The body carries the client_secret, so it must never be cached.
    expect(requireHeader(response.headers(), 'cache-control')).toBe('no-store');
    const registered = await response.json() as Record<string, unknown>;
    // dcr- prefix + 16 random bytes in base64url (22 characters).
    expect(registered.client_id).toMatch(/^dcr-[A-Za-z0-9_-]{22}$/);
    // 32 random bytes in base64url (43 characters).
    expect(registered.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 0 means "does not expire" (RFC 7591 §3.2.1), not "already expired".
    expect(registered.client_secret_expires_at).toBe(0);
    expect(typeof registered.client_id_issued_at).toBe('number');
    expect(registered.redirect_uris).toEqual([registeredRedirectUri]);
    // RFC 7591 §2 defaults.
    expect(registered.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(registered.grant_types).toEqual(['authorization_code']);
    expect(registered.response_types).toEqual(['code']);
    // OIDC Dynamic Client Registration 1.0 §2 defaults the OP applied, returned
    // as registered metadata (§3.2).
    expect(registered.application_type).toBe('web');
    expect(registered.id_token_signed_response_alg).toBe('RS256');
    expect(registered.client_name).toBe('E2E Minimal Client');
  });

  test('should complete the Authorization Code Flow with the issued confidential client', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);

    const registered = await registerClient(request, issuer, {
      redirect_uris: [registeredRedirectUri],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: 'E2E Confidential Client',
    });
    const clientId = requireString(registered.client_id, 'client_id');
    const clientSecret = requireString(registered.client_secret, 'client_secret');

    const { code, state } = await authorizeInBrowser(page, issuer, clientId);

    const tokenResponse = await request.post(`${issuer}/token`, {
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: registeredRedirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: state.codeVerifier,
      },
    });
    expect(tokenResponse.status()).toBe(200);
    const tokens = await tokenResponse.json() as Record<string, unknown>;
    expect(tokens.token_type).toBe('Bearer');
    const accessToken = requireString(tokens.access_token, 'access_token');
    const idToken = requireString(tokens.id_token, 'id_token');
    // The ID Token is issued to the dynamically registered client.
    expect(decodeJwtPayload(idToken).aud).toBe(clientId);

    const userinfoResponse = await request.get(`${issuer}/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(userinfoResponse.status()).toBe(200);
    const claims = await userinfoResponse.json() as Record<string, unknown>;
    expect(claims.sub).toBe('testuser');
  });

  test('should complete the flow without a secret for a public client registered with none', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);

    const registered = await registerClient(request, issuer, {
      redirect_uris: [registeredRedirectUri],
      token_endpoint_auth_method: 'none',
      client_name: 'E2E Public Client',
    });
    const clientId = requireString(registered.client_id, 'client_id');
    // RFC 6749 §2.1: a public client holds no secret, so none is issued.
    expect(Object.hasOwn(registered, 'client_secret')).toBe(false);
    expect(Object.hasOwn(registered, 'client_secret_expires_at')).toBe(false);

    const { code, state } = await authorizeInBrowser(page, issuer, clientId);

    const tokenResponse = await request.post(`${issuer}/token`, {
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: registeredRedirectUri,
        client_id: clientId,
        code_verifier: state.codeVerifier,
      },
    });
    expect(tokenResponse.status()).toBe(200);
    const tokens = await tokenResponse.json() as Record<string, unknown>;
    expect(tokens.token_type).toBe('Bearer');
  });

  // OIDC Dynamic Client Registration 1.0 §2: the response types the OP
  // advertises are registrable, and the implicit grant pairs with them. The
  // loopback http redirect target of this suite is what a native client may
  // register (a web client using the implicit grant is held to https).
  test('should register an implicit client and return its ID Token in the fragment (OIDC Core 1.0 §3.2)', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);
    const metadata = await discoveryMetadata(request, issuer);
    test.skip(
      !(metadata.response_types_supported as string[] | undefined)?.includes('id_token token'),
      'This sample OP was generated without implicit-flow',
    );

    const registered = await registerClient(request, issuer, {
      redirect_uris: [registeredRedirectUri],
      application_type: 'native',
      token_endpoint_auth_method: 'none',
      grant_types: ['implicit'],
      response_types: ['token id_token'],
      client_name: 'E2E Implicit Client',
    });
    const clientId = requireString(registered.client_id, 'client_id');
    // The response type comes back normalized (OAuth 2.0 Multiple Response Type Encoding Practices §1.2).
    expect(registered.response_types).toEqual(['id_token token']);
    expect(registered.grant_types).toEqual(['implicit']);
    expect(registered.application_type).toBe('native');

    const { fragment, nonce } = await authorizeImplicitInBrowser(page, issuer, clientId);

    expect(fragment['token_type']).toBe('Bearer');
    const idToken = decodeJwtPayload(requireString(fragment['id_token'], 'id_token'));
    expect(idToken.aud).toBe(clientId);
    expect(idToken.nonce).toBe(nonce);
  });

  // OIDC Dynamic Client Registration 1.0 §2: application_type defaults to web,
  // and the OP MUST verify that every registered redirect_uri conforms to the
  // constraints of that type — for a web client using the implicit grant,
  // https only and never localhost — so the omitted type is checked too.
  test('should default application_type to web and hold an implicit client to https redirect_uris (OIDC Registration 1.0 §2)', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);
    const metadata = await discoveryMetadata(request, issuer);
    test.skip(
      !(metadata.response_types_supported as string[] | undefined)?.includes('id_token'),
      'This sample OP was generated without implicit-flow',
    );
    const implicitClient = {
      token_endpoint_auth_method: 'none',
      grant_types: ['implicit'],
      response_types: ['id_token'],
    };

    const refused = await request.post(`${issuer}/register`, {
      headers: { 'Content-Type': 'application/json' },
      data: { ...implicitClient, redirect_uris: [registeredRedirectUri] },
    });
    const registered = await registerClient(request, issuer, {
      ...implicitClient,
      redirect_uris: ['https://implicit-client.e2e.example.com/cb'],
    });

    expect(refused.status()).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'a web client using the implicit grant must register https redirect_uris that do not use localhost',
    });
    expect(registered.application_type).toBe('web');
    expect(registered.redirect_uris).toEqual(['https://implicit-client.e2e.example.com/cb']);
  });

  // RFC 7591 §2: the scope metadata becomes the client's scope list, so a
  // request for any other scope is invalid_scope at /authorize.
  test('should register the scope and refuse an authorization request outside it with invalid_scope', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);

    const registered = await registerClient(request, issuer, {
      redirect_uris: [registeredRedirectUri],
      scope: 'openid profile openid',
    });
    expect(registered.scope).toBe('openid profile');
    const clientId = requireString(registered.client_id, 'client_id');

    const url = new URL('/authorize', issuer);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', registeredRedirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', 'e2e-scope-state');
    url.searchParams.set('code_challenge', base64Url(createHash('sha256').update('e2e-verifier-e2e-verifier-e2e-verifier-e2e-verifier').digest()));
    url.searchParams.set('code_challenge_method', 'S256');
    const response = await request.get(url.toString(), { maxRedirects: 0 });

    expect(response.status()).toBe(302);
    const location = new URL(requireHeader(response.headers(), 'location'));
    expect(`${location.origin}${location.pathname}`).toBe(registeredRedirectUri);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(location.searchParams.get('state')).toBe('e2e-scope-state');
  });

  // RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2: the metadata the OP
  // keeps for display and policy comes back with the registration (§3.2.1).
  test('should register the informational metadata of RFC 7591 §2 and return it', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);

    const registered = await registerClient(request, issuer, {
      redirect_uris: [registeredRedirectUri],
      application_type: 'web',
      client_name: 'E2E Described Client',
      client_uri: 'https://app.example.com/',
      logo_uri: 'https://app.example.com/logo.png',
      tos_uri: 'https://app.example.com/tos',
      policy_uri: 'https://app.example.com/privacy',
      contacts: ['ops@example.com', 'dev@example.com'],
      software_id: '4NRB1-0XZABZI9E6-5SM3R',
      software_version: '2.0.1',
      default_max_age: 3600,
      id_token_signed_response_alg: 'RS256',
    });

    expect(registered).toMatchObject({
      application_type: 'web',
      client_name: 'E2E Described Client',
      client_uri: 'https://app.example.com/',
      logo_uri: 'https://app.example.com/logo.png',
      tos_uri: 'https://app.example.com/tos',
      policy_uri: 'https://app.example.com/privacy',
      contacts: ['ops@example.com', 'dev@example.com'],
      software_id: '4NRB1-0XZABZI9E6-5SM3R',
      software_version: '2.0.1',
      default_max_age: 3600,
      id_token_signed_response_alg: 'RS256',
    });
  });

  // RFC 7591 §2 jwks: the public keys register with the client; the OP fills
  // in the alg and use it will verify with.
  test('should register the public keys of jwks and return the normalized key set', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { n, e } = publicKey.export({ format: 'jwk' }) as { n: string; e: string };

    const registered = await registerClient(request, issuer, {
      redirect_uris: [registeredRedirectUri],
      jwks: { keys: [{ kty: 'RSA', kid: 'e2e-client-key', n, e }] },
    });

    expect(registered.jwks).toEqual({
      keys: [{ kty: 'RSA', kid: 'e2e-client-key', use: 'sig', alg: 'RS256', n, e }],
    });
  });

  test('should reject an unregistered dcr- client_id at the authorization endpoint', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);

    // The contrast to the flows above: a client_id nobody registered must not
    // start a flow. An unknown client is a non-redirectable error (OAuth 2.1
    // §4.1.2.1), so no Location header carries a code anywhere. The Next.js OP
    // shows a browser its error page; asking for JSON gets the error itself.
    const url = new URL('/authorize', issuer);
    url.searchParams.set('client_id', 'dcr-0000000000000000000000');
    url.searchParams.set('redirect_uri', registeredRedirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid');
    const response = await request.get(url.toString(), {
      maxRedirects: 0,
      headers: { Accept: 'application/json' },
    });
    expect(response.status()).toBe(400);
    expect(response.headers()['location']).toBe(undefined);
  });

  test('should answer invalid_redirect_uri without reflecting the offending URI (RFC 7591 §3.2.2)', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);

    const response = await request.post(`${issuer}/register`, {
      headers: { 'Content-Type': 'application/json' },
      data: { redirect_uris: ['https://app.example.com/cb#e2e-marker'] },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_redirect_uri',
      error_description:
        'each redirect_uri must be an absolute URI without a fragment and must not use a dangerous scheme or non-loopback http',
    });
  });

  test('should answer invalid_client_metadata for an unsupported token_endpoint_auth_method', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);

    const response = await request.post(`${issuer}/register`, {
      headers: { 'Content-Type': 'application/json' },
      data: { redirect_uris: [registeredRedirectUri], token_endpoint_auth_method: 'private_key_jwt' },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description:
        'token_endpoint_auth_method must be one of client_secret_basic, client_secret_post, none',
    });
  });

  // RFC 7591 §2.1: a registration whose grant_types and response_types do not
  // pair is refused instead of landing the client in an inconsistent state.
  test('should answer invalid_client_metadata for grant_types inconsistent with response_types (RFC 7591 §2.1)', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);

    const response = await request.post(`${issuer}/register`, {
      headers: { 'Content-Type': 'application/json' },
      data: { redirect_uris: [registeredRedirectUri], grant_types: ['refresh_token'] },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description:
        'grant_types and response_types must be consistent: code requires authorization_code, token and id_token require implicit',
    });
  });

  test('should reject a request body that is not application/json (RFC 7591 §3.1)', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);

    // A text/plain POST can be sent cross-origin without a CORS preflight, so
    // the media type check also closes that form-post trick.
    const response = await request.post(`${issuer}/register`, {
      headers: { 'Content-Type': 'text/plain' },
      data: JSON.stringify({ redirect_uris: [registeredRedirectUri] }),
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'registration requests must use application/json',
    });
  });

  test('should ignore metadata this provider does not understand (RFC 7591 §2 MUST)', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);

    const response = await request.post(`${issuer}/register`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        redirect_uris: [registeredRedirectUri],
        sector_identifier_uri: 'https://app.example.com/redirect_uris.json',
        require_auth_time: true,
        tls_client_auth_subject_dn: 'CN=app',
      },
    });
    expect(response.status()).toBe(201);
    const registered = await response.json() as Record<string, unknown>;
    expect(Object.hasOwn(registered, 'sector_identifier_uri')).toBe(false);
    expect(Object.hasOwn(registered, 'require_auth_time')).toBe(false);
    expect(Object.hasOwn(registered, 'tls_client_auth_subject_dn')).toBe(false);
  });

  // RFC 7591 §3.1.1: a provider without a verifySoftwareStatement in its config
  // does not support software statements and ignores the member — the plain
  // values register, and nothing comes back as software_statement. Nothing in
  // the OP examines the statement, so any string is ignored the same way.
  test('should ignore a software_statement when the provider has no verifier for it (RFC 7591 §3.1.1)', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);

    const registered = await registerClient(request, issuer, {
      redirect_uris: [registeredRedirectUri],
      client_name: 'E2E Plain Name',
      software_statement: 'not-a-jws',
    });

    expect(registered.client_name).toBe('E2E Plain Name');
    expect(Object.hasOwn(registered, 'software_statement')).toBe(false);
  });

  // RFC 7591 §3.1.1 defines the member as a JWT string: another JSON type is a
  // malformed request, whether or not the provider supports statements.
  test('should answer invalid_software_statement for a software_statement that is not a string', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const endpoint = await registrationEndpoint(request, issuer);
    test.skip(endpoint === undefined, SKIP_REASON);

    const response = await request.post(`${issuer}/register`, {
      headers: { 'Content-Type': 'application/json' },
      data: { redirect_uris: [registeredRedirectUri], software_statement: { iss: 'https://publisher.example.com' } },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_software_statement',
      error_description: 'software_statement must be a string',
    });
  });

  // --- The capped instance: the inventory cap ---

  test('should answer 429 once the inventory cap is reached', async ({
    request,
  }) => {
    const endpoint = await registrationEndpoint(request, restrictedIssuer);
    test.skip(endpoint === undefined, RESTRICTED_SKIP_REASON);

    // The instance is started with maxRegisteredClients = 3. Whatever earlier
    // tests consumed, cap + 1 attempts end at the ceiling, so the last attempt
    // is deterministically 429.
    const statuses: number[] = [];
    let lastResponse;
    for (let attempt = 0; attempt < restrictedMaxClients + 1; attempt++) {
      lastResponse = await request.post(`${restrictedIssuer}/register`, {
        headers: { 'Content-Type': 'application/json' },
        data: { redirect_uris: [registeredRedirectUri] },
      });
      statuses.push(lastResponse.status());
    }

    expect(statuses[0]).toBe(201);
    expect(statuses[statuses.length - 1]).toBe(429);
    const body = await requireResponse(lastResponse).json() as Record<string, unknown>;
    // Fixed wording: the metadata is fine, so invalid_client_metadata would
    // invite a retry loop; and no Retry-After, because the cap is a stock
    // ceiling with no recovery time to promise.
    expect(body).toEqual({
      error: 'too_many_registrations',
      error_description: 'registration limit reached',
    });
    expect(requireResponse(lastResponse).headers()['retry-after']).toBe(undefined);
  });
});

const SKIP_REASON =
  'This sample OP was generated without --enable dynamic-client-registration';
const RESTRICTED_SKIP_REASON =
  'The capped-registration OP instance is not running for this sample';

interface AuthorizeState {
  codeVerifier: string;
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

/**
 * Drive /authorize → login → consent in the real browser with the issued
 * client_id and return the code (plus the PKCE verifier the request used).
 */
async function authorizeInBrowser(
  page: Page,
  issuer: string,
  clientId: string,
): Promise<{ code: string; state: AuthorizeState }> {
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const requestState = base64Url(randomBytes(16));

  const authorizeUrl = new URL('/authorize', issuer);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', registeredRedirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'openid');
  authorizeUrl.searchParams.set('state', requestState);
  authorizeUrl.searchParams.set('nonce', base64Url(randomBytes(16)));
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  await page.goto(authorizeUrl.toString());
  await loginAndApprove(page, issuer, clientId);

  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(registeredRedirectUri)}\\?`));
  const callbackUrl = new URL(page.url());
  expect(callbackUrl.searchParams.get('state')).toBe(requestState);
  expect(callbackUrl.searchParams.get('iss')).toBe(issuer);
  const code = callbackUrl.searchParams.get('code');
  expect(code).not.toBe(null);
  return { code: code as string, state: { codeVerifier } };
}

/**
 * Drive an Implicit Flow request (response_type=id_token token) in the real
 * browser with the issued client_id and return the fragment of the redirect
 * the browser landed on, with the nonce the request used.
 */
async function authorizeImplicitInBrowser(
  page: Page,
  issuer: string,
  clientId: string,
): Promise<{ fragment: Record<string, string>; nonce: string }> {
  const requestState = base64Url(randomBytes(16));
  const nonce = base64Url(randomBytes(16));

  const authorizeUrl = new URL('/authorize', issuer);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', registeredRedirectUri);
  authorizeUrl.searchParams.set('response_type', 'id_token token');
  authorizeUrl.searchParams.set('scope', 'openid');
  authorizeUrl.searchParams.set('state', requestState);
  authorizeUrl.searchParams.set('nonce', nonce);

  await page.goto(authorizeUrl.toString());
  await loginAndApprove(page, issuer, clientId);

  // OIDC Core 1.0 §3.2.2.5: the tokens ride in the fragment, never in the query.
  await page.waitForURL((url) => url.href.startsWith(registeredRedirectUri));
  const callbackUrl = new URL(page.url());
  expect(callbackUrl.search).toBe('');
  const fragment = Object.fromEntries(new URLSearchParams(callbackUrl.hash.slice(1)));
  expect(fragment['state']).toBe(requestState);
  return { fragment, nonce };
}

/** Log in as testuser and approve the consent screen, which names the registered client. */
async function loginAndApprove(page: Page, issuer: string, clientId: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login$`));
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();

  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent$`));
  // The consent screen names the dynamically registered client.
  await expect(page.locator('strong')).toHaveText(clientId);
  await page.getByRole('button', { name: 'Approve' }).click();
}

/**
 * registration_endpoint from discovery, or undefined when the OP does not
 * advertise it — or, for the restricted instance, is not running at all.
 */
async function registrationEndpoint(
  request: APIRequestContext,
  issuer: string,
): Promise<string | undefined> {
  try {
    const metadata = await discoveryMetadata(request, issuer);
    return metadata.registration_endpoint as string | undefined;
  } catch {
    return undefined;
  }
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

function requireHeader(headers: Record<string, string>, name: string): string {
  const value = headers[name];
  expect(value, `missing response header: ${name}`).toBeTruthy();
  return value as string;
}

function requireString(value: unknown, label: string): string {
  expect(typeof value, `${label} should be a string`).toBe('string');
  return value as string;
}

function requireResponse<T>(value: T | undefined): T {
  expect(value).toBeTruthy();
  return value as T;
}
