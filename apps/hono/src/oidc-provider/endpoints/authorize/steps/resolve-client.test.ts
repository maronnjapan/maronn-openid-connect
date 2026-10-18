import { AuthorizationError } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { CLIENT_ID, REDIRECT_URI, registerTestClient } from '../../../../test-support/authorize.js';
import { providerContext } from '../../../../test-support/context.js';
import { resolveAuthorizationClient } from './resolve-client.js';

describe('resolveAuthorizationClient', () => {
  it('should return the client registered under the client_id', async () => {
    const { c, db } = await providerContext();
    await registerTestClient(db, { scope: ['openid', 'profile'] });

    expect(await resolveAuthorizationClient(c, { client_id: CLIENT_ID })).toEqual({
      clientId: CLIENT_ID,
      clientType: 'confidential',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethods: ['client_secret_basic'],
      scope: ['openid', 'profile'],
    });
  });

  // OIDC Core 1.0 §3.1.2.2: with no client there is no redirect_uri to trust,
  // so the error stays on the OP (no redirectUri).
  it('should reject an unknown client_id with an invalid_request that is not redirectable', async () => {
    const { c } = await providerContext();

    const result = resolveAuthorizationClient(c, { client_id: 'unknown-client' });

    await expect(result).rejects.toBeInstanceOf(AuthorizationError);
    await expect(result).rejects.toMatchObject({
      error: 'invalid_request',
      errorDescription: 'Unknown client_id',
      redirectUri: undefined,
    });
  });

  // OIDC Core 1.0 §3.1.2.1: a redirect_uri MUST NOT include a fragment; a
  // registration that has one is a configuration mistake of the OP.
  it('should reject a client registered with a redirect_uri that has a fragment with server_error', async () => {
    const { c, db } = await providerContext();
    await registerTestClient(db, { redirectUris: ['https://rp.example.com/callback#done'] });

    await expect(resolveAuthorizationClient(c, { client_id: CLIENT_ID })).rejects.toMatchObject({
      error: 'server_error',
      errorDescription: 'Registered redirect_uri must not contain fragment: https://rp.example.com/callback#done',
      redirectUri: undefined,
    });
  });

  // RFC 8252 §8.3: plain http is only for the loopback interface.
  // RFC 6749 §5.2: the em dash of the message is outside the error_description
  // character set, so the description carries "?" in its place.
  it('should reject a client registered with a non-loopback http redirect_uri with server_error', async () => {
    const { c, db } = await providerContext();
    await registerTestClient(db, { redirectUris: ['http://rp.example.com/callback'] });

    await expect(resolveAuthorizationClient(c, { client_id: CLIENT_ID })).rejects.toMatchObject({
      error: 'server_error',
      errorDescription: 'Registered redirect_uri must use https:// or loopback http:// ? got http://rp.example.com/callback',
      redirectUri: undefined,
    });
  });
});
