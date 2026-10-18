import { describe, expect, it } from 'vitest';
import { formPost, requestTo, TEST_ISSUER } from '../../../../../test-support/context.js';
import { rs256Key, staticKeyProvider } from '../../../../../test-support/keys.js';
import { createApp } from '../../../../app.js';
import { createClientKeyResolver, createClientResolver, registerClient } from '../../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../../db/memory/database.js';
import { createProviderStores } from '../../../../db/memory/stores.js';
import { deviceAuthorizationStore } from '../../store.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

async function appWithDeviceClient() {
  const db = createEmptyDatabase();
  await registerClient(db, {
    clientId: 'tv-app',
    clientSecret: 'tv-secret',
    redirectUris: [],
    grantTypes: [DEVICE_GRANT],
    tokenEndpointAuthMethods: ['client_secret_post'],
  });
  await registerClient(db, {
    clientId: 'web-app',
    clientSecret: 'web-secret',
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethods: ['client_secret_post'],
  });
  return createApp({
    signingKeyProvider: staticKeyProvider(await rs256Key()),
    storage: createProviderStores(db),
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    config: { issuer: TEST_ISSUER },
  });
}

describe('deviceAuthorizationApp', () => {
  // RFC 8628 §3.1 / §3.2: the whole pipeline behind POST /device_authorization.
  it('should answer a registered device client with a device_code and user_code it can use', async () => {
    const app = await appWithDeviceClient();

    const response = await app.request(
      formPost('/device_authorization', { client_id: 'tv-app', client_secret: 'tv-secret', scope: 'openid profile' }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toMatchObject({
      verification_uri: 'https://op.example.com/device',
      verification_uri_complete: `https://op.example.com/device?user_code=${String(body['user_code'])}`,
      expires_in: 600,
      interval: 5,
    });
    expect(await deviceAuthorizationStore.findByDeviceCode(String(body['device_code']))).toMatchObject({
      clientId: 'tv-app',
      scope: ['openid', 'profile'],
      status: 'pending',
      userCodeDisplay: body['user_code'],
    });
  });

  it('should answer a wrong client secret with 401 invalid_client', async () => {
    const app = await appWithDeviceClient();

    const response = await app.request(
      formPost('/device_authorization', { client_id: 'tv-app', client_secret: 'wrong', scope: 'openid' }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_client', error_description: 'Client authentication failed' });
  });

  // RFC 6749 §5.2: the client is not registered for the device_code grant.
  it('should answer a client without the device_code grant with 400 unauthorized_client', async () => {
    const app = await appWithDeviceClient();

    const response = await app.request(
      formPost('/device_authorization', { client_id: 'web-app', client_secret: 'web-secret', scope: 'openid' }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'unauthorized_client',
      error_description: 'The client is not authorized to use the device_code grant',
    });
  });

  it('should answer GET with 405 and Allow: POST', async () => {
    const app = await appWithDeviceClient();

    const response = await app.request(requestTo('/device_authorization'));

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});
