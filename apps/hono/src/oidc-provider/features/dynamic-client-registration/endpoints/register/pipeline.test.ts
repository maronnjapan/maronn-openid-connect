import { ClientRegistrationError } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER } from '../../../../../test-support/context.js';
import { rs256Key, staticKeyProvider } from '../../../../../test-support/keys.js';
import { publisherKey, signSoftwareStatement, TEST_PUBLISHER } from '../../../../../test-support/software-statement.js';
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

  // OIDC Dynamic Client Registration 1.0 §2: the response types the provider answers (implicit-flow / hybrid-flow) are registrable.
  it('should register an implicit client for the response types this provider answers', async () => {
    const app = await providerApp();

    const response = await register(app, {
      redirect_uris: ['https://rp.example.com/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['implicit'],
      response_types: ['token id_token', 'id_token'],
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      token_endpoint_auth_method: 'none',
      grant_types: ['implicit'],
      response_types: ['id_token token', 'id_token'],
    });
  });

  // RFC 7591 §2: a grant the provider answers (device code of the generated
  // feature) stays unregistrable until the registration config lists it; the
  // option adds it beside the generated grants.
  it('should register an experimental grant only once the dynamicClientRegistration option adds it', async () => {
    const deviceCode = 'urn:ietf:params:oauth:grant-type:device_code';
    const metadata = { redirect_uris: ['https://rp.example.com/callback'], grant_types: ['authorization_code', deviceCode] };

    const refused = await register(await providerApp(), metadata);
    const accepted = await register(
      await providerApp({ dynamicClientRegistration: { grantTypes: [deviceCode] } }),
      metadata,
    );

    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'grant_types must be an array containing only authorization_code, refresh_token, implicit',
    });
    expect(accepted.status).toBe(201);
    expect(((await accepted.json()) as Record<string, unknown>)['grant_types']).toEqual(['authorization_code', deviceCode]);
  });

  it('should register the signed response algs of the provider signing keys and reject another', async () => {
    const app = await providerApp();

    const accepted = await register(app, {
      redirect_uris: ['https://rp.example.com/callback'],
      id_token_signed_response_alg: 'RS256',
      userinfo_signed_response_alg: 'RS256',
    });
    const refused = await register(app, { redirect_uris: ['https://rp.example.com/callback'], id_token_signed_response_alg: 'ES256' });

    expect(accepted.status).toBe(201);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'id_token_signed_response_alg must be one of RS256',
    });
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

  it('should let a verifyInitialAccessToken of the option decide who may register', async () => {
    const app = await providerApp({
      dynamicClientRegistration: {
        verifyInitialAccessToken: async (authorization) => authorization === 'Bearer custom-ticket',
      },
    });

    const refused = await register(app, { redirect_uris: ['https://rp.example.com/callback'] }, { Authorization: 'Bearer other' });
    const accepted = await register(
      app,
      { redirect_uris: ['https://rp.example.com/callback'] },
      { Authorization: 'Bearer custom-ticket' },
    );

    expect([refused.status, refused.headers.get('WWW-Authenticate')]).toEqual([401, 'Bearer error="invalid_token"']);
    expect(accepted.status).toBe(201);
  });

  // RFC 7591 §3.1.1 / §3.2.1: the metadata of a trusted software statement wins
  // over the plain values, and the statement comes back unmodified.
  it('should apply the metadata of a trusted software statement and return the statement', async () => {
    const publisher = await publisherKey();
    const app = await providerApp({
      dynamicClientRegistration: { trustedSoftwarePublishers: [{ issuer: TEST_PUBLISHER, jwks: publisher.jwks }] },
    });
    const statement = await signSoftwareStatement(
      { client_name: 'Published App', software_id: 'sw-1', software_version: '2.0' },
      publisher.signingKey,
    );

    const response = await register(app, {
      redirect_uris: ['https://rp.example.com/callback'],
      client_name: 'Plain Name',
      software_statement: statement,
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      client_name: 'Published App',
      software_id: 'sw-1',
      software_version: '2.0',
      software_statement: statement,
    });
  });

  // RFC 7591 §3.2.2: the two software statement error codes.
  it('should answer unapproved_software_statement for an unknown publisher and invalid_software_statement for a broken statement', async () => {
    const publisher = await publisherKey();
    const app = await providerApp();

    const unapproved = await register(app, {
      redirect_uris: ['https://rp.example.com/callback'],
      software_statement: await signSoftwareStatement({ client_name: 'Published App' }, publisher.signingKey),
    });
    const invalid = await register(app, { redirect_uris: ['https://rp.example.com/callback'], software_statement: 'not-a-jwt' });

    expect(unapproved.status).toBe(400);
    expect(await unapproved.json()).toEqual({
      error: 'unapproved_software_statement',
      error_description: 'the issuer of the software_statement is not approved by this authorization server',
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: 'invalid_software_statement',
      error_description: 'software_statement must be a JWS compact serialization',
    });
  });

  it('should register and echo the custom metadata of the option, and ignore unknown metadata', async () => {
    const app = await providerApp({
      dynamicClientRegistration: {
        customClientMetadata: {
          tenant_id: (value) => {
            if (typeof value !== 'string') {
              throw new ClientRegistrationError('invalid_client_metadata', 'tenant_id must be a string');
            }
            return value;
          },
        },
      },
    });

    const accepted = await register(app, { redirect_uris: ['https://rp.example.com/callback'], tenant_id: 'acme', logo_uri: 'https://rp.example.com/logo.png', unknown_field: 1 });
    const refused = await register(app, { redirect_uris: ['https://rp.example.com/callback'], tenant_id: 1 });

    expect(accepted.status).toBe(201);
    const body = (await accepted.json()) as Record<string, unknown>;
    expect(body['tenant_id']).toBe('acme');
    expect(body['logo_uri']).toBe('https://rp.example.com/logo.png');
    expect(Object.hasOwn(body, 'unknown_field')).toBe(false);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'invalid_client_metadata', error_description: 'tenant_id must be a string' });
  });

  // RFC 7591 §3.2.2: invalid metadata is answered with 400 and the error code.
  it('should answer invalid metadata with 400 invalid_client_metadata', async () => {
    const app = await providerApp();

    const response = await register(app, { redirect_uris: ['https://rp.example.com/callback'], response_types: ['token'] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description:
        'response_types must be a non-empty array containing only code, id_token, id_token token, code id_token, code token, code id_token token',
    });
  });

  it('should answer another method than POST with 405', async () => {
    const app = await providerApp();

    const response = await app.request(`${TEST_ISSUER}/register`);

    expect([response.status, response.headers.get('Allow')]).toEqual([405, 'POST']);
  });
});
