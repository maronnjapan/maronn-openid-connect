import { ParError } from '@maronn-openid-connect/experimental/par';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { basicAuthorization } from '../../../../../../test-support/feature-endpoints.js';
import { registerClient } from '../../../../../db/memory/clients.js';
import { authenticatePushingClient } from './authenticate-client.js';

async function contextWithClients() {
  const context = await providerContext();
  await registerClient(context.db, {
    clientId: 'confidential-client',
    clientSecret: 'secret-1',
    redirectUris: ['https://rp.example.com/callback'],
    tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post'],
  });
  await registerClient(context.db, {
    clientId: 'public-client',
    redirectUris: ['https://rp.example.com/callback'],
    tokenEndpointAuthMethods: ['none'],
  });
  return context;
}

describe('authenticatePushingClient', () => {
  describe('Client Authentication', () => {
    // RFC 9126 §2.1: the pushing client authenticates as at the token endpoint.
    it('should pin the pushed client_id to the client of the Basic header when the body omits it', async () => {
      const { c } = await contextWithClients();

      const result = await authenticatePushingClient(
        c,
        { scope: 'openid' },
        basicAuthorization('confidential-client', 'secret-1'),
      );

      expect(result).toEqual({
        clientId: 'confidential-client',
        pushedParams: { scope: 'openid', client_id: 'confidential-client' },
      });
    });

    it('should authenticate a client_secret_post client and keep its parameters', async () => {
      const { c } = await contextWithClients();

      const result = await authenticatePushingClient(
        c,
        { client_id: 'confidential-client', client_secret: 'secret-1', scope: 'openid' },
        '',
      );

      expect(result).toEqual({
        clientId: 'confidential-client',
        pushedParams: { client_id: 'confidential-client', client_secret: 'secret-1', scope: 'openid' },
      });
    });

    it('should identify a public client by its client_id alone', async () => {
      const { c } = await contextWithClients();

      const result = await authenticatePushingClient(c, { client_id: 'public-client' }, '');

      expect(result).toEqual({ clientId: 'public-client', pushedParams: { client_id: 'public-client' } });
    });

    it('should reject a wrong client_secret with a 401 invalid_client', async () => {
      const { c } = await contextWithClients();

      const authenticating = authenticatePushingClient(c, {}, basicAuthorization('confidential-client', 'wrong'));

      await expect(authenticating).rejects.toBeInstanceOf(ParError);
      await expect(authenticating).rejects.toMatchObject({
        code: 'invalid_client',
        statusCode: 401,
        wwwAuthenticate: 'Basic realm="Client Authentication"',
      });
    });
  });

  describe('Forbidden Parameters', () => {
    // RFC 9126 §2.1: request_uri MUST NOT be provided in a pushed request.
    it('should reject a pushed request_uri with invalid_request', async () => {
      const { c } = await contextWithClients();

      await expect(
        authenticatePushingClient(
          c,
          { client_id: 'public-client', request_uri: 'urn:ietf:params:oauth:request_uri:abc' },
          '',
        ),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        errorDescription: 'request_uri MUST NOT be included in a pushed authorization request',
      });
    });

    it('should reject a pushed Request Object with invalid_request', async () => {
      const { c } = await contextWithClients();

      await expect(
        authenticatePushingClient(c, { client_id: 'public-client', request: 'a.b.c' }, ''),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        errorDescription:
          'The request parameter (Request Object) is not supported by this pushed authorization request endpoint',
      });
    });
  });
});
