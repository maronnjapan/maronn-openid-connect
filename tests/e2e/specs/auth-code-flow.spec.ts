import { expect, test, type Locator } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const resourceServerPort = Number(process.env.E2E_RESOURCE_SERVER_PORT ?? '3030');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const resourceServerURL =
  process.env.E2E_RESOURCE_SERVER_URL ?? `http://${host}:${resourceServerPort}`;
const clientId = 'e2e-client';

test.describe('Authorization Code Flow', () => {
  test('should complete Authorization Code Flow with separate E2E client and resource server', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const redirectUri = `${clientBaseURL}/callback`;
    const discoveryResponse = await request.get(`${issuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.status()).toBe(200);
    const discovery = await discoveryResponse.json() as ProviderMetadata;
    expect(discovery.issuer).toBe(issuer);
    expect(discovery.authorization_endpoint).toBe(`${issuer}/authorize`);
    expect(discovery.token_endpoint).toBe(`${issuer}/token`);
    expect(discovery.jwks_uri).toBe(`${issuer}/.well-known/jwks.json`);
    expect(discovery.userinfo_endpoint).toBe(`${issuer}/userinfo`);
    expect(discovery.introspection_endpoint).toBe(`${issuer}/introspect`);
    expect(discovery.response_types_supported).toEqual(['code']);
    expect(discovery.code_challenge_methods_supported).toEqual(['S256']);

    await page.goto(
      `${clientBaseURL}/start?acr_values=${encodeURIComponent('urn:example:loa:2')}`,
    );
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/login\\?transaction_id=`));

    await page.getByLabel('Username:').fill('testuser');
    await page.getByLabel('Password:').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(issuer)}/consent\\?transaction_id=`));
    await expect(page.locator('strong')).toHaveText(clientId);
    await expect(page.locator('li')).toHaveText(['openid', 'profile', 'email']);

    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(redirectUri)}\\?`));
    await expect(page.getByTestId('token-type')).toHaveText('Bearer');

    const callbackUrl = new URL(page.url());
    expect(`${callbackUrl.origin}${callbackUrl.pathname}`).toBe(redirectUri);
    expect(callbackUrl.searchParams.get('iss')).toBe(issuer);
    const code = requireSearchParam(callbackUrl, 'code');
    const state = requireSearchParam(callbackUrl, 'state');
    expect(code).toHaveLength(43);
    expect(state).toHaveLength(43);
    await expect(page.getByTestId('authorization-code')).toHaveText(code);
    await expect(page.getByTestId('authorization-state')).toHaveText(state);
    await expect(page.getByTestId('authorization-issuer')).toHaveText(issuer);

    const nonce = await locatorText(page.getByTestId('authorization-nonce'), 'authorization nonce');
    const accessToken = await locatorText(page.getByTestId('token-access-token'), 'access token');
    const idToken = await locatorText(page.getByTestId('token-id-token'), 'ID Token');
    expect(nonce).toHaveLength(43);
    expect(accessToken.split('.')).toHaveLength(3);
    expect(idToken.split('.')).toHaveLength(3);
    await expect(page.getByTestId('token-expires-in')).toHaveText('3600');
    await expect(page.getByTestId('token-scope')).toHaveText('openid profile email');
    // offline_access 無しでも Refresh Token は返る。これはログインセッションに束縛された
    // online refresh token で、セッションが終われば使えなくなる（OIDC Core 1.0 §11 が
    // 認める "other contexts"）。online と offline の寿命の違いは
    // authorization-branches.spec.ts が確かめる。
    const refreshToken = await locatorText(
      page.getByTestId('token-refresh-token'),
      'refresh token',
    );
    expect(refreshToken).toHaveLength(43);
    await expect(page.getByTestId('userinfo-sub')).toHaveText('testuser');
    await expect(page.getByTestId('userinfo-email')).toHaveText('test@example.com');
    await expect(page.getByTestId('resource-subject')).toHaveText('testuser');
    await expect(page.getByTestId('resource-client-id')).toHaveText(clientId);
    await expect(page.getByTestId('resource-scope')).toHaveText('openid profile email');
    await expect(page.getByTestId('resource-audience')).toHaveText(
      JSON.stringify([`${issuer}/userinfo`, resourceServerURL]),
    );

    const jwksResponse = await request.get(`${issuer}/.well-known/jwks.json`);
    expect(jwksResponse.status()).toBe(200);
    const jwks = await jwksResponse.json() as JwkSet;
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kty: 'RSA',
      use: 'sig',
      kid: 'e2e-rs256-key',
      alg: 'RS256',
    });
    const parsedIdToken = parseJwt(idToken);
    expect(parsedIdToken.header).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'e2e-rs256-key',
    });
    const signatureValid = await verifyJwtSignature(idToken, jwks);
    expect(signatureValid).toBe(true);
    expect(parsedIdToken.payload).toMatchObject({
      iss: issuer,
      sub: 'testuser',
      aud: clientId,
      nonce,
      acr: 'urn:example:loa:2',
      amr: ['pwd'],
    });
    const issuedAt = requireNumber(parsedIdToken.payload.iat, 'ID Token iat is required');
    const expiresAt = requireNumber(parsedIdToken.payload.exp, 'ID Token exp is required');
    const authTime = requireNumber(parsedIdToken.payload.auth_time, 'ID Token auth_time is required');
    expect(Number.isInteger(issuedAt)).toBe(true);
    expect(Number.isInteger(expiresAt)).toBe(true);
    expect(Number.isInteger(authTime)).toBe(true);
    expect(expiresAt - issuedAt).toBe(3600);
    expect(parsedIdToken.payload.at_hash).toBe(await computeAtHash(accessToken));

    const userInfoResponse = await request.get(`${issuer}/userinfo`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(userInfoResponse.status()).toBe(200);
    expect(userInfoResponse.headers()['cache-control']).toBe('no-store');
    expect(userInfoResponse.headers().pragma).toBe('no-cache');
    // The OP testuser fixture carries the full set of profile-scope claims
    // (OIDC Core 1.0 §5.4); with scope=openid profile email the UserInfo response
    // returns every profile claim plus the email claims.
    expect(await userInfoResponse.json()).toEqual({
      sub: 'testuser',
      // profile scope
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
      // email scope
      email: 'test@example.com',
      email_verified: true,
    });
  });
});

interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint: string;
  introspection_endpoint: string;
  response_types_supported: string[];
  code_challenge_methods_supported: string[];
}

type Jwk = JsonWebKey & {
  alg?: string;
  kid?: string;
  kty?: string;
  use?: string;
};

interface JwkSet {
  keys: Jwk[];
}

interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  nonce?: string;
  iat?: unknown;
  exp?: unknown;
  auth_time?: unknown;
  at_hash?: string;
  [claim: string]: unknown;
}

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: JwtPayload;
  signingInput: string;
  signature: ArrayBuffer;
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (!baseURL) {
    throw new Error('Playwright baseURL is required');
  }
  return baseURL;
}

async function locatorText(locator: Locator, label: string): Promise<string> {
  const value = await locator.textContent();
  if (value === null || value.length === 0) {
    throw new Error(`${label} text is required`);
  }
  return value;
}

async function computeAtHash(accessToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken));
  return base64UrlEncode(new Uint8Array(digest).slice(0, 16));
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
  const kid = requireString(parsed.header.kid, 'ID Token kid is required');
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

function requireSearchParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new Error(`Missing search parameter: ${name}`);
  }
  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

function requireNumber(value: unknown, message: string): number {
  if (typeof value !== 'number') {
    throw new Error(message);
  }
  return value;
}

function requireJwk(jwks: JwkSet, kid: string): Jwk {
  const key = jwks.keys.find((candidate) => candidate.kid === kid);
  if (!key) {
    throw new Error(`JWK not found for kid: ${kid}`);
  }
  return key;
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function base64UrlToBytes(value: string): ArrayBuffer {
  const bytes = Buffer.from(value, 'base64url');
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
