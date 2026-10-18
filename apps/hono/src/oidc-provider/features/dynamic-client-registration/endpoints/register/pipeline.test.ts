import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER } from '../../../../../test-support/context.js';
import { rs256Key, staticKeyProvider } from '../../../../../test-support/keys.js';
import { createApp, type OidcProviderOptions } from '../../../../app.js';
import { createClientKeyResolver, createClientResolver } from '../../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../../db/memory/database.js';
import { createProviderStores } from '../../../../db/memory/stores.js';

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW = Date.UTC(2026, 0, 1) / 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

/** The provider on a database of its own, as an application mounts it. */
async function providerApp(options: Partial<OidcProviderOptions> = {}) {
  const db = createEmptyDatabase();
  return createApp({
    signingKeyProvider: staticKeyProvider(await rs256Key()),
    storage: createProviderStores(db),
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    config: { issuer: TEST_ISSUER },
    ...options,
  });
}

function register(app: Awaited<ReturnType<typeof providerApp>>, metadata: unknown, headers: Record<string, string> = {}) {
  return app.request(`${TEST_ISSUER}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(metadata),
  });
}

describe('registerApp', () => {
  // RFC 7591 §3.1 / §3.2.1: the registration answer, then the issued client_id works on /authorize right away.
  it('should register a client through POST /register that /authorize accepts at once', async () => {
    const app = await providerApp();

    const registration = await register(app, {
      redirect_uris: ['https://rp.example.com/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      client_name: 'Example RP',
    });
    const body = (await registration.json()) as Record<string, unknown>;
    const authorize = await app.request(
      `${TEST_ISSUER}/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: body['client_id'] as string,
        redirect_uri: 'https://rp.example.com/callback',
        scope: 'openid',
        state: 'state-1',
        // RFC 7636 Appendix B
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      }).toString()}`,
    );

    expect(registration.status).toBe(201);
    expect(registration.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toEqual({
      client_id: expect.stringMatching(/^dcr-[A-Za-z0-9_-]{22}$/),
      client_secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      client_secret_expires_at: 0,
      client_id_issued_at: NOW,
      redirect_uris: ['https://rp.example.com/callback'],
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Example RP',
    });
    expect(authorize.status).toBe(302);
    expect(authorize.headers.get('Location')).toBe(`${TEST_ISSUER}/login`);
  });

  // OIDC Dynamic Client Registration 1.0 §3: the initial access token of the dynamicClientRegistration option.
  it('should refuse a registration without the initial access token the option requires', async () => {
    const app = await providerApp({ dynamicClientRegistration: { initialAccessToken: 'iat-secret' } });

    const refused = await register(app, { redirect_uris: ['https://rp.example.com/callback'] });
    const accepted = await register(
      app,
      { redirect_uris: ['https://rp.example.com/callback'] },
      { Authorization: 'Bearer iat-secret' },
    );

    expect([refused.status, refused.headers.get('WWW-Authenticate')]).toEqual([401, 'Bearer']);
    expect(accepted.status).toBe(201);
  });

  // RFC 7591 §3.2.2: invalid metadata is answered with 400 and the error code.
  it('should answer invalid metadata with 400 invalid_client_metadata', async () => {
    const app = await providerApp();

    const response = await register(app, { redirect_uris: ['https://rp.example.com/callback'], response_types: ['token'] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'response_types must be exactly ["code"]',
    });
  });

  it('should answer another method than POST with 405', async () => {
    const app = await providerApp();

    const response = await app.request(`${TEST_ISSUER}/register`);

    expect([response.status, response.headers.get('Allow')]).toEqual([405, 'POST']);
  });
});
