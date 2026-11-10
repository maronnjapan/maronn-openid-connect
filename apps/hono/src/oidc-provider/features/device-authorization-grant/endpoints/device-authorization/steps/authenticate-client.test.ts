import { TokenError, type Jwk } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { TEST_ISSUER, providerContext } from '../../../../../../test-support/context.js';
import { signRs256Jwt } from '../../../../../../test-support/feature-endpoints.js';
import { rs256Key } from '../../../../../../test-support/keys.js';
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

const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** A context with a device client that authenticates with private_key_jwt, and the key it signs with. */
async function contextWithKeyClient() {
  const db = createEmptyDatabase();
  const key = await rs256Key('device-pkjwt-key');
  await registerClient(db, {
    clientId: 'pkjwt-device',
    redirectUris: [],
    grantTypes: [DEVICE_GRANT],
    tokenEndpointAuthMethods: ['private_key_jwt'],
    keys: { private_key_jwt: { keys: [{ ...(key.publicJwk as Jwk), kid: key.keyId }] } },
  });
  return { c: (await providerContext({ db })).c, key };
}

/** The parameters of a device authorization request authenticated with a client assertion of pkjwt-device. */
function assertionParams(assertion: string): Record<string, string> {
  return { client_id: 'pkjwt-device', client_assertion_type: JWT_BEARER, client_assertion: assertion };
}

/** The claims of a client assertion of pkjwt-device (OIDC Core 1.0 §9). */
function assertionClaims(jti: string, aud: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'pkjwt-device', sub: 'pkjwt-device', aud, exp: now + 60, iat: now, jti };
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

  // RFC 8628 §3.1 / OIDC Core 1.0 §9: a private_key_jwt client authenticates with an assertion for this endpoint.
  describe('private_key_jwt', () => {
    it('should return the registered client for a client assertion for the device authorization endpoint', async () => {
      const { c, key } = await contextWithKeyClient();
      const assertion = await signRs256Jwt(assertionClaims('device-jti-1', `${TEST_ISSUER}/device_authorization`), key);

      expect(await authenticateDeviceClient(c, assertionParams(assertion), '')).toMatchObject({
        clientId: 'pkjwt-device',
        tokenEndpointAuthMethods: ['private_key_jwt'],
      });
    });

    it('should reject a client assertion for the token endpoint with invalid_client', async () => {
      const { c, key } = await contextWithKeyClient();
      const assertion = await signRs256Jwt(assertionClaims('device-jti-2', `${TEST_ISSUER}/token`), key);

      await expect(authenticateDeviceClient(c, assertionParams(assertion), '')).rejects.toMatchObject({
        error: 'invalid_client',
      });
    });
  });
});
