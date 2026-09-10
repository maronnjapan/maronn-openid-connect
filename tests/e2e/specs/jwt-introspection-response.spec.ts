import { expect, test, type Locator } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const resourceServerPort = Number(process.env.E2E_RESOURCE_SERVER_PORT ?? '3030');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const resourceServerURL =
  process.env.E2E_RESOURCE_SERVER_URL ?? `http://${host}:${resourceServerPort}`;
const clientId = 'e2e-client';
const clientSecret = 'e2e-client-secret';
const resourceServerClientId = 'e2e-resource-server';
const resourceServerClientSecret = 'e2e-resource-server-secret';

const INTROSPECTION_JWT_MEDIA_TYPE = 'application/token-introspection+jwt';

/**
 * EXPERIMENTAL — JWT Response for OAuth Token Introspection (RFC 9701).
 *
 * Only the samples generated with `--enable jwt-introspection-response` answer
 * the RFC 9701 Accept header with a signed JWT, so every test here skips when
 * discovery does not advertise introspection_signing_alg_values_supported. That
 * keeps the shared spec suite green across all sample OPs.
 *
 * The verification chain a resource server must run (resolve the key from
 * jwks_uri, verify the JWS, check typ / iss / aud, then read
 * token_introspection) is performed inside this spec, over real HTTP.
 */
test.describe('JWT introspection response (RFC 9701)', () => {
  test('should answer the issuing client with a verifiable signed introspection JWT', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const algs = await introspectionSigningAlgs(request, issuer);
    test.skip(
      !algs.includes('RS256'),
      'This sample OP was generated without --enable jwt-introspection-response',
    );

    const accessToken = await completeAuthorizationCodeFlow(page, issuer);

    // The issuing client itself introspects the token and asks for the signed
    // response (RFC 9701 §4).
    const response = await request.post(`${issuer}/introspect`, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: INTROSPECTION_JWT_MEDIA_TYPE,
      },
      data: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        token: accessToken,
        token_type_hint: 'access_token',
      }).toString(),
    });

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe(INTROSPECTION_JWT_MEDIA_TYPE);

    const jwt = await response.text();
    const parsed = parseJwt(jwt);
    // RFC 9701 §5 REQUIRED typ — the §8.1 cross-JWT confusion defense — plus
    // the §6 default alg and the kid that resolves the key in jwks_uri.
    expect(parsed.header).toEqual({
      typ: 'token-introspection+jwt',
      alg: 'RS256',
      kid: 'e2e-rs256-key',
    });

    const jwks = (await (await request.get(`${issuer}/.well-known/jwks.json`)).json()) as JwkSet;
    expect(await verifyJwtSignature(jwt, jwks)).toBe(true);

    // RFC 9701 §5: iss / aud / iat at the top level and the RFC 7662 members
    // inside token_introspection — nothing else (no top-level sub / exp).
    expect(Object.keys(parsed.payload).sort()).toEqual(['aud', 'iat', 'iss', 'token_introspection']);
    expect(parsed.payload.iss).toBe(issuer);
    expect(parsed.payload.aud).toBe(clientId);
    expect(parsed.payload.token_introspection).toMatchObject({
      active: true,
      client_id: clientId,
      token_type: 'Bearer',
      sub: 'testuser',
      scope: 'openid profile email',
      aud: [`${issuer}/userinfo`, resourceServerURL],
    });
  });

  test('should withhold the signed response from a caller that is not an audience', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const algs = await introspectionSigningAlgs(request, issuer);
    test.skip(
      !algs.includes('RS256'),
      'This sample OP was generated without --enable jwt-introspection-response',
    );

    const accessToken = await completeAuthorizationCodeFlow(page, issuer);

    // The e2e resource server is registered as its own client, but the token's
    // aud carries the resource server URL, not that client_id — so on the JWT
    // path RFC 9701 §3 / §5 requires { active: false }, indistinguishable from
    // an unknown token. (To disclose to a third-party RS, the token must be
    // issued with that RS's client_id as an audience value.)
    const jwtResponse = await request.post(`${issuer}/introspect`, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: INTROSPECTION_JWT_MEDIA_TYPE,
        Authorization: `Basic ${basicCredentials(resourceServerClientId, resourceServerClientSecret)}`,
      },
      data: new URLSearchParams({ token: accessToken, token_type_hint: 'access_token' }).toString(),
    });

    expect(jwtResponse.status()).toBe(200);
    expect(jwtResponse.headers()['content-type']).toBe(INTROSPECTION_JWT_MEDIA_TYPE);
    const parsed = parseJwt(await jwtResponse.text());
    expect(parsed.payload.aud).toBe(resourceServerClientId);
    expect(parsed.payload.token_introspection).toEqual({ active: false });

    // The RFC 7662 JSON path is deliberately unchanged: the same caller without
    // the Accept header keeps seeing the full response, which is what the e2e
    // resource server's /profile check relies on.
    const jsonResponse = await request.post(`${issuer}/introspect`, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicCredentials(resourceServerClientId, resourceServerClientSecret)}`,
      },
      data: new URLSearchParams({ token: accessToken, token_type_hint: 'access_token' }).toString(),
    });

    expect(jsonResponse.status()).toBe(200);
    expect((await jsonResponse.json()) as Record<string, unknown>).toMatchObject({
      active: true,
      client_id: clientId,
      sub: 'testuser',
    });
  });

  test('should advertise the introspection response signing algorithm in discovery', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const algs = await introspectionSigningAlgs(request, issuer);
    test.skip(
      !algs.includes('RS256'),
      'This sample OP was generated without --enable jwt-introspection-response',
    );

    // RFC 9701 §7: the one AS metadata member this implementation emits.
    expect(algs).toEqual(['RS256']);
  });
});

/**
 * Drives the browser through authorize -> login -> consent on the shared e2e
 * client app and returns the access token its result page shows.
 */
async function completeAuthorizationCodeFlow(
  page: import('@playwright/test').Page,
  issuer: string,
): Promise<string> {
  await page.goto(`${clientBaseURL}/start`);
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=`));

  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=`));

  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(clientBaseURL)}/callback\\?`));

  return locatorText(page.getByTestId('token-access-token'), 'access token');
}

interface DiscoveryMetadata {
  introspection_signing_alg_values_supported?: string[];
}

async function introspectionSigningAlgs(
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> },
  issuer: string,
): Promise<string[]> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  const metadata = (await response.json()) as DiscoveryMetadata;
  return metadata.introspection_signing_alg_values_supported ?? [];
}

interface JwkSet {
  keys: Array<Record<string, unknown> & { kid?: string }>;
}

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: ArrayBuffer;
}

function parseJwt(jwt: string): ParsedJwt {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('JWT must have three compact serialization segments');
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
  return {
    header: JSON.parse(base64UrlDecode(headerSegment)),
    payload: JSON.parse(base64UrlDecode(payloadSegment)),
    signingInput: `${headerSegment}.${payloadSegment}`,
    signature: base64UrlToBytes(signatureSegment),
  };
}

async function verifyJwtSignature(jwt: string, jwks: JwkSet): Promise<boolean> {
  const parsed = parseJwt(jwt);
  const kid = requireString(parsed.header.kid, 'introspection JWT kid is required');
  const jwk = requireJwk(jwks, kid);
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
    parsed.signature,
    new TextEncoder().encode(parsed.signingInput),
  );
}

function requireJwk(jwks: JwkSet, kid: string): Record<string, unknown> {
  const jwk = jwks.keys.find((candidate) => candidate.kid === kid);
  if (jwk === undefined) {
    throw new Error(`No JWK published under kid ${kid}`);
  }
  return jwk;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

async function locatorText(locator: Locator, label: string): Promise<string> {
  const value = await locator.textContent();
  if (value === null || value.length === 0) {
    throw new Error(`${label} text is required`);
  }
  return value;
}

function base64UrlDecode(segment: string): string {
  return new TextDecoder().decode(base64UrlToBytes(segment));
}

function base64UrlToBytes(segment: string): ArrayBuffer {
  const bytes = Buffer.from(segment, 'base64url');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function basicCredentials(id: string, secret: string): string {
  return Buffer.from(`${id}:${secret}`).toString('base64');
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
