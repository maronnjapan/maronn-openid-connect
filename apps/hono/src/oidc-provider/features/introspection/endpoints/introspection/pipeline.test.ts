import { describe, expect, it } from 'vitest';
import { TEST_ISSUER, formPost } from '../../../../../test-support/context.js';
import {
  accessTokenInfo,
  basicAuthorization,
  decodeJwt,
  nowSeconds,
  providerApp,
  verifyRs256Jwt,
} from '../../../../../test-support/feature-endpoints.js';
import { registerClient } from '../../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../../db/memory/database.js';

async function appWithClients() {
  const db = createEmptyDatabase();
  await registerClient(db, {
    clientId: 'resource-server',
    clientSecret: 'rs-secret',
    redirectUris: [],
    tokenEndpointAuthMethods: ['client_secret_basic'],
  });
  await registerClient(db, {
    clientId: 'public-client',
    redirectUris: ['https://rp.example.com/callback'],
    tokenEndpointAuthMethods: ['none'],
  });
  return providerApp(db);
}

function introspect(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return formPost('/introspect', fields, {
    Authorization: basicAuthorization('resource-server', 'rs-secret'),
    ...headers,
  });
}

describe('introspectionApp', () => {
  // RFC 7662 §2.2.
  it('should describe an active access token to an authenticated confidential client', async () => {
    const { app, stores } = await appWithClients();
    const exp = nowSeconds() + 600;
    await stores.accessTokenStore.set(
      'at-1',
      accessTokenInfo({ sub: 'user-1', clientId: 'client-1', scope: ['openid', 'profile'], expiresAt: exp }),
    );

    const response = await app.request(introspect({ token: 'at-1' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      active: true,
      scope: 'openid profile',
      client_id: 'client-1',
      token_type: 'Bearer',
      sub: 'user-1',
      exp,
    });
  });

  // RFC 7662 §2.2: an unknown token is not told apart from an inactive one.
  it('should answer { active: false } for a token the provider never issued', async () => {
    const { app } = await appWithClients();

    const response = await app.request(introspect({ token: 'unknown' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: false });
  });

  // RFC 9701 §4 / §5 (feature: jwt-introspection-response).
  it('should answer a signed JWT when the caller accepts application/token-introspection+jwt', async () => {
    const { app, stores, signingKey } = await appWithClients();
    await stores.accessTokenStore.set('at-1', accessTokenInfo({ clientId: 'client-1', audience: ['resource-server'] }));

    const response = await app.request(
      introspect({ token: 'at-1' }, { Accept: 'application/token-introspection+jwt' }),
    );
    const jwt = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/token-introspection+jwt');
    expect(decodeJwt(jwt).payload).toMatchObject({
      iss: TEST_ISSUER,
      aud: 'resource-server',
      token_introspection: { active: true, client_id: 'client-1', aud: ['resource-server'] },
    });
    expect(await verifyRs256Jwt(jwt, signingKey.publicJwk)).toBe(true);
  });

  // RFC 7662 §2.1 / RFC 9701 §5: a public client_id alone does not authenticate.
  it('should answer 401 invalid_client to a public client', async () => {
    const { app } = await appWithClients();

    const response = await app.request(formPost('/introspect', { token: 'at-1', client_id: 'public-client' }));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
    expect(await response.json()).toEqual({
      error: 'invalid_client',
      error_description: 'Introspection requires an authenticated confidential client',
    });
  });

  // RFC 7662 §2.1: token is REQUIRED.
  it('should answer 400 invalid_request to a request without token', async () => {
    const { app } = await appWithClients();

    const response = await app.request(introspect({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Missing required parameter: token',
    });
  });
});
