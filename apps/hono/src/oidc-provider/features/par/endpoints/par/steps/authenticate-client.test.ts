import type { Jwk } from '@maronn-openid-connect/core';
import { ParError } from '@maronn-openid-connect/experimental/par';
import { describe, expect, it } from 'vitest';
import { TEST_ISSUER, providerContext } from '../../../../../../test-support/context.js';
import { basicAuthorization, signRs256Jwt } from '../../../../../../test-support/feature-endpoints.js';
import { rs256Key } from '../../../../../../test-support/keys.js';
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
  const key = await rs256Key('par-pkjwt-key');
  await registerClient(context.db, {
    clientId: 'pkjwt-client',
    redirectUris: ['https://rp.example.com/callback'],
    tokenEndpointAuthMethods: ['private_key_jwt'],
    keys: { private_key_jwt: { keys: [{ ...(key.publicJwk as Jwk), kid: key.keyId }] } },
  });
  return { ...context, key };
}

const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** The claims of a client assertion of pkjwt-client (OIDC Core 1.0 §9). */
function assertionClaims(jti: string, aud: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'pkjwt-client', sub: 'pkjwt-client', aud, exp: now + 60, iat: now, jti };
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

  describe('private_key_jwt', () => {
    // OIDC Core 1.0 §9 / RFC 7523 §3: aud may be the PAR endpoint URL.
    it('should authenticate a client assertion for the PAR endpoint and leave it out of the pushed parameters', async () => {
      const { c, key } = await contextWithClients();
      const assertion = await signRs256Jwt(assertionClaims('par-jti-1', `${TEST_ISSUER}/par`), key);

      const result = await authenticatePushingClient(
        c,
        { client_id: 'pkjwt-client', client_assertion_type: JWT_BEARER, client_assertion: assertion, scope: 'openid' },
        '',
      );

      expect(result).toEqual({ clientId: 'pkjwt-client', pushedParams: { client_id: 'pkjwt-client', scope: 'openid' } });
    });

    it('should reject a client assertion signed with another key with a 401 invalid_client', async () => {
      const { c } = await contextWithClients();
      // Another key pair under the kid of the registered key.
      const attacker = { ...(await rs256Key('par-attacker-key')), keyId: 'par-pkjwt-key' };
      const forged = await signRs256Jwt(assertionClaims('par-jti-2', `${TEST_ISSUER}/par`), attacker);

      const authenticating = authenticatePushingClient(
        c,
        { client_id: 'pkjwt-client', client_assertion_type: JWT_BEARER, client_assertion: forged },
        '',
      );

      await expect(authenticating).rejects.toBeInstanceOf(ParError);
      await expect(authenticating).rejects.toMatchObject({ code: 'invalid_client', statusCode: 401 });
    });

    it('should reject a client assertion for the token endpoint', async () => {
      const { c, key } = await contextWithClients();
      const assertion = await signRs256Jwt(assertionClaims('par-jti-3', `${TEST_ISSUER}/token`), key);

      await expect(
        authenticatePushingClient(c, { client_id: 'pkjwt-client', client_assertion_type: JWT_BEARER, client_assertion: assertion }, ''),
      ).rejects.toMatchObject({ code: 'invalid_client' });
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
