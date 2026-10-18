import { hashClientSecret } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  basicAuthorization,
  confidentialClient,
} from '../../../../test-support/token.js';
import { registerClient } from '../../../db/memory/clients.js';
import type { TokenRequestBody } from '../response.js';
import { authenticateTokenClient } from './authenticate-client.js';

function paramsOf(fields: Record<string, string>): TokenRequestBody {
  return { grant_type: 'authorization_code', ...fields } as TokenRequestBody;
}

describe('authenticateTokenClient', () => {
  describe('Authenticated clients', () => {
    // OAuth 2.1 §2.3.1: client_secret_basic.
    it('should authenticate a client_secret_basic client and return its registration and client_id', async () => {
      const { c, db } = await providerContext();
      await registerClient(db, confidentialClient());

      await expect(
        authenticateTokenClient(c, paramsOf({}), basicAuthorization(CLIENT_ID, CLIENT_SECRET)),
      ).resolves.toEqual({
        tokenClient: {
          clientId: CLIENT_ID,
          clientSecretHash: await hashClientSecret(CLIENT_SECRET),
          redirectUris: [REDIRECT_URI],
          grantTypes: ['authorization_code', 'refresh_token'],
          tokenEndpointAuthMethods: ['client_secret_basic'],
        },
        authenticatedClientId: CLIENT_ID,
      });
    });

    // OAuth 2.1 §2.3.1: client_secret_post.
    it('should authenticate a client_secret_post client from the client_id and client_secret of the body', async () => {
      const { c, db } = await providerContext();
      await registerClient(db, confidentialClient({ tokenEndpointAuthMethods: ['client_secret_post'] }));

      await expect(
        authenticateTokenClient(c, paramsOf({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }), ''),
      ).resolves.toEqual({
        tokenClient: {
          clientId: CLIENT_ID,
          clientSecretHash: await hashClientSecret(CLIENT_SECRET),
          redirectUris: [REDIRECT_URI],
          grantTypes: ['authorization_code', 'refresh_token'],
          tokenEndpointAuthMethods: ['client_secret_post'],
        },
        authenticatedClientId: CLIENT_ID,
      });
    });

    // OAuth 2.1 §2.4 / RFC 6749 §4.1.3: a public client identifies itself with client_id only.
    it('should authenticate a public client registered with none from its client_id', async () => {
      const { c, db } = await providerContext();
      await registerClient(db, {
        clientId: 'public-client',
        redirectUris: [REDIRECT_URI],
        tokenEndpointAuthMethods: ['none'],
      });

      await expect(authenticateTokenClient(c, paramsOf({ client_id: 'public-client' }), '')).resolves.toEqual({
        tokenClient: {
          clientId: 'public-client',
          redirectUris: [REDIRECT_URI],
          tokenEndpointAuthMethods: ['none'],
        },
        authenticatedClientId: 'public-client',
      });
    });
  });

  describe('Rejected clients', () => {
    // RFC 6749 §5.2: invalid_client.
    it('should reject a request without client credentials with invalid_client', async () => {
      const { c } = await providerContext();

      await expect(authenticateTokenClient(c, paramsOf({}), '')).rejects.toMatchObject({
        error: 'invalid_client',
        errorDescription: 'Client authentication required',
      });
    });

    // RFC 6749 §5.2: the client_id must name a registered client.
    it('should reject an unregistered client_id with invalid_client', async () => {
      const { c } = await providerContext();

      await expect(
        authenticateTokenClient(c, paramsOf({}), basicAuthorization('unknown-client', CLIENT_SECRET)),
      ).rejects.toMatchObject({ error: 'invalid_client', errorDescription: 'Client authentication failed' });
    });

    // OAuth 2.1 §7.4.1: the secret must match the registered one.
    it('should reject a wrong client_secret with invalid_client', async () => {
      const { c, db } = await providerContext();
      await registerClient(db, confidentialClient());

      await expect(
        authenticateTokenClient(c, paramsOf({}), basicAuthorization(CLIENT_ID, 'wrong-secret')),
      ).rejects.toMatchObject({ error: 'invalid_client', errorDescription: 'Client authentication failed' });
    });

    // OIDC Core 1.0 §9: the method used must be one the client registered.
    it('should reject client_secret_post from a client registered only for client_secret_basic with invalid_client', async () => {
      const { c, db } = await providerContext();
      await registerClient(db, confidentialClient());

      await expect(
        authenticateTokenClient(c, paramsOf({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }), ''),
      ).rejects.toMatchObject({
        error: 'invalid_client',
        errorDescription: 'Client authentication method is not registered for the client',
      });
    });

    // OAuth 2.1 §2.3: one authentication method per request.
    it('should reject a client_secret in both the Authorization header and the body with invalid_request', async () => {
      const { c, db } = await providerContext();
      await registerClient(db, confidentialClient());

      await expect(
        authenticateTokenClient(
          c,
          paramsOf({ client_secret: CLIENT_SECRET }),
          basicAuthorization(CLIENT_ID, CLIENT_SECRET),
        ),
      ).rejects.toMatchObject({
        error: 'invalid_request',
        errorDescription:
          'Multiple client authentication methods provided. Use either Authorization header or request body, not both.',
      });
    });
  });
});
