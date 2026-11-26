import { describe, expect, it } from 'vitest';
import { TEST_ISSUER, requestTo } from '../../../../test-support/context.js';
import { dpopKey, dpopProof, type DpopKey } from '../../../../test-support/dpop.js';
import { providerApp } from '../../../../test-support/screens.js';
import { registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { createProviderStores } from '../../../db/memory/stores.js';
import { registerUser } from '../../../db/memory/users.js';

const USERINFO_ENDPOINT = `${TEST_ISSUER}/userinfo`;
const ALGS = 'algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"';

/** The app with alice, a client, and token-1 bound to boundJkt when given. */
async function setUp(boundJkt?: string) {
  const db = createEmptyDatabase();
  await registerUser(db, { sub: 'alice', email: 'alice@example.com', email_verified: true });
  await registerClient(db, {
    clientId: 'client-1',
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethods: ['none'],
  });
  await createProviderStores(db).accessTokenStore.set('token-1', {
    sub: 'alice',
    scope: ['openid', 'email'],
    clientId: 'client-1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    audience: [USERINFO_ENDPOINT],
    ...(boundJkt === undefined ? {} : { cnf: { jkt: boundJkt }, tokenType: 'DPoP' }),
  } as never);
  return providerApp(db);
}

async function dpopGet(key: DpopKey): Promise<Request> {
  const proof = await dpopProof(key, { htm: 'GET', htu: USERINFO_ENDPOINT, accessToken: 'token-1' });
  return requestTo('/userinfo', { headers: { Authorization: 'DPoP token-1', DPoP: proof } });
}

describe('verifyDpopUserInfoAccess', () => {
  // RFC 9449 §7.2: a DPoP-bound token must not be usable as a Bearer token.
  it('should reject a DPoP-bound token presented as a Bearer token', async () => {
    const key = await dpopKey();
    const app = await setUp(key.jkt);

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'Bearer token-1' } }));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `DPoP error="invalid_token", error_description="A DPoP-bound access token must be presented with the DPoP scheme", ${ALGS}`,
    );
    expect(await response.json()).toEqual({
      error: 'invalid_token',
      error_description: 'A DPoP-bound access token must be presented with the DPoP scheme',
    });
  });

  // RFC 9449 §7.1: the key of the proof must be the key the token is bound to.
  it('should reject a proof of another key than the one the token is bound to', async () => {
    const key = await dpopKey();
    const app = await setUp((await dpopKey()).jkt);

    const response = await app.request(await dpopGet(key));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'The access token is bound to a different DPoP key' });
  });

  it('should reject a Bearer token presented with the DPoP scheme', async () => {
    const app = await setUp();

    const response = await app.request(await dpopGet(await dpopKey()));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'The access token is not bound to a DPoP key' });
  });
});
