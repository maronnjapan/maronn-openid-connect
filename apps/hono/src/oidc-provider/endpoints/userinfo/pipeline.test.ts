import type { AccessTokenInfo } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { formPost, requestTo } from '../../../test-support/context.js';
import { decodeJwt, providerApp } from '../../../test-support/screens.js';
import { registerClient } from '../../db/memory/clients.js';
import { createEmptyDatabase } from '../../db/memory/database.js';
import { createProviderStores } from '../../db/memory/stores.js';
import { registerUser } from '../../db/memory/users.js';

function tokenInfo(overrides: Partial<AccessTokenInfo> = {}): AccessTokenInfo {
  return {
    sub: 'alice',
    scope: ['openid', 'email'],
    clientId: 'client-1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    audience: ['client-1', 'https://op.example.com/userinfo'],
    ...overrides,
  };
}

/** The app with alice, a client, and token-1 issued to the client for alice. */
async function setUp(input: { token?: AccessTokenInfo; userinfoSignedResponseAlg?: 'RS256' } = {}) {
  const db = createEmptyDatabase();
  await registerUser(db, { sub: 'alice', name: 'Alice Example', email: 'alice@example.com', email_verified: true });
  await registerClient(db, {
    clientId: 'client-1',
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethods: ['none'],
    ...(input.userinfoSignedResponseAlg ? { userinfoSignedResponseAlg: input.userinfoSignedResponseAlg } : {}),
  });
  await createProviderStores(db).accessTokenStore.set('token-1', input.token ?? tokenInfo());
  return providerApp(db);
}

describe('userinfoApp', () => {
  // OIDC Core 1.0 §5.3.1 / §5.3.2
  it('should answer GET with the claims of the granted scopes as uncacheable JSON', async () => {
    const app = await setUp();

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'Bearer token-1' } }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ sub: 'alice', email: 'alice@example.com', email_verified: true });
  });

  // RFC 6750 §2.2
  it('should answer POST with the token in the form body', async () => {
    const app = await setUp();

    const response = await app.request(formPost('/userinfo', { access_token: 'token-1' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sub: 'alice', email: 'alice@example.com', email_verified: true });
  });

  // OIDC Core 1.0 §5.3.2: userinfo_signed_response_alg makes the response a JWT.
  it('should answer application/jwt for a client that registered userinfo_signed_response_alg', async () => {
    const app = await setUp({ userinfoSignedResponseAlg: 'RS256' });

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'Bearer token-1' } }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/jwt');
    expect(decodeJwt(await response.text()).payload).toMatchObject({
      sub: 'alice',
      email: 'alice@example.com',
      iss: 'https://op.example.com',
      aud: 'client-1',
    });
  });

  // RFC 6750 §3.1
  it('should answer a request without a token with 401 and the realm-only challenge', async () => {
    const app = await setUp();

    const response = await app.request(requestTo('/userinfo'));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="UserInfo"');
  });

  // OIDC Core 1.0 §5.3.3
  it('should answer a token without the openid scope with 403 insufficient_scope', async () => {
    const app = await setUp({ token: tokenInfo({ scope: ['email'] }) });

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'Bearer token-1' } }));

    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="UserInfo", error="insufficient_scope", error_description="The openid scope is required"',
    );
    expect(await response.json()).toEqual({
      error: 'insufficient_scope',
      error_description: 'The openid scope is required',
    });
  });

  it('should answer an unknown token with 401 invalid_token', async () => {
    const app = await setUp();

    const response = await app.request(requestTo('/userinfo', { headers: { Authorization: 'Bearer unknown' } }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'Access token is invalid' });
  });
});
