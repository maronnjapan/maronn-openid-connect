import { TokenError } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { basicAuthorization } from '../../../../../../test-support/feature-endpoints.js';
import { registerClient } from '../../../../../db/memory/clients.js';
import { authenticateRevocationClient } from './authenticate-client.js';

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

describe('authenticateRevocationClient', () => {
  describe('Confidential Clients', () => {
    it('should return the client_id of a client authenticated with client_secret_basic', async () => {
      const { c } = await contextWithClients();

      expect(
        await authenticateRevocationClient(c, { token: 't' }, basicAuthorization('confidential-client', 'secret-1')),
      ).toBe('confidential-client');
    });

    it('should return the client_id of a client authenticated with client_secret_post', async () => {
      const { c } = await contextWithClients();

      expect(
        await authenticateRevocationClient(
          c,
          { token: 't', client_id: 'confidential-client', client_secret: 'secret-1' },
          '',
        ),
      ).toBe('confidential-client');
    });

    it('should reject a wrong client_secret with invalid_client', async () => {
      const { c } = await contextWithClients();

      const authenticating = authenticateRevocationClient(
        c,
        { token: 't' },
        basicAuthorization('confidential-client', 'wrong'),
      );

      await expect(authenticating).rejects.toBeInstanceOf(TokenError);
      await expect(authenticating).rejects.toMatchObject({
        error: 'invalid_client',
        errorDescription: 'Client authentication failed',
      });
    });

    it('should reject a confidential client that presents only its client_id with invalid_client', async () => {
      const { c } = await contextWithClients();

      await expect(
        authenticateRevocationClient(c, { token: 't', client_id: 'confidential-client' }, ''),
      ).rejects.toMatchObject({ error: 'invalid_client', errorDescription: 'Client authentication required' });
    });
  });

  describe('Public Clients', () => {
    // RFC 7009 §2.1: a public client identifies itself with its client_id.
    it('should return the client_id of a public client that presents only its client_id', async () => {
      const { c } = await contextWithClients();

      expect(await authenticateRevocationClient(c, { token: 't', client_id: 'public-client' }, '')).toBe(
        'public-client',
      );
    });

    // OIDC Core 1.0 §9: a public client presenting a secret is not its registered method.
    it('should reject a public client that presents a client_secret with invalid_client', async () => {
      const { c } = await contextWithClients();

      await expect(
        authenticateRevocationClient(c, { token: 't', client_id: 'public-client', client_secret: 'x' }, ''),
      ).rejects.toMatchObject({
        error: 'invalid_client',
        errorDescription: 'Client authentication method is not registered for the client',
      });
    });
  });
});
