import { IntrospectionError, TokenError } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { basicAuthorization } from '../../../../../../test-support/feature-endpoints.js';
import { registerClient } from '../../../../../db/memory/clients.js';
import { authenticateIntrospectionClient } from './authenticate-client.js';

async function contextWithClients() {
  const context = await providerContext();
  await registerClient(context.db, {
    clientId: 'resource-server',
    clientSecret: 'rs-secret',
    redirectUris: [],
    tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post'],
  });
  await registerClient(context.db, {
    clientId: 'public-client',
    redirectUris: ['https://rp.example.com/callback'],
    tokenEndpointAuthMethods: ['none'],
  });
  return context;
}

describe('authenticateIntrospectionClient', () => {
  describe('Confidential Clients', () => {
    it('should return the client_id of a client authenticated with client_secret_basic', async () => {
      const { c } = await contextWithClients();

      expect(
        await authenticateIntrospectionClient(c, { token: 't' }, basicAuthorization('resource-server', 'rs-secret')),
      ).toBe('resource-server');
    });

    it('should return the client_id of a client authenticated with client_secret_post', async () => {
      const { c } = await contextWithClients();

      expect(
        await authenticateIntrospectionClient(
          c,
          { token: 't', client_id: 'resource-server', client_secret: 'rs-secret' },
          '',
        ),
      ).toBe('resource-server');
    });

    it('should reject a wrong client_secret with invalid_client', async () => {
      const { c } = await contextWithClients();

      const authenticating = authenticateIntrospectionClient(
        c,
        { token: 't' },
        basicAuthorization('resource-server', 'wrong'),
      );

      await expect(authenticating).rejects.toBeInstanceOf(TokenError);
      await expect(authenticating).rejects.toMatchObject({
        error: 'invalid_client',
        errorDescription: 'Client authentication failed',
      });
    });

    it('should reject an unknown client with invalid_client', async () => {
      const { c } = await contextWithClients();

      await expect(
        authenticateIntrospectionClient(c, { token: 't' }, basicAuthorization('nobody', 'secret')),
      ).rejects.toMatchObject({ error: 'invalid_client', errorDescription: 'Client authentication failed' });
    });

    // OAuth 2.1 §2.3: one authentication method per request.
    it('should reject the Basic header combined with a client_secret in the body with invalid_request', async () => {
      const { c } = await contextWithClients();

      await expect(
        authenticateIntrospectionClient(
          c,
          { token: 't', client_secret: 'rs-secret' },
          basicAuthorization('resource-server', 'rs-secret'),
        ),
      ).rejects.toMatchObject({ error: 'invalid_request' });
    });
  });

  describe('Public Clients', () => {
    // RFC 7662 §2.1 / RFC 9701 §5: a public client_id alone is not authentication.
    it('should reject a client registered with none with invalid_client', async () => {
      const { c } = await contextWithClients();

      const authenticating = authenticateIntrospectionClient(c, { token: 't', client_id: 'public-client' }, '');

      await expect(authenticating).rejects.toBeInstanceOf(IntrospectionError);
      await expect(authenticating).rejects.toMatchObject({
        error: 'invalid_client',
        errorDescription: 'Introspection requires an authenticated confidential client',
        statusCode: 401,
      });
    });
  });
});
