import { TokenError } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { registerClient } from '../../../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../../../db/memory/database.js';
import { authenticateDeviceClient } from './authenticate-client.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function basic(clientId: string, secret: string): string {
  return 'Basic ' + btoa(`${clientId}:${secret}`);
}

async function contextWithClients() {
  const db = createEmptyDatabase();
  await registerClient(db, {
    clientId: 'confidential-device',
    clientSecret: 'device-secret',
    redirectUris: [],
    grantTypes: [DEVICE_GRANT],
    tokenEndpointAuthMethods: ['client_secret_basic'],
  });
  await registerClient(db, {
    clientId: 'public-device',
    redirectUris: [],
    grantTypes: [DEVICE_GRANT],
    tokenEndpointAuthMethods: ['none'],
  });
  return (await providerContext({ db })).c;
}

describe('authenticateDeviceClient', () => {
  // RFC 8628 §3.1: the client authentication of RFC 6749 §3.2.1 applies.
  it('should return the registered client for a valid client_secret_basic secret', async () => {
    const c = await contextWithClients();

    const client = await authenticateDeviceClient(c, {}, basic('confidential-device', 'device-secret'));

    expect(client).toMatchObject({
      clientId: 'confidential-device',
      grantTypes: [DEVICE_GRANT],
      tokenEndpointAuthMethods: ['client_secret_basic'],
    });
  });

  // RFC 6749 §2.1: a public client identifies itself with client_id alone.
  it('should return a public client that presents only its client_id', async () => {
    const c = await contextWithClients();

    const client = await authenticateDeviceClient(c, { client_id: 'public-device' }, '');

    expect(client).toMatchObject({ clientId: 'public-device', tokenEndpointAuthMethods: ['none'] });
  });

  it('should reject a wrong secret with invalid_client and status 401', async () => {
    const c = await contextWithClients();

    const error = await authenticateDeviceClient(c, {}, basic('confidential-device', 'wrong')).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({ error: 'invalid_client', statusCode: 401 });
  });

  it('should reject an unknown client_id with invalid_client', async () => {
    const c = await contextWithClients();

    await expect(authenticateDeviceClient(c, { client_id: 'unknown-device' }, '')).rejects.toMatchObject({
      error: 'invalid_client',
      errorDescription: 'Client authentication failed',
    });
  });

  // OIDC Core 1.0 §9: a method the client did not register is refused (no downgrade).
  it('should reject client_secret_post for a client registered only for client_secret_basic', async () => {
    const c = await contextWithClients();

    await expect(
      authenticateDeviceClient(c, { client_id: 'confidential-device', client_secret: 'device-secret' }, ''),
    ).rejects.toMatchObject({ error: 'invalid_client' });
  });
});
