import { TokenError, signJwt, type Jwk, type SigningKey, type TokenClientInfo } from '@maronn-openid-connect/core';
import { describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, providerContext } from '../test-support/context.js';
import { signRs256Jwt } from '../test-support/feature-endpoints.js';
import { rs256Key } from '../test-support/keys.js';
import { verifyPresentedClientCredential, verifyPrivateKeyJwtAssertion } from './client-auth.js';
import { registerClient } from './db/memory/clients.js';

const CLIENT: TokenClientInfo = { clientId: 'pkjwt-client', tokenEndpointAuthMethods: ['private_key_jwt'] };

let jtiCount = 0;

/** The claims of a client assertion for the token endpoint (OIDC Core 1.0 §9), each with a jti of its own. */
function assertionClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'pkjwt-client',
    sub: 'pkjwt-client',
    aud: `${TEST_ISSUER}/token`,
    exp: now + 60,
    iat: now,
    jti: `jti-${(jtiCount += 1)}`,
    ...overrides,
  };
}

/** A provider with pkjwt-client, whose private_key_jwt key is `key`. */
async function contextWithClient(key: SigningKey) {
  const context = await providerContext();
  await registerClient(context.db, {
    ...CLIENT,
    redirectUris: ['https://rp.example.com/callback'],
    keys: { private_key_jwt: { keys: [{ ...(key.publicJwk as Jwk), kid: key.keyId }] } },
  });
  return context;
}

describe('verifyPrivateKeyJwtAssertion', () => {
  // OIDC Core 1.0 §9: aud is the token endpoint URL.
  it('should accept an assertion signed with the registered key for the token endpoint', async () => {
    const key = await rs256Key('pkjwt-key-1');
    const { c } = await contextWithClient(key);

    await expect(verifyPrivateKeyJwtAssertion(c, CLIENT, await signRs256Jwt(assertionClaims(), key), '/token')).resolves.toBeUndefined();
  });

  // RFC 7523 §3: the issuer identifies the authorization server too.
  it('should accept an assertion whose aud is the issuer', async () => {
    const key = await rs256Key('pkjwt-key-1');
    const { c } = await contextWithClient(key);
    const assertion = await signRs256Jwt(assertionClaims({ aud: TEST_ISSUER }), key);

    await expect(verifyPrivateKeyJwtAssertion(c, CLIENT, assertion, '/introspect')).resolves.toBeUndefined();
  });

  it('should reject an assertion whose aud is another endpoint of the OP', async () => {
    const key = await rs256Key('pkjwt-key-1');
    const { c } = await contextWithClient(key);
    const assertion = await signRs256Jwt(assertionClaims({ aud: `${TEST_ISSUER}/revoke` }), key);

    await expect(verifyPrivateKeyJwtAssertion(c, CLIENT, assertion, '/token')).rejects.toMatchObject({
      error: 'invalid_client',
      errorDescription: 'client_assertion aud does not identify this authorization server',
    });
  });

  // RFC 7523 §3: a replayed assertion is rejected.
  it('should reject the second use of the same assertion', async () => {
    const key = await rs256Key('pkjwt-key-1');
    const { c } = await contextWithClient(key);
    const assertion = await signRs256Jwt(assertionClaims(), key);
    await verifyPrivateKeyJwtAssertion(c, CLIENT, assertion, '/token');

    await expect(verifyPrivateKeyJwtAssertion(c, CLIENT, assertion, '/token')).rejects.toMatchObject({
      error: 'invalid_client',
      errorDescription: 'client_assertion has already been used',
    });
  });

  it('should reject an assertion signed with another key under the kid of the registered key', async () => {
    const { c } = await contextWithClient(await rs256Key('pkjwt-key-1'));
    const attacker = await rs256Key('pkjwt-attacker-key');
    const assertion = await signJwt({ alg: 'RS256', kid: 'pkjwt-key-1' }, assertionClaims(), attacker.privateKey);

    await expect(verifyPrivateKeyJwtAssertion(c, CLIENT, assertion, '/token')).rejects.toMatchObject({
      error: 'invalid_client',
      errorDescription: 'client_assertion signature verification failed',
    });
  });

  // OIDC Dynamic Client Registration 1.0 §2: token_endpoint_auth_signing_alg.
  it('should reject an alg other than the registered token_endpoint_auth_signing_alg before reading keys', async () => {
    const key = await rs256Key('pkjwt-key-1');
    const { c } = await contextWithClient(key);
    const findClientKeys = vi.spyOn(c.get('clientKeyResolver'), 'findClientKeys');

    await expect(
      verifyPrivateKeyJwtAssertion(c, { ...CLIENT, tokenEndpointAuthSigningAlg: 'ES256' }, await signRs256Jwt(assertionClaims(), key), '/token'),
    ).rejects.toMatchObject({
      error: 'invalid_client',
      errorDescription: 'client_assertion alg does not match the registered token_endpoint_auth_signing_alg',
    });
    expect(findClientKeys).not.toHaveBeenCalled();
  });

  it('should reject an alg the OP does not accept', async () => {
    const key = await rs256Key('pkjwt-key-1');
    const { c } = await providerContext({ options: { config: { tokenEndpointAuthSigningAlgValuesSupported: ['ES256'] } } });

    await expect(verifyPrivateKeyJwtAssertion(c, CLIENT, await signRs256Jwt(assertionClaims(), key), '/token')).rejects.toMatchObject({
      error: 'invalid_client',
      errorDescription: 'unsupported client_assertion signing alg: RS256',
    });
  });
});

describe('verifyPresentedClientCredential', () => {
  it('should verify the assertion of a private_key_jwt credential', async () => {
    const key = await rs256Key('pkjwt-key-1');
    const { c } = await contextWithClient(key);
    const clientAssertion = await signRs256Jwt(assertionClaims(), key);

    await expect(
      verifyPresentedClientCredential(c, CLIENT, { clientId: 'pkjwt-client', clientAssertion, method: 'private_key_jwt' }, '/token'),
    ).resolves.toBeUndefined();
  });

  it('should compare the secret of a client_secret_basic credential', async () => {
    const { c } = await providerContext();
    const client: TokenClientInfo = { clientId: 'secret-client', clientSecret: 's3cret', tokenEndpointAuthMethods: ['client_secret_basic'] };

    const verifying = verifyPresentedClientCredential(
      c,
      client,
      { clientId: 'secret-client', clientSecret: 'wrong', method: 'client_secret_basic' },
      '/token',
    );

    await expect(verifying).rejects.toBeInstanceOf(TokenError);
    await expect(verifying).rejects.toMatchObject({ error: 'invalid_client', errorDescription: 'Client authentication failed' });
  });
});
