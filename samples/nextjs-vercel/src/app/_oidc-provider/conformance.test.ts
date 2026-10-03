/**
 * Contract test for the generated OpenID Provider.
 *
 * It drives the OP the way Next.js does — Route Handlers with a NextRequest,
 * pages (React Server Components) rendered to HTML, Server Actions with the
 * submitted FormData — and pins what the specifications require of each
 * answer. No server is started: run it with `vitest run`.
 *
 * Next.js provides two functions only inside a real request, so they are
 * replaced here:
 * - cookies() (next/headers) reads and writes the cookie jar of the simulated
 *   browser making the call — the same jar its Route Handler requests send and
 *   update, so pages, Server Actions and Route Handlers see one browser.
 * - redirect() (next/navigation) throws a RedirectSignal carrying the target,
 *   which is where that browser would be sent.
 *
 * provider.ts reads its configuration from the environment on first import, so
 * the environment is pinned in vi.hoisted(), before any import runs: a fixed
 * issuer, the clients this test registers and an in-memory SQLite store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';

const { ISSUER, REDIRECT_URI, harness } = vi.hoisted(() => {
  const issuer = 'http://localhost:3000';
  const redirectUri = 'https://rp.example.com/callback';
  const clients = [
    {
      clientId: 'conformance-client',
      clientSecret: 'conformance-secret',
      redirectUris: [redirectUri],
      clientType: 'confidential',
      // Registered for every grant this OP supports.
      grantTypes: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:device_code',
        'urn:openid:params:grant-type:ciba',
      ],
      tokenEndpointAuthMethod: 'client_secret_post',
      responseTypes: ['code'],
    },
    // RFC 6749 §2.3.1: a client that authenticates with HTTP Basic.
    {
      clientId: 'conformance-basic-client',
      clientSecret: 'conformance-basic-secret',
      redirectUris: [redirectUri],
      clientType: 'confidential',
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'client_secret_basic',
      responseTypes: ['code'],
    },
    // OAuth 2.1 §2.1: a public client, which has no secret.
    {
      clientId: 'conformance-public-client',
      redirectUris: [redirectUri],
      clientType: 'public',
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'none',
      responseTypes: ['code'],
    },
    // RFC 8628 §3.4: a second device-grant client, to prove a device_code is
    // refused when another client presents it.
    {
      clientId: 'conformance-device-client',
      clientSecret: 'conformance-device-secret',
      redirectUris: [redirectUri],
      clientType: 'confidential',
      grantTypes: ['urn:ietf:params:oauth:grant-type:device_code'],
      tokenEndpointAuthMethod: 'client_secret_post',
      responseTypes: ['code'],
    },
    // CIBA Core 1.0 §11: a second CIBA client, to prove an auth_req_id is
    // refused when another client presents it.
    {
      clientId: 'conformance-ciba-client',
      clientSecret: 'conformance-ciba-secret',
      redirectUris: [redirectUri],
      clientType: 'confidential',
      grantTypes: ['urn:openid:params:grant-type:ciba'],
      tokenEndpointAuthMethod: 'client_secret_post',
      responseTypes: ['code'],
    },
  ];

  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_CLIENTS_JSON = JSON.stringify(clients);
  process.env.OIDC_SIGNING_KEY_ID = 'conformance-key';
  process.env.OIDC_SQLITE_PATH = ':memory:';
  for (const name of [
    'ISSUER',
    'OIDC_CORS_ORIGINS',
    'OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW',
    'OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'VERCEL',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_HOSTED_DOMAIN',
  ]) {
    delete process.env[name];
  }
  // EXTENSION (google-login): configures config.googleLogin, so the login page
  // renders the Google button and /login/google accepts callbacks.
  process.env.GOOGLE_CLIENT_ID = 'conformance.apps.googleusercontent.com';

  /** What redirect() throws: the location the browser is sent to. */
  class RedirectSignal extends Error {
    constructor(readonly location: string) {
      super('NEXT_REDIRECT ' + location);
    }
  }

  return {
    ISSUER: issuer,
    REDIRECT_URI: redirectUri,
    harness: {
      RedirectSignal,
      /** The cookie jar of the browser whose call is being handled. */
      jar: new Map<string, string>(),
      /** Every cookies().set() call, with the attributes it asked for. */
      cookieWrites: [] as Array<{ name: string; value: string; options: Record<string, unknown> }>,
    },
  };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = harness.jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      harness.jar.set(name, value);
      harness.cookieWrites.push({ name, value, options });
    },
    delete: (name: string) => {
      harness.jar.delete(name);
    },
  }),
}));

vi.mock('next/navigation', () => ({
  redirect: (location: string): never => {
    throw new harness.RedirectSignal(location);
  },
}));

// EXTENSION (google-login): stands in for google-auth-library, which would
// fetch Google's keys. The "ID token" a test posts is the JSON payload Google
// would have signed, so every test decides exactly what Google asserts.
vi.mock('@maronn-openid-connect/google-login', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@maronn-openid-connect/google-login')>()),
  getDefaultGoogleIdTokenVerifier: () => ({
    verify: async (idToken: string) => JSON.parse(idToken),
  }),
}));

import * as discovery from '../.well-known/openid-configuration/route';
import * as jwks from '../.well-known/jwks.json/route';
import * as authorize from '../authorize/route';
import LoginPage from '../login/page';
import { loginAction } from '../login/actions';
import ConsentPage from '../consent/page';
import { consentAction } from '../consent/actions';
import OidcErrorPage from '../oidc-error/page';
import * as token from '../token/route';
import * as userinfo from '../userinfo/route';
import * as introspect from '../introspect/route';
import * as revoke from '../revoke/route';
import * as deviceAuthorization from '../device_authorization/route';
import * as device from '../device/route';
import * as deviceLogin from '../device/login/route';
import * as deviceApprove from '../device/approve/route';
import * as backchannelAuthentication from '../backchannel_authentication/route';
import * as ciba from '../ciba/route';
import * as cibaLogin from '../ciba/login/route';
import * as cibaApprove from '../ciba/approve/route';
import * as googleLogin from '../login/google/route';
import { config, resolvers, stores } from './provider';

type RouteHandler = (request: NextRequest) => Response | Promise<Response>;
type RequestOptions = { method?: string; headers?: HeadersInit; body?: BodyInit };
type Page<Query> = (props: { searchParams: Promise<Query> }) => Promise<ReactElement>;
type ServerAction = (formData: FormData) => Promise<void>;

/**
 * One User-Agent. Its cookie jar is what Route Handlers receive in the Cookie
 * header and what cookies() reads inside pages and Server Actions; Set-Cookie
 * answers and cookies().set() both write back to it.
 */
class Browser {
  readonly cookies = new Map<string, string>();

  /** Send a request to a Route Handler. */
  async request(handler: RouteHandler, url: string, options: RequestOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (this.cookies.size > 0) {
      headers.set(
        'Cookie',
        [...this.cookies].map(([name, value]) => name + '=' + value).join('; '),
      );
    }
    harness.jar = this.cookies;
    const response = await handler(
      new NextRequest(new URL(url, ISSUER), { method: options.method, headers, body: options.body }),
    );
    for (const setCookie of response.headers.getSetCookie()) {
      this.storeCookie(setCookie);
    }
    return response;
  }

  /** POST a form to a Route Handler. */
  post(handler: RouteHandler, url: string, fields: Record<string, string>, headers?: HeadersInit): Promise<Response> {
    return this.request(handler, url, { method: 'POST', headers, body: new URLSearchParams(fields) });
  }

  /** Render a page as this browser would see it. */
  async render<Query>(page: Page<Query>, query: Query): Promise<string> {
    harness.jar = this.cookies;
    return renderToStaticMarkup(await page({ searchParams: Promise.resolve(query) }));
  }

  /** Submit a form to a Server Action; resolves to where it redirects the browser. */
  async submit(action: ServerAction, fields: Record<string, string>): Promise<string> {
    const formData = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      formData.set(name, value);
    }
    harness.jar = this.cookies;
    try {
      await action(formData);
    } catch (error) {
      if (error instanceof harness.RedirectSignal) return error.location;
      throw error;
    }
    throw new Error('The Server Action returned without redirecting');
  }

  private storeCookie(setCookie: string): void {
    const [pair = '', ...attributes] = setCookie.split(';');
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator).trim();
    const expired = attributes.some((attribute) => attribute.trim().toLowerCase() === 'max-age=0');
    if (expired) {
      this.cookies.delete(name);
    } else {
      this.cookies.set(name, pair.slice(separator + 1).trim());
    }
  }
}

/** RFC 7636 Appendix B: the example code_verifier and its S256 code_challenge. */
const CODE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/** An authorization request of conformance-client; undefined drops a parameter. */
function authorizationRequest(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const params: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: 'conformance-client',
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile',
    state: 'conformance-state',
    nonce: 'conformance-nonce',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function authorizeUrl(params: Record<string, string>, origin = ISSUER): string {
  return origin + '/authorize?' + new URLSearchParams(params).toString();
}

function locationOf(response: Response): string {
  return response.headers.get('Location') ?? '';
}

function transactionIdOf(location: string): string {
  return new URL(location, ISSUER).searchParams.get('transaction_id') ?? '';
}

function csrfTokenOf(html: string): string {
  return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
}

/** Start an authorization request; resolves to its transaction_id. */
async function startAuthorization(
  browser: Browser,
  params: Record<string, string> = authorizationRequest(),
): Promise<string> {
  return transactionIdOf(locationOf(await browser.request(authorize.GET, authorizeUrl(params))));
}

/** Sign in on the login page of a transaction; resolves to where the browser goes next. */
async function logIn(browser: Browser, transactionId: string, username = 'testuser'): Promise<string> {
  const html = await browser.render(LoginPage, { transaction_id: transactionId });
  return browser.submit(loginAction, {
    transaction_id: transactionId,
    csrf_token: csrfTokenOf(html),
    username,
    password: 'password',
  });
}

/** Submit a consent decision from the consent page; undefined omits the action field. */
async function decide(browser: Browser, transactionId: string, action: string | undefined): Promise<string> {
  const html = await browser.render(ConsentPage, { transaction_id: transactionId });
  const fields: Record<string, string> = { transaction_id: transactionId, csrf_token: csrfTokenOf(html) };
  return browser.submit(consentAction, action === undefined ? fields : { ...fields, action });
}

/**
 * authorize → login → consent, the way a browser walks it; resolves to the
 * authorization response the browser lands on. Pure data collection: it
 * neither asserts nor branches, so every check stays in the it() blocks.
 */
async function signIn(
  browser: Browser,
  params: Record<string, string> = authorizationRequest(),
  username = 'testuser',
): Promise<URL> {
  const transactionId = await startAuthorization(browser, params);
  await logIn(browser, transactionId, username);
  return new URL(await decide(browser, transactionId, 'approve'), ISSUER);
}

/** POST to the token endpoint as conformance-client (client_secret_post). */
function tokenRequest(params: Record<string, string>): Promise<Response> {
  return new Browser().post(token.POST, '/token', {
    client_id: 'conformance-client',
    client_secret: 'conformance-secret',
    ...params,
  });
}

function exchangeCode(code: string): Promise<Response> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: CODE_VERIFIER,
  });
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token: string;
  refresh_token?: string;
  scope: string;
}

/** Sign in and redeem the code; resolves to the token response. */
async function issueTokens(
  browser = new Browser(),
  params: Record<string, string> = authorizationRequest(),
): Promise<TokenResponse> {
  const callback = await signIn(browser, params);
  const response = await exchangeCode(callback.searchParams.get('code') ?? '');
  return (await response.json()) as TokenResponse;
}

function userInfoRequest(accessToken: string): Promise<Response> {
  return new Browser().request(userinfo.GET, '/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  // RFC 6749 §2.3.1: both values are form-urlencoded before base64.
  return 'Basic ' + btoa(encodeURIComponent(clientId) + ':' + encodeURIComponent(clientSecret));
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [header = '', payload = ''] = jwt.split('.');
  return { header: decodeSegment(header), payload: decodeSegment(payload) };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Verify an RS256 JWS with the key the JWKS endpoint publishes under its kid. */
async function verifiesWithPublishedKey(jwt: string): Promise<boolean> {
  const [header = '', payload = '', signature = ''] = jwt.split('.');
  const response = await new Browser().request(jwks.GET, '/.well-known/jwks.json');
  const { keys } = (await response.json()) as { keys: Array<JsonWebKey & { kid?: string }> };
  const jwk = keys.find((key) => key.kid === decodeSegment(header)['kid']);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    Buffer.from(signature, 'base64url'),
    new TextEncoder().encode(header + '.' + payload),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  config.issuer = ISSUER;
});

describe('Discovery (OIDC Discovery 1.0 §3 / §4)', () => {
  async function providerMetadata(): Promise<{ response: Response; metadata: Record<string, unknown> }> {
    const response = await new Browser().request(discovery.GET, '/.well-known/openid-configuration');
    return { response, metadata: (await response.json()) as Record<string, unknown> };
  }

  it('should publish every endpoint on the issuer', async () => {
    const { response, metadata } = await providerMetadata();

    expect(response.status).toBe(200);
    expect(metadata).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: ISSUER + '/authorize',
      token_endpoint: ISSUER + '/token',
      userinfo_endpoint: ISSUER + '/userinfo',
      jwks_uri: ISSUER + '/.well-known/jwks.json',
      introspection_endpoint: ISSUER + '/introspect',
      revocation_endpoint: ISSUER + '/revoke',
      device_authorization_endpoint: ISSUER + '/device_authorization',
      backchannel_authentication_endpoint: ISSUER + '/backchannel_authentication',
    });
  });

  it('should advertise exactly what this OP supports', async () => {
    const { metadata } = await providerMetadata();

    expect(metadata).toMatchObject({
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code', 'urn:openid:params:grant-type:ciba'],
      scopes_supported: ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('should let any origin read and cache the metadata', async () => {
    const { response } = await providerMetadata();

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('should publish the signing key without its private members (RFC 7517 §4)', async () => {
    const response = await new Browser().request(jwks.GET, '/.well-known/jwks.json');
    const { keys } = (await response.json()) as { keys: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(keys.map((key) => [key.kid, key.kty, key.alg, key.use, key.d])).toEqual([
      ['conformance-key', 'RSA', 'RS256', 'sig', undefined],
    ]);
  });
});

describe('Authorization Endpoint (OIDC Core 1.0 §3.1.2)', () => {
  it('should send the browser to the login page on the issuer with a new transaction', async () => {
    const response = await new Browser().request(authorize.GET, authorizeUrl(authorizationRequest()));
    const location = new URL(locationOf(response));

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe(ISSUER + '/login');
    expect(location.searchParams.get('transaction_id')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('should accept the request as a form POST (OIDC Core 1.0 §3.1.2.1)', async () => {
    const response = await new Browser().post(authorize.POST, '/authorize', authorizationRequest());
    const location = new URL(locationOf(response));

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe(ISSUER + '/login');
  });

  it('should reject a POST body that is not form-encoded', async () => {
    const response = await new Browser().request(authorize.POST, '/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authorizationRequest()),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Authorization POST requests must use application/x-www-form-urlencoded',
    });
  });

  it('should reject a repeated parameter without redirecting (RFC 6749 §3.1)', async () => {
    const response = await new Browser().request(
      authorize.GET,
      authorizeUrl(authorizationRequest()) + '&scope=openid',
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Parameter "scope" must not be repeated',
    });
  });

  it('should send an unregistered redirect_uri to the OP error page instead of redirecting (OIDC Core 1.0 §3.1.2.2)', async () => {
    const response = await new Browser().request(
      authorize.GET,
      authorizeUrl(authorizationRequest({ redirect_uri: 'https://attacker.example/callback' })),
    );

    expect(response.status).toBe(303);
    expect(locationOf(response)).toBe(
      ISSUER + '/oidc-error?error=invalid_request&error_description=redirect_uri+not+registered',
    );
  });

  it('should answer the same error as JSON to a caller that accepts JSON', async () => {
    const response = await new Browser().request(
      authorize.GET,
      authorizeUrl(authorizationRequest({ redirect_uri: 'https://attacker.example/callback' })),
      { headers: { Accept: 'application/json' } },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'redirect_uri not registered',
    });
  });

  it('should render the error page with the error escaped', async () => {
    const html = await new Browser().render(OidcErrorPage, {
      error: 'invalid_request',
      error_description: '<script>alert(1)</script>',
    });

    expect(html).toBe(
      '<main><h1>Error</h1><p>invalid_request</p><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></main>',
    );
  });

  it('should return a redirectable error to the client with state and iss (RFC 9207 §2)', async () => {
    const response = await new Browser().request(
      authorize.GET,
      authorizeUrl(authorizationRequest({ response_type: 'token' })),
    );
    const location = new URL(locationOf(response));

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(Object.fromEntries(location.searchParams)).toEqual({
      error: 'unsupported_response_type',
      error_description: 'Unsupported response_type: token',
      state: 'conformance-state',
      iss: ISSUER,
    });
  });

  it('should require PKCE from every client (OAuth 2.1 §4.1.1)', async () => {
    const response = await new Browser().request(
      authorize.GET,
      authorizeUrl(authorizationRequest({ code_challenge: undefined, code_challenge_method: undefined })),
    );
    const location = new URL(locationOf(response));

    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('error_description')).toBe('Missing required parameter: code_challenge');
  });

  it('should refuse an unsigned Request Object (OIDC Core 1.0 §6.1)', async () => {
    const unsigned =
      Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') +
      '.' +
      Buffer.from(JSON.stringify(authorizationRequest())).toString('base64url') +
      '.';
    const response = await new Browser().request(
      authorize.GET,
      authorizeUrl(authorizationRequest({ request: unsigned })),
    );
    const location = new URL(locationOf(response));

    expect(response.status).toBe(303);
    expect(location.origin + location.pathname).toBe(ISSUER + '/oidc-error');
    expect(location.searchParams.get('error')).toBe('invalid_request_object');
  });
});

describe('Internal redirect origin (OIDC Discovery 1.0 §3 / RFC 9700 §2.1)', () => {
  it('should ignore the Host header when building the login redirect Location', async () => {
    // Some platforms build request.url from the Host header, so an
    // attacker-chosen Host arrives as an attacker-origin URL. Both are sent;
    // neither may decide where transaction_id lands.
    const response = await new Browser().request(
      authorize.GET,
      authorizeUrl(authorizationRequest(), 'http://attacker.example'),
      { headers: { Host: 'attacker.example' } },
    );
    const location = new URL(locationOf(response));

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe(ISSUER + '/login');
  });

  it('should keep the login redirect Location on the issuer origin for a subpath issuer', async () => {
    // '/login' is an absolute path, so a subpath issuer contributes only its
    // origin. Mounting the generated routes under a subpath (basePath) is a
    // separate concern this provider does not handle.
    config.issuer = 'https://op.example.com/op';
    const response = await new Browser().request(authorize.GET, authorizeUrl(authorizationRequest()));
    const location = new URL(locationOf(response));

    expect(location.origin + location.pathname).toBe('https://op.example.com/login');
  });

  it('should continue from login to consent on a path of this app', async () => {
    // Server Actions redirect within the app, which Next.js resolves against
    // the page the browser is on — never against a request header.
    const browser = new Browser();
    const transactionId = await startAuthorization(browser);

    expect(await logIn(browser, transactionId)).toBe('/consent?transaction_id=' + transactionId);
  });
});

describe('Login page and loginAction (OIDC Core 1.0 §3.1.2.3)', () => {
  it('should render the login form for the transaction', async () => {
    const browser = new Browser();
    const transactionId = await startAuthorization(browser);
    const html = await browser.render(LoginPage, { transaction_id: transactionId });

    expect(html).toContain('<input type="hidden" name="transaction_id" value="' + transactionId + '"/>');
    expect(csrfTokenOf(html)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('should pre-fill the username from login_hint (OIDC Core 1.0 §3.1.2.1)', async () => {
    const browser = new Browser();
    const transactionId = await startAuthorization(browser, authorizationRequest({ login_hint: 'testuser' }));
    const html = await browser.render(LoginPage, { transaction_id: transactionId });

    expect(html).toContain('<input type="text" id="username" required="" name="username" value="testuser"/>');
  });

  it('should show a notice instead of the form for an unknown transaction', async () => {
    const html = await new Browser().render(LoginPage, { transaction_id: 'unknown-transaction' });

    expect(html).toBe(
      '<main><h1>Login</h1><p role="alert">Auth transaction not found. The session may have expired.</p></main>',
    );
  });

  it('should start the OP session in an HttpOnly, Secure, SameSite=Lax cookie', async () => {
    const browser = new Browser();
    const transactionId = await startAuthorization(browser);
    await logIn(browser, transactionId);
    const sessionCookie = harness.cookieWrites.filter((write) => write.name === 'session_id').at(-1);

    expect(sessionCookie?.value).toBe(browser.cookies.get('session_id'));
    expect(sessionCookie?.options).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  });

  it('should send a failed login back to the form with the attempts remaining', async () => {
    const browser = new Browser();
    const transactionId = await startAuthorization(browser);
    const html = await browser.render(LoginPage, { transaction_id: transactionId });
    const location = await browser.submit(loginAction, {
      transaction_id: transactionId,
      csrf_token: csrfTokenOf(html),
      username: 'testuser',
      password: 'wrong-password',
    });

    expect(location).toBe('/login?transaction_id=' + transactionId + '&error=invalid_credentials&remaining=4');
    expect(browser.cookies.has('session_id')).toBe(false);
  });

  it('should render the failed login message', async () => {
    const browser = new Browser();
    const transactionId = await startAuthorization(browser);
    const html = await browser.render(LoginPage, {
      transaction_id: transactionId,
      error: 'invalid_credentials',
      remaining: '4',
    });

    expect(html).toContain('<p role="alert" style="color:red">Invalid credentials. Attempts remaining: 4</p>');
  });

  it('should lock the transaction after too many failed attempts', async () => {
    const browser = new Browser();
    const transactionId = await startAuthorization(browser);
    const csrfToken = csrfTokenOf(await browser.render(LoginPage, { transaction_id: transactionId }));
    const locations: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      locations.push(
        await browser.submit(loginAction, {
          transaction_id: transactionId,
          csrf_token: csrfToken,
          username: 'testuser',
          password: 'wrong-password',
        }),
      );
    }

    expect(locations.at(-1)).toBe('/login?transaction_id=' + transactionId + '&error=too_many_attempts');
  });

  it('should send a submission with a wrong csrf_token to the OP error page', async () => {
    const browser = new Browser();
    const transactionId = await startAuthorization(browser);
    const location = await browser.submit(loginAction, {
      transaction_id: transactionId,
      csrf_token: 'forged',
      username: 'testuser',
      password: 'password',
    });

    expect(location).toBe('/oidc-error?error=invalid_csrf_token&error_description=Invalid+CSRF+token.');
    expect(browser.cookies.has('session_id')).toBe(false);
  });
});

describe('Consent page and consentAction (OIDC Core 1.0 §3.1.2.4)', () => {
  it('should show the client and the requested scopes', async () => {
    const browser = new Browser();
    const transactionId = await startAuthorization(browser);
    await logIn(browser, transactionId);
    const html = await browser.render(ConsentPage, { transaction_id: transactionId });

    expect(html).toContain('<strong>conformance-client</strong>');
    expect(html).toContain('<ul><li>openid</li><li>profile</li></ul>');
  });

  it('should send the browser back to login when the transaction has no signed-in user', async () => {
    const browser = new Browser();
    const transactionId = await startAuthorization(browser);

    expect(await decide(browser, transactionId, 'approve')).toBe('/login?transaction_id=' + transactionId);
  });

  it('should send an unknown transaction to the OP error page', async () => {
    const location = await new Browser().submit(consentAction, {
      transaction_id: 'unknown-transaction',
      csrf_token: 'unknown',
      action: 'approve',
    });

    expect(location).toBe(
      '/oidc-error?error=transaction_not_found&error_description=' +
        'Auth+transaction+not+found.+The+session+may+have+expired.',
    );
  });

  describe('Consent decision value (OIDC Core 1.0 §3.1.2.4)', () => {
    const invalidDecision =
      '/oidc-error?error=invalid_request&error_description=' +
      encodeURIComponent('Invalid consent decision. Please use the Approve or Deny button.');

    async function signedInTransaction(browser: Browser): Promise<string> {
      const transactionId = await startAuthorization(browser);
      await logIn(browser, transactionId);
      return transactionId;
    }

    it('should issue an authorization code when the consent form sends action=approve', async () => {
      const browser = new Browser();
      const location = new URL(await decide(browser, await signedInTransaction(browser), 'approve'));

      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect([...location.searchParams.keys()]).toEqual(['code', 'state', 'iss']);
      expect(location.searchParams.get('state')).toBe('conformance-state');
      expect(location.searchParams.get('iss')).toBe(ISSUER);
    });

    it('should redirect with error=access_denied when the consent form sends action=deny', async () => {
      const browser = new Browser();
      const transactionId = await signedInTransaction(browser);
      const location = new URL(await decide(browser, transactionId, 'deny'));

      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(Object.fromEntries(location.searchParams)).toEqual({
        error: 'access_denied',
        state: 'conformance-state',
        iss: ISSUER,
      });
      expect(await stores.transactionStore.get('auth_txn:' + transactionId)).toBe(null);
    });

    it('should not issue an authorization code when the consent form omits the action parameter', async () => {
      const browser = new Browser();

      expect(await decide(browser, await signedInTransaction(browser), undefined)).toBe(invalidDecision);
    });

    it('should not issue an authorization code when the consent form sends an empty action value', async () => {
      const browser = new Browser();

      expect(await decide(browser, await signedInTransaction(browser), '')).toBe(invalidDecision);
    });

    it('should not issue an authorization code when the consent form sends an unknown action value', async () => {
      const browser = new Browser();

      expect(await decide(browser, await signedInTransaction(browser), 'allow')).toBe(invalidDecision);
    });

    it('should not record consent via recordConsent when the action value is unrecognized', async () => {
      const recordConsent = vi.spyOn(resolvers.consentResolver, 'recordConsent');
      const browser = new Browser();
      await decide(browser, await signedInTransaction(browser), 'allow');

      expect(recordConsent).not.toHaveBeenCalled();
    });

    it('should keep the transaction open after an unrecognized action value', async () => {
      const browser = new Browser();
      const transactionId = await signedInTransaction(browser);
      await decide(browser, transactionId, 'allow');
      const location = new URL(await decide(browser, transactionId, 'approve'));

      expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });
});

describe('Auth transaction User-Agent binding (disabled by default)', () => {
  it('should let another browser holding the transaction_id continue the transaction', async () => {
    // Generate with --enable transaction-binding to refuse this: without it,
    // transaction_id alone is enough to drive login and consent.
    const transactionId = await startAuthorization(new Browser());

    expect(await logIn(new Browser(), transactionId)).toBe('/consent?transaction_id=' + transactionId);
  });
});

describe('Token Endpoint (OIDC Core 1.0 §3.1.3)', () => {
  it('should exchange the code for tokens that must not be cached', async () => {
    const callback = await signIn(new Browser());
    const response = await exchangeCode(callback.searchParams.get('code') ?? '');
    const body = (await response.json()) as TokenResponse;

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'openid profile' });
  });

  it('should issue an ID Token for the signed-in user (OIDC Core 1.0 §2)', async () => {
    const tokens = await issueTokens();

    expect(decodeJwt(tokens.id_token).payload).toMatchObject({
      iss: ISSUER,
      sub: 'testuser',
      aud: 'conformance-client',
      nonce: 'conformance-nonce',
    });
  });

  it('should sign the ID Token with the key the JWKS endpoint publishes', async () => {
    const tokens = await issueTokens();

    expect(decodeJwt(tokens.id_token).header).toMatchObject({ alg: 'RS256', kid: 'conformance-key' });
    expect(await verifiesWithPublishedKey(tokens.id_token)).toBe(true);
  });

  it('should reject a body that is not form-encoded (RFC 6749 §4.1.3)', async () => {
    const response = await new Browser().request(token.POST, '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Token requests must use application/x-www-form-urlencoded',
    });
  });

  it('should reject a repeated parameter (RFC 6749 §3.2)', async () => {
    const response = await new Browser().request(token.POST, '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=a&code=b',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Parameter "code" must not be repeated',
    });
  });

  it('should answer a wrong client_secret with 401 invalid_client (RFC 6749 §5.2)', async () => {
    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code: 'unused',
      client_secret: 'wrong-secret',
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_client');
  });

  it('should challenge a failed HTTP Basic authentication with WWW-Authenticate (RFC 6749 §5.2)', async () => {
    const response = await new Browser().post(
      token.POST,
      '/token',
      { grant_type: 'authorization_code', code: 'unused' },
      { Authorization: basicAuthorization('conformance-basic-client', 'wrong-secret') },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
  });

  it('should authenticate a client_secret_basic client from the Authorization header', async () => {
    const callback = await signIn(new Browser(), authorizationRequest({ client_id: 'conformance-basic-client' }));
    const response = await new Browser().post(
      token.POST,
      '/token',
      {
        grant_type: 'authorization_code',
        code: callback.searchParams.get('code') ?? '',
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
      },
      { Authorization: basicAuthorization('conformance-basic-client', 'conformance-basic-secret') },
    );

    expect(response.status).toBe(200);
  });

  it('should refuse a code_verifier that does not match the code_challenge (RFC 7636 §4.6)', async () => {
    const callback = await signIn(new Browser());
    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code') ?? '',
      redirect_uri: REDIRECT_URI,
      code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-wrong',
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('should refuse a reused code and revoke the tokens issued from it (OAuth 2.1 §4.1.2)', async () => {
    const callback = await signIn(new Browser());
    const code = callback.searchParams.get('code') ?? '';
    const tokens = (await (await exchangeCode(code)).json()) as TokenResponse;
    const reuse = await exchangeCode(code);
    const userInfo = await userInfoRequest(tokens.access_token);

    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe('invalid_grant');
    expect(userInfo.status).toBe(401);
  });

  it('should rotate the refresh token and revoke the family on reuse (OAuth 2.1 §4.3.1)', async () => {
    const tokens = await issueTokens();
    const refresh = (refreshToken: string) =>
      tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    const rotated = (await (await refresh(tokens.refresh_token ?? '')).json()) as TokenResponse;
    const reuse = await refresh(tokens.refresh_token ?? '');
    const afterReuse = await refresh(rotated.refresh_token ?? '');

    expect(rotated.refresh_token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe('invalid_grant');
    expect(afterReuse.status).toBe(400);
  });

  it('should answer a CORS preflight for the configured origin', async () => {
    const response = await new Browser().request(token.OPTIONS, '/token', {
      method: 'OPTIONS',
      headers: { Origin: ISSUER, 'Access-Control-Request-Method': 'POST' },
    });

    expect(response.status).toBe(204);
    expect(Object.fromEntries(response.headers)).toEqual({
      'access-control-allow-origin': ISSUER,
      'access-control-allow-methods': 'POST,GET,OPTIONS',
      'access-control-allow-headers': 'Authorization,Content-Type',
      'access-control-max-age': '600',
      vary: 'Origin',
    });
  });
});

describe('UserInfo Endpoint (OIDC Core 1.0 §5.3)', () => {
  it('should return the claims of the granted scopes (OIDC Core 1.0 §5.4)', async () => {
    const tokens = await issueTokens();
    const response = await userInfoRequest(tokens.access_token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sub: 'testuser',
      name: 'Test User',
      family_name: 'User',
      given_name: 'Test',
      middle_name: 'Q',
      nickname: 'testy',
      preferred_username: 'testuser',
      profile: 'https://op.example.com/users/testuser',
      picture: 'https://op.example.com/users/testuser/avatar.png',
      website: 'https://testuser.example.com',
      gender: 'unspecified',
      birthdate: '1990-01-01',
      zoneinfo: 'Asia/Tokyo',
      locale: 'en-US',
      updated_at: 1700000000,
    });
  });

  it('should accept the access token in a form-encoded POST body (RFC 6750 §2.2)', async () => {
    const tokens = await issueTokens();
    const response = await new Browser().post(userinfo.POST, '/userinfo', { access_token: tokens.access_token });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { sub: string }).sub).toBe('testuser');
  });

  it('should challenge a request without an access token (RFC 6750 §3)', async () => {
    const response = await new Browser().request(userinfo.GET, '/userinfo');

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="UserInfo"');
    expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'Access token is required' });
  });

  it('should reject an access token this OP did not issue', async () => {
    const response = await userInfoRequest('unknown-access-token');

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_token');
  });
});

describe('OP session (OIDC Core 1.0 §3.1.2.1 / §3.1.2.3)', () => {
  it('should reuse the session and the consent already given (single sign-on)', async () => {
    const browser = new Browser();
    await signIn(browser);
    const response = await browser.request(authorize.GET, authorizeUrl(authorizationRequest()));
    const location = new URL(locationOf(response));

    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('should show the consent page again for prompt=consent', async () => {
    const browser = new Browser();
    await signIn(browser);
    const response = await browser.request(authorize.GET, authorizeUrl(authorizationRequest({ prompt: 'consent' })));
    const location = new URL(locationOf(response));

    expect(location.origin + location.pathname).toBe(ISSUER + '/consent');
  });

  it('should ask for a new login for prompt=login even with a session', async () => {
    const browser = new Browser();
    await signIn(browser);
    const response = await browser.request(authorize.GET, authorizeUrl(authorizationRequest({ prompt: 'login' })));
    const location = new URL(locationOf(response));

    expect(location.origin + location.pathname).toBe(ISSUER + '/login');
  });

  it('should answer prompt=none without a session with login_required', async () => {
    const response = await new Browser().request(authorize.GET, authorizeUrl(authorizationRequest({ prompt: 'none' })));
    const location = new URL(locationOf(response));

    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('error')).toBe('login_required');
    expect(location.searchParams.get('state')).toBe('conformance-state');
  });

  it('should issue a code for prompt=none with a session and consent', async () => {
    const browser = new Browser();
    await signIn(browser);
    const response = await browser.request(authorize.GET, authorizeUrl(authorizationRequest({ prompt: 'none' })));
    const location = new URL(locationOf(response));

    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('Token Introspection (RFC 7662)', () => {
  function introspectToken(tokenValue: string, clientSecret = 'conformance-secret'): Promise<Response> {
    return new Browser().post(introspect.POST, '/introspect', {
      token: tokenValue,
      client_id: 'conformance-client',
      client_secret: clientSecret,
    });
  }

  it('should describe an active access token (RFC 7662 §2.2)', async () => {
    const tokens = await issueTokens();
    const response = await introspectToken(tokens.access_token);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      active: true,
      client_id: 'conformance-client',
      sub: 'testuser',
      scope: 'openid profile',
      iss: ISSUER,
    });
  });

  it('should answer active=false for a token this OP did not issue', async () => {
    const response = await introspectToken('unknown-token');

    expect(await response.json()).toEqual({ active: false });
  });

  it('should require client authentication (RFC 7662 §2.1)', async () => {
    const response = await introspectToken('unknown-token', 'wrong-secret');

    expect(response.status).toBe(401);
  });
});

describe('Token Revocation (RFC 7009)', () => {
  function revokeToken(tokenValue: string): Promise<Response> {
    return new Browser().post(revoke.POST, '/revoke', {
      token: tokenValue,
      client_id: 'conformance-client',
      client_secret: 'conformance-secret',
    });
  }

  it('should revoke an access token so it is no longer accepted (RFC 7009 §2.1)', async () => {
    const tokens = await issueTokens();
    const response = await revokeToken(tokens.access_token);
    const userInfo = await userInfoRequest(tokens.access_token);

    expect(response.status).toBe(200);
    expect(userInfo.status).toBe(401);
  });

  it('should answer 200 for a token this OP did not issue (RFC 7009 §2.2)', async () => {
    const response = await revokeToken('unknown-token');

    expect(response.status).toBe(200);
  });
});

describe('Device Authorization Grant (RFC 8628)', () => {
  const DEVICE_CODE = 'urn:ietf:params:oauth:grant-type:device_code';

  interface DeviceAuthorizationResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  }

  async function startDeviceAuthorization(): Promise<DeviceAuthorizationResponse> {
    const response = await new Browser().post(deviceAuthorization.POST, '/device_authorization', {
      client_id: 'conformance-client',
      client_secret: 'conformance-secret',
      scope: 'openid profile',
    });
    return (await response.json()) as DeviceAuthorizationResponse;
  }

  function poll(deviceCode: string, clientId = 'conformance-client', clientSecret = 'conformance-secret'): Promise<Response> {
    return new Browser().post(token.POST, '/token', {
      grant_type: DEVICE_CODE,
      device_code: deviceCode,
      client_id: clientId,
      client_secret: clientSecret,
    });
  }

  /** The verification steps on the second device; resolves to the final screen. */
  async function approveOnSecondDevice(browser: Browser, userCode: string): Promise<Response> {
    const loginScreen = await (await browser.post(device.POST, '/device', { user_code: userCode })).text();
    const approvalScreen = await (
      await browser.post(deviceLogin.POST, '/device/login', {
        user_code: userCode,
        csrf_token: csrfTokenOf(loginScreen),
        username: 'testuser',
        password: 'password',
      })
    ).text();
    return browser.post(deviceApprove.POST, '/device/approve', {
      user_code: userCode,
      csrf_token: csrfTokenOf(approvalScreen),
      decision: 'approve',
    });
  }

  it('should answer the device authorization request (RFC 8628 §3.2)', async () => {
    const body = await startDeviceAuthorization();

    expect(body).toMatchObject({
      verification_uri: ISSUER + '/device',
      expires_in: 600,
      interval: 5,
    });
    expect(body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(body.verification_uri_complete).toBe(ISSUER + '/device?user_code=' + encodeURIComponent(body.user_code));
  });

  it('should answer authorization_pending until the user decides (RFC 8628 §3.5)', async () => {
    const response = await poll((await startDeviceAuthorization()).device_code);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('authorization_pending');
  });

  it('should issue tokens after the user approves on a second device', async () => {
    const { device_code: deviceCode, user_code: userCode } = await startDeviceAuthorization();
    const completed = await approveOnSecondDevice(new Browser(), userCode);
    const response = await poll(deviceCode);
    const tokens = (await response.json()) as TokenResponse;

    expect(completed.status).toBe(200);
    expect(response.status).toBe(200);
    expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'openid profile' });
    expect(decodeJwt(tokens.id_token).payload).toMatchObject({ sub: 'testuser', aud: 'conformance-client' });
  });

  it('should refuse the sign-in step without the browser binding cookie (RFC 8628 §5.4)', async () => {
    const { user_code: userCode } = await startDeviceAuthorization();
    const loginScreen = await (await new Browser().post(device.POST, '/device', { user_code: userCode })).text();
    const response = await new Browser().post(deviceLogin.POST, '/device/login', {
      user_code: userCode,
      csrf_token: csrfTokenOf(loginScreen),
      username: 'testuser',
      password: 'password',
    });

    expect(response.status).toBe(403);
  });

  it('should refuse a device_code presented by another client (RFC 8628 §3.4)', async () => {
    const { device_code: deviceCode, user_code: userCode } = await startDeviceAuthorization();
    await approveOnSecondDevice(new Browser(), userCode);
    const response = await poll(deviceCode, 'conformance-device-client', 'conformance-device-secret');

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
  });
});

describe('CIBA (CIBA Core 1.0, poll mode)', () => {
  const CIBA = 'urn:openid:params:grant-type:ciba';

  async function requestAuthentication(loginHint = 'testuser'): Promise<Response> {
    return new Browser().post(backchannelAuthentication.POST, '/backchannel_authentication', {
      client_id: 'conformance-client',
      client_secret: 'conformance-secret',
      scope: 'openid profile',
      login_hint: loginHint,
    });
  }

  async function authReqId(): Promise<string> {
    return ((await (await requestAuthentication()).json()) as { auth_req_id: string }).auth_req_id;
  }

  function poll(id: string, clientId = 'conformance-client', clientSecret = 'conformance-secret'): Promise<Response> {
    return new Browser().post(token.POST, '/token', {
      grant_type: CIBA,
      auth_req_id: id,
      client_id: clientId,
      client_secret: clientSecret,
    });
  }

  /** The user signs in at /ciba and approves the request id; resolves to the final screen. */
  async function approveOnOwnBrowser(browser: Browser, id: string): Promise<Response> {
    const loginScreen = await (await browser.request(ciba.GET, '/ciba')).text();
    const pendingRequests = await (
      await browser.post(cibaLogin.POST, '/ciba/login', {
        login_transaction_id: loginScreen.match(/name="login_transaction_id" value="([^"]+)"/)?.[1] ?? '',
        csrf_token: csrfTokenOf(loginScreen),
        username: 'testuser',
        password: 'password',
      })
    ).text();
    // Every pending request of the user is listed, each in its own form.
    const form =
      pendingRequests.split('<form').find((html) => html.includes('name="auth_req_id" value="' + id + '"')) ?? '';
    return browser.post(cibaApprove.POST, '/ciba/approve', {
      auth_req_id: id,
      csrf_token: csrfTokenOf(form),
      decision: 'approve',
    });
  }

  it('should accept a request for a known user (CIBA Core 1.0 §7.3)', async () => {
    const response = await requestAuthentication();
    const body = (await response.json()) as { auth_req_id: string; expires_in: number; interval: number };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ expires_in: 120, interval: 5 });
    expect(body.auth_req_id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('should reject a login_hint that names no user (CIBA Core 1.0 §13)', async () => {
    const response = await requestAuthentication('nobody');

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('unknown_user_id');
  });

  it('should answer authorization_pending until the user decides (CIBA Core 1.0 §11)', async () => {
    const response = await poll(await authReqId());

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('authorization_pending');
  });

  it('should issue tokens after the user approves on their own browser', async () => {
    const id = await authReqId();
    const completed = await approveOnOwnBrowser(new Browser(), id);
    const response = await poll(id);
    const tokens = (await response.json()) as TokenResponse;

    expect(completed.status).toBe(200);
    expect(response.status).toBe(200);
    expect(decodeJwt(tokens.id_token).payload).toMatchObject({ sub: 'testuser', aud: 'conformance-client' });
  });

  it('should refuse the sign-in form without the browser binding cookie', async () => {
    const loginScreen = await (await new Browser().request(ciba.GET, '/ciba')).text();
    const response = await new Browser().post(cibaLogin.POST, '/ciba/login', {
      login_transaction_id: loginScreen.match(/name="login_transaction_id" value="([^"]+)"/)?.[1] ?? '',
      csrf_token: csrfTokenOf(loginScreen),
      username: 'testuser',
      password: 'password',
    });

    expect(response.status).toBe(403);
  });

  it('should refuse an auth_req_id presented by another client (CIBA Core 1.0 §11)', async () => {
    const response = await poll(await authReqId(), 'conformance-ciba-client', 'conformance-ciba-secret');

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
  });
});

describe('Sign in with Google (redirect mode)', () => {
  const GOOGLE_CLIENT_ID = 'conformance.apps.googleusercontent.com';

  /** The ID token payload Google would assert for this login page's nonce. */
  function googleIdToken(loginPageHtml: string): string {
    const now = Math.floor(Date.now() / 1000);
    return JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: GOOGLE_CLIENT_ID,
      sub: '1234567890',
      email: 'conformance@example.com',
      email_verified: true,
      nonce: loginPageHtml.match(/data-nonce="([^"]+)"/)?.[1] ?? '',
      iat: now,
      exp: now + 300,
    });
  }

  it('should render the Google button with the login_uri of this OP', async () => {
    const browser = new Browser();
    const transactionId = await startAuthorization(browser);
    const html = await browser.render(LoginPage, { transaction_id: transactionId });

    expect(html).toContain('data-login_uri="' + ISSUER + '/login/google"');
    expect(html).toContain('data-client_id="' + GOOGLE_CLIENT_ID + '"');
  });

  it('should sign in with the Google account and continue to consent', async () => {
    const browser = new Browser();
    const transactionId = await startAuthorization(browser);
    const html = await browser.render(LoginPage, { transaction_id: transactionId });
    // Google Identity Services sets this cookie and posts the same value.
    browser.cookies.set('g_csrf_token', 'double-submit');
    const response = await browser.post(googleLogin.POST, '/login/google', {
      credential: googleIdToken(html),
      g_csrf_token: 'double-submit',
    });
    const callback = new URL(await decide(browser, transactionId, 'approve'));
    const tokens = (await (await exchangeCode(callback.searchParams.get('code') ?? '')).json()) as TokenResponse;

    expect(response.status).toBe(302);
    expect(locationOf(response)).toBe(ISSUER + '/consent?transaction_id=' + transactionId);
    expect(decodeJwt(tokens.id_token).payload.sub).toBe('google:1234567890');
  });

  it('should refuse a callback without the double-submit cookie', async () => {
    const browser = new Browser();
    const transactionId = await startAuthorization(browser);
    const html = await browser.render(LoginPage, { transaction_id: transactionId });
    const response = await browser.post(googleLogin.POST, '/login/google', {
      credential: googleIdToken(html),
      g_csrf_token: 'double-submit',
    });

    expect(response.status).toBe(400);
    expect(browser.cookies.has('session_id')).toBe(false);
  });
});
