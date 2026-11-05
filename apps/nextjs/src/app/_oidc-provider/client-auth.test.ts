import { signJwt, type Jwk, type TokenClientInfo } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { signRs256Jwt } from '../../test-support/jwt';
import { rs256Key } from '../../test-support/keys';
import { verifyPresentedClientCredential, verifyPrivateKeyJwtAssertion } from './client-auth';
import { createDatabase, registerClient } from './db';

// provider.ts keeps its clients and stores in the key-value store of db/ (in
// memory for the tests, vitest.config.ts) for the whole file, so every test
// registers a client of its own.

const ISSUER = 'https://op.example.com';

let clientCount = 0;
let jtiCount = 0;

/** Registers a private_key_jwt client whose key is `keyId` and returns it. */
async function privateKeyJwtClient(keyId: string): Promise<{ client: TokenClientInfo; key: Awaited<ReturnType<typeof rs256Key>> }> {
  clientCount += 1;
  const key = await rs256Key(keyId);
  const client: TokenClientInfo = { clientId: `pkjwt-client-${clientCount}`, tokenEndpointAuthMethods: ['private_key_jwt'] };
  await registerClient(createDatabase(), {
    ...client,
    redirectUris: ['https://rp.example.com/callback'],
    keys: { private_key_jwt: { keys: [{ ...(key.publicJwk as Jwk), kid: key.keyId }] } },
  });
  return { client, key };
}

/** The claims of a client assertion of `clientId` (OIDC Core 1.0 §9), each with a jti of its own. */
function assertionClaims(clientId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  jtiCount += 1;
  return { iss: clientId, sub: clientId, aud: `${ISSUER}/token`, exp: now + 60, iat: now, jti: `jti-${jtiCount}`, ...overrides };
}

describe('verifyPrivateKeyJwtAssertion', () => {
  it('should accept an assertion signed with the registered key for the token endpoint', async () => {
    const { client, key } = await privateKeyJwtClient('next-pkjwt-key-1');

    await expect(
      verifyPrivateKeyJwtAssertion(client, await signRs256Jwt(assertionClaims(client.clientId), key), '/token'),
    ).resolves.toBeUndefined();
  });

  // RFC 7523 §3: the issuer identifies the authorization server too.
  it('should accept an assertion whose aud is the issuer', async () => {
    const { client, key } = await privateKeyJwtClient('next-pkjwt-key-1');
    const assertion = await signRs256Jwt(assertionClaims(client.clientId, { aud: ISSUER }), key);

    await expect(verifyPrivateKeyJwtAssertion(client, assertion, '/revoke')).resolves.toBeUndefined();
  });

  // RFC 7523 §3: a replayed assertion is rejected.
  it('should reject the second use of the same assertion', async () => {
    const { client, key } = await privateKeyJwtClient('next-pkjwt-key-1');
    const assertion = await signRs256Jwt(assertionClaims(client.clientId), key);
    await verifyPrivateKeyJwtAssertion(client, assertion, '/token');

    await expect(verifyPrivateKeyJwtAssertion(client, assertion, '/token')).rejects.toMatchObject({
      error: 'invalid_client',
      errorDescription: 'client_assertion has already been used',
    });
  });

  it('should reject an assertion signed with another key under the kid of the registered key', async () => {
    const { client } = await privateKeyJwtClient('next-pkjwt-key-1');
    const attacker = await rs256Key('next-pkjwt-attacker-key');
    const assertion = await signJwt({ alg: 'RS256', kid: 'next-pkjwt-key-1' }, assertionClaims(client.clientId), attacker.privateKey);

    await expect(verifyPrivateKeyJwtAssertion(client, assertion, '/token')).rejects.toMatchObject({
      error: 'invalid_client',
      errorDescription: 'client_assertion signature verification failed',
    });
  });
});

describe('verifyPresentedClientCredential', () => {
  it('should verify the assertion of a private_key_jwt credential', async () => {
    const { client, key } = await privateKeyJwtClient('next-pkjwt-key-1');
    const clientAssertion = await signRs256Jwt(assertionClaims(client.clientId), key);

    await expect(
      verifyPresentedClientCredential(client, { clientId: client.clientId, clientAssertion, method: 'private_key_jwt' }, '/token'),
    ).resolves.toBeUndefined();
  });

  it('should compare the secret of a client_secret_post credential', async () => {
    const client: TokenClientInfo = { clientId: 'secret-client', clientSecret: 's3cret', tokenEndpointAuthMethods: ['client_secret_post'] };

    await expect(
      verifyPresentedClientCredential(client, { clientId: 'secret-client', clientSecret: 'wrong', method: 'client_secret_post' }, '/token'),
    ).rejects.toMatchObject({ error: 'invalid_client', errorDescription: 'Client authentication failed' });
  });
});
