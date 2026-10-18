import { describe, expect, it } from 'vitest';
import { formPost } from '../../../../../test-support/context.js';
import {
  accessTokenInfo,
  basicAuthorization,
  providerApp,
  refreshTokenInfo,
} from '../../../../../test-support/feature-endpoints.js';
import { registerClient } from '../../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../../db/memory/database.js';

/** A provider with a confidential and a public client, and one grant of each. */
async function appWithGrants() {
  const db = createEmptyDatabase();
  await registerClient(db, {
    clientId: 'confidential-client',
    clientSecret: 'secret-1',
    redirectUris: ['https://rp.example.com/callback'],
    tokenEndpointAuthMethods: ['client_secret_basic'],
  });
  await registerClient(db, {
    clientId: 'public-client',
    redirectUris: ['https://spa.example.com/callback'],
    tokenEndpointAuthMethods: ['none'],
  });
  const provider = await providerApp(db);
  const { stores } = provider;
  await stores.accessTokenStore.set('at-1', accessTokenInfo({ clientId: 'confidential-client', grantId: 'grant-1' }));
  await stores.refreshTokenStore.set('rt-1', refreshTokenInfo({ clientId: 'confidential-client', grantId: 'grant-1' }));
  await stores.accessTokenStore.set('at-public', accessTokenInfo({ clientId: 'public-client', grantId: 'grant-2' }));
  return { ...provider, db };
}

function revokeAsConfidentialClient(fields: Record<string, string>, secret = 'secret-1'): Request {
  return formPost('/revoke', fields, { Authorization: basicAuthorization('confidential-client', secret) });
}

describe('revocationApp', () => {
  // RFC 7009 §2.1 / §2.2: the refresh token and the access tokens of its grant go.
  it('should revoke a refresh token with the access tokens of its grant and answer 200 with an empty body', async () => {
    const { app, db } = await appWithGrants();

    const response = await app.request(revokeAsConfidentialClient({ token: 'rt-1', token_type_hint: 'refresh_token' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('');
    expect([...db.refreshTokens.keys()]).toEqual([]);
    expect([...db.accessTokens.keys()]).toEqual(['at-public']);
  });

  // RFC 7009 §2.2: an unknown token is answered like a revoked one.
  it('should answer 200 for a token the provider never issued', async () => {
    const { app } = await appWithGrants();

    const response = await app.request(revokeAsConfidentialClient({ token: 'unknown' }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  // RFC 7009 §2.1: a public client identifies itself with client_id and revokes its own token.
  it('should let a public client revoke its own token with its client_id', async () => {
    const { app, db } = await appWithGrants();

    const response = await app.request(formPost('/revoke', { token: 'at-public', client_id: 'public-client' }));

    expect(response.status).toBe(200);
    expect(db.accessTokens.has('at-public')).toBe(false);
  });

  // RFC 7009 §2.1: a token of another client is refused and stays.
  it('should answer 400 invalid_grant for a token issued to another client', async () => {
    const { app, db } = await appWithGrants();

    const response = await app.request(revokeAsConfidentialClient({ token: 'at-public' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'Token was not issued to the requesting client',
    });
    expect(db.accessTokens.has('at-public')).toBe(true);
  });

  // RFC 7009 §2.2.1 / RFC 6749 §5.2.
  it('should answer 401 invalid_client with a Basic challenge for a wrong client_secret', async () => {
    const { app, db } = await appWithGrants();

    const response = await app.request(revokeAsConfidentialClient({ token: 'rt-1' }, 'wrong-secret'));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
    expect(await response.json()).toEqual({
      error: 'invalid_client',
      error_description: 'Client authentication failed',
    });
    expect(db.refreshTokens.has('rt-1')).toBe(true);
  });
});
