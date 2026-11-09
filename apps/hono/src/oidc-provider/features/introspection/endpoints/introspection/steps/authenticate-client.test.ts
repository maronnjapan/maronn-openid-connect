import { IntrospectionError, TokenError, type Jwk } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { TEST_ISSUER, providerContext } from '../../../../../../test-support/context.js';
import { basicAuthorization, signRs256Jwt } from '../../../../../../test-support/feature-endpoints.js';
import { rs256Key } from '../../../../../../test-support/keys.js';
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
  const key = await rs256Key('introspection-pkjwt-key');
  await registerClient(context.db, {
    clientId: 'pkjwt-resource-server',
    redirectUris: [],
    tokenEndpointAuthMethods: ['private_key_jwt'],
    keys: { private_key_jwt: { keys: [{ ...(key.publicJwk as Jwk), kid: key.keyId }] } },
  });
  return { ...context, key };
}

const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** The parameters of an introspection request authenticated with a client assertion of pkjwt-resource-server. */
function assertionParams(assertion: string): Record<string, string> {
  return { token: 't', client_id: 'pkjwt-resource-server', client_assertion_type: JWT_BEARER, client_assertion: assertion };
}

/** The claims of a client assertion of pkjwt-resource-server (OIDC Core 1.0 §9). */
function assertionClaims(jti: string, aud: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'pkjwt-resource-server', sub: 'pkjwt-resource-server', aud, exp: now + 60, iat: now, jti };
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

  // OIDC Core 1.0 §9 / RFC 7523 §3: the introspection endpoint authenticates as the token endpoint does.
  describe('private_key_jwt', () => {
    it('should return the client_id of a client authenticated with a client assertion for the introspection endpoint', async () => {
      const { c, key } = await contextWithClients();
      const assertion = await signRs256Jwt(assertionClaims('introspect-jti-1', `${TEST_ISSUER}/introspect`), key);

      expect(await authenticateIntrospectionClient(c, assertionParams(assertion), '')).toBe('pkjwt-resource-server');
    });

    it('should reject a client assertion for the token endpoint with invalid_client', async () => {
      const { c, key } = await contextWithClients();
      const assertion = await signRs256Jwt(assertionClaims('introspect-jti-2', `${TEST_ISSUER}/token`), key);

      await expect(authenticateIntrospectionClient(c, assertionParams(assertion), '')).rejects.toMatchObject({
        error: 'invalid_client',
      });
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
