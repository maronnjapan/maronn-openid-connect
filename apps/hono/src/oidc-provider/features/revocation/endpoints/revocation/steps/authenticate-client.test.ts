import { TokenError, type Jwk } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { TEST_ISSUER, providerContext } from '../../../../../../test-support/context.js';
import { basicAuthorization, signRs256Jwt } from '../../../../../../test-support/feature-endpoints.js';
import { rs256Key } from '../../../../../../test-support/keys.js';
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
  const key = await rs256Key('revocation-pkjwt-key');
  await registerClient(context.db, {
    clientId: 'pkjwt-client',
    redirectUris: ['https://rp.example.com/callback'],
    tokenEndpointAuthMethods: ['private_key_jwt'],
    keys: { private_key_jwt: { keys: [{ ...(key.publicJwk as Jwk), kid: key.keyId }] } },
  });
  return { ...context, key };
}

const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** The parameters of a revocation request authenticated with a client assertion of pkjwt-client. */
function assertionParams(assertion: string): Record<string, string> {
  return { token: 't', client_id: 'pkjwt-client', client_assertion_type: JWT_BEARER, client_assertion: assertion };
}

/** The claims of a client assertion of pkjwt-client (OIDC Core 1.0 §9). */
function assertionClaims(jti: string, aud: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'pkjwt-client', sub: 'pkjwt-client', aud, exp: now + 60, iat: now, jti };
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

  // OIDC Core 1.0 §9 / RFC 7523 §3: the revocation endpoint authenticates as the token endpoint does.
  describe('private_key_jwt', () => {
    it('should return the client_id of a client authenticated with a client assertion for the revocation endpoint', async () => {
      const { c, key } = await contextWithClients();
      const assertion = await signRs256Jwt(assertionClaims('revoke-jti-1', `${TEST_ISSUER}/revoke`), key);

      expect(await authenticateRevocationClient(c, assertionParams(assertion), '')).toBe('pkjwt-client');
    });

    it('should reject a client assertion for the token endpoint with invalid_client', async () => {
      const { c, key } = await contextWithClients();
      const assertion = await signRs256Jwt(assertionClaims('revoke-jti-2', `${TEST_ISSUER}/token`), key);

      await expect(authenticateRevocationClient(c, assertionParams(assertion), '')).rejects.toMatchObject({
        error: 'invalid_client',
      });
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
