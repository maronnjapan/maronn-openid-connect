import { TokenError } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { registerClient } from '../../../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../../../db/memory/database.js';
import { authenticateCibaClient } from './authenticate-client.js';

const CIBA_GRANT = 'urn:openid:params:grant-type:ciba';

function basic(clientId: string, secret: string): string {
  return 'Basic ' + btoa(`${clientId}:${secret}`);
}

async function contextWithClient() {
  const db = createEmptyDatabase();
  await registerClient(db, {
    clientId: 'ciba-client',
    clientSecret: 'ciba-secret',
    redirectUris: [],
    grantTypes: [CIBA_GRANT],
    tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post'],
  });
  return (await providerContext({ db })).c;
}

describe('authenticateCibaClient', () => {
  // CIBA Core 1.0 §7.1: the client authenticates with its registered method.
  it('should return the registered client for a valid client_secret_basic secret', async () => {
    const c = await contextWithClient();

    expect(await authenticateCibaClient(c, {}, basic('ciba-client', 'ciba-secret'))).toMatchObject({
      clientId: 'ciba-client',
      grantTypes: [CIBA_GRANT],
    });
  });

  it('should return the registered client for a valid client_secret_post secret', async () => {
    const c = await contextWithClient();

    expect(
      await authenticateCibaClient(c, { client_id: 'ciba-client', client_secret: 'ciba-secret' }, ''),
    ).toMatchObject({ clientId: 'ciba-client' });
  });

  it('should reject a wrong secret with invalid_client and status 401', async () => {
    const c = await contextWithClient();

    const error = await authenticateCibaClient(c, {}, basic('ciba-client', 'wrong')).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({ error: 'invalid_client', statusCode: 401 });
  });

  // CIBA Core 1.0 §7.1: client authentication is mandatory.
  it('should reject a confidential client that presents no secret with invalid_client', async () => {
    const c = await contextWithClient();

    await expect(authenticateCibaClient(c, { client_id: 'ciba-client' }, '')).rejects.toMatchObject({
      error: 'invalid_client',
      errorDescription: 'Client authentication required',
    });
  });

  // OAuth 2.1 §2.3: one authentication method per request.
  it('should reject a Basic header together with a posted secret with invalid_request', async () => {
    const c = await contextWithClient();

    await expect(
      authenticateCibaClient(c, { client_secret: 'ciba-secret' }, basic('ciba-client', 'ciba-secret')),
    ).rejects.toMatchObject({ error: 'invalid_request' });
  });
});
