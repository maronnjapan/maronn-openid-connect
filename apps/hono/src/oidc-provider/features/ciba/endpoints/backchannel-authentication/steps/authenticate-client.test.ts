import { TokenError, type Jwk } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { TEST_ISSUER, providerContext } from '../../../../../../test-support/context.js';
import { signRs256Jwt } from '../../../../../../test-support/feature-endpoints.js';
import { rs256Key } from '../../../../../../test-support/keys.js';
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

const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** A context with a CIBA client that authenticates with private_key_jwt, and the key it signs with. */
async function contextWithKeyClient() {
  const db = createEmptyDatabase();
  const key = await rs256Key('ciba-pkjwt-key');
  await registerClient(db, {
    clientId: 'pkjwt-ciba-client',
    redirectUris: [],
    grantTypes: [CIBA_GRANT],
    tokenEndpointAuthMethods: ['private_key_jwt'],
    keys: { private_key_jwt: { keys: [{ ...(key.publicJwk as Jwk), kid: key.keyId }] } },
  });
  return { c: (await providerContext({ db })).c, key };
}

/** The parameters of a backchannel authentication request authenticated with a client assertion of pkjwt-ciba-client. */
function assertionParams(assertion: string): Record<string, string> {
  return { client_id: 'pkjwt-ciba-client', client_assertion_type: JWT_BEARER, client_assertion: assertion };
}

/** The claims of a client assertion of pkjwt-ciba-client (OIDC Core 1.0 §9). */
function assertionClaims(jti: string, aud: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'pkjwt-ciba-client', sub: 'pkjwt-ciba-client', aud, exp: now + 60, iat: now, jti };
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

  // CIBA Core 1.0 §7.1 / OIDC Core 1.0 §9: a private_key_jwt client authenticates with an assertion for this endpoint.
  describe('private_key_jwt', () => {
    it('should return the registered client for a client assertion for the backchannel authentication endpoint', async () => {
      const { c, key } = await contextWithKeyClient();
      const assertion = await signRs256Jwt(
        assertionClaims('ciba-jti-1', `${TEST_ISSUER}/backchannel_authentication`),
        key,
      );

      expect(await authenticateCibaClient(c, assertionParams(assertion), '')).toMatchObject({
        clientId: 'pkjwt-ciba-client',
        tokenEndpointAuthMethods: ['private_key_jwt'],
      });
    });

    it('should reject a client assertion for the token endpoint with invalid_client', async () => {
      const { c, key } = await contextWithKeyClient();
      const assertion = await signRs256Jwt(assertionClaims('ciba-jti-2', `${TEST_ISSUER}/token`), key);

      await expect(authenticateCibaClient(c, assertionParams(assertion), '')).rejects.toMatchObject({
        error: 'invalid_client',
      });
    });
  });
});
