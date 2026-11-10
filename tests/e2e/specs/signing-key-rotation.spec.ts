import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
// The key-rotation OP instance of playwright.config.ts: a rotation lasts for
// the rest of the process, so it runs on an OP the other specs do not use.
const rotationOpPort = Number(process.env.E2E_ROTATION_OP_PORT ?? '3060');
const rotationIssuer = process.env.E2E_ROTATION_ISSUER ?? `http://${host}:${rotationOpPort}`;
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;

// Registered in playwright.config.ts. Nothing serves the redirect URI: the
// spec reads the code from the URL the browser lands on and redeems it itself.
const client = {
  clientId: 'e2e-multiple-auth-methods',
  clientSecret: 'e2e-multiple-auth-methods-secret',
  redirectUri: `${clientBaseURL}/multiple-auth-methods-callback`,
};
// playwright.config.ts gives the OP this token: APP_OPERATOR_TOKEN for
// apps/hono, OIDC_SIGNING_KEY_ROTATION_TOKEN for the samples.
const operatorToken = 'e2e-operator-token';

/**
 * Rotation of the OP's signing key while it runs (OIDC Core 1.0 §10.1.1, the
 * oidcc-server-rotate-keys module of the Dynamic OP plan): the OP puts a new
 * key with a kid of its own first in its JWKS, signs the tokens it issues from
 * then on with it, and keeps the old key published so the tokens it signed
 * still verify.
 *
 * apps/hono and the samples rotate through POST /operator/signing-keys/rotate,
 * guarded by a Bearer token. apps/nextjs has neither the route nor the
 * instance, so the spec skips itself.
 */
test.describe('signing key rotation (OIDC Core 1.0 §10.1.1)', () => {
  test.beforeEach(async ({ request }) => {
    test.skip(!(await isServing(request, rotationIssuer)), 'This OP runs no key-rotation instance');
  });

  test('should publish a new key first, keep the old one and sign new ID Tokens with the new kid', async ({
    page,
    request,
  }) => {
    const issuer = rotationIssuer;
    const before = await jwksKids(request, issuer);

    const rotation = await request.post(`${issuer}/operator/signing-keys/rotate`, {
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    expect(rotation.status()).toBe(200);
    const { kid } = (await rotation.json()) as { kid: string };

    // The new key comes first, and every key published before stays.
    expect(before.includes(kid)).toBe(false);
    expect(await jwksKids(request, issuer)).toEqual([kid, ...before]);

    const idToken = await issueIdToken(page, request, issuer);
    expect(jwtHeader(idToken)['kid']).toBe(kid);
  });

  test('should refuse a rotation without the operator token', async ({ request }) => {
    const issuer = rotationIssuer;

    const rotation = await request.post(`${issuer}/operator/signing-keys/rotate`);

    expect(rotation.status()).toBe(401);
  });
});

/** Whether an OP answers its discovery document at issuer. */
async function isServing(request: APIRequestContext, issuer: string): Promise<boolean> {
  try {
    return (await request.get(`${issuer}/.well-known/openid-configuration`)).ok();
  } catch {
    return false;
  }
}

/** The kids of the OP's JWKS, in its order. */
async function jwksKids(request: APIRequestContext, issuer: string): Promise<string[]> {
  const metadata = (await (await request.get(`${issuer}/.well-known/openid-configuration`)).json()) as { jwks_uri: string };
  const jwks = (await (await request.get(metadata.jwks_uri)).json()) as { keys: Array<{ kid: string }> };
  return jwks.keys.map((key) => key.kid);
}

/** Signs in, approves and redeems the code, and returns the ID Token the token endpoint issued. */
async function issueIdToken(page: Page, request: APIRequestContext, issuer: string): Promise<string> {
  const codeVerifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: 'openid',
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
    // A fresh login, whatever session an earlier spec left in the browser.
    prompt: 'login consent',
  });

  await page.goto(`${issuer}/authorize?${params}`);
  await expect(page).toHaveURL(/\/login\?transaction_id=[^&]+$/);
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/consent\?transaction_id=[^&]+$/);
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForURL((url) => url.pathname === '/multiple-auth-methods-callback');
  const code = requireString(new URL(page.url()).searchParams.get('code'), 'code');

  const response = await request.post(`${issuer}/token`, {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: client.redirectUri,
      code_verifier: codeVerifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
  });
  expect(response.status()).toBe(200);
  return requireString(((await response.json()) as Record<string, unknown>)['id_token'], 'id_token');
}

function jwtHeader(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(requireString(jwt.split('.')[0], 'header'), 'base64url').toString('utf8')) as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}
