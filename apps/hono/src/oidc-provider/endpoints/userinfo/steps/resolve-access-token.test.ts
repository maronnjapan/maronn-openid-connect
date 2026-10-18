import { UserInfoError, type AccessTokenInfo } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { resolveUserInfoToken } from './resolve-access-token.js';

const NOW = Math.floor(Date.now() / 1000);

function tokenInfo(overrides: Partial<AccessTokenInfo> = {}): AccessTokenInfo {
  return {
    sub: 'alice',
    scope: ['openid', 'email'],
    clientId: 'client-1',
    expiresAt: NOW + 3600,
    audience: ['client-1', 'https://op.example.com/userinfo'],
    ...overrides,
  };
}

/** A provider context whose accessTokenResolver finds info under token-1. */
async function contextWithToken(info: AccessTokenInfo) {
  const { c } = await providerContext();
  c.set('accessTokenResolver', {
    async findAccessToken(token: string) {
      return token === 'token-1' ? info : null;
    },
  });
  return c;
}

describe('resolveUserInfoToken', () => {
  it('should return the stored token information of a valid token', async () => {
    const { c, stores } = await providerContext();
    await stores.accessTokenStore.set('token-1', tokenInfo());

    expect(await resolveUserInfoToken(c, 'token-1')).toEqual(tokenInfo());
  });

  // OIDC Core 1.0 §5.3.3 / RFC 6750 §3.1
  it('should reject an unknown token with invalid_token', async () => {
    const { c } = await providerContext();

    const rejection = resolveUserInfoToken(c, 'unknown');

    await expect(rejection).rejects.toBeInstanceOf(UserInfoError);
    await expect(rejection).rejects.toMatchObject({ error: 'invalid_token', errorDescription: 'Access token is invalid' });
  });

  // RFC 6750 §3.1: an expired token is invalid_token.
  it('should reject an expired token with invalid_token', async () => {
    const c = await contextWithToken(tokenInfo({ expiresAt: NOW - 60 }));

    await expect(resolveUserInfoToken(c, 'token-1')).rejects.toMatchObject({
      error: 'invalid_token',
      errorDescription: 'The access token expired',
    });
  });

  // OIDC Core 1.0 §5.3.1: the UserInfo endpoint needs the openid scope.
  it('should reject a token without the openid scope with insufficient_scope', async () => {
    const c = await contextWithToken(tokenInfo({ scope: ['email'] }));

    await expect(resolveUserInfoToken(c, 'token-1')).rejects.toMatchObject({
      error: 'insufficient_scope',
      errorDescription: 'The openid scope is required',
      statusCode: 403,
    });
  });

  // RFC 9068 §4: the token must name this UserInfo endpoint in aud.
  it('should reject a token whose audience does not name the UserInfo endpoint of the issuer', async () => {
    const c = await contextWithToken(tokenInfo({ audience: ['https://api.example.com'] }));

    await expect(resolveUserInfoToken(c, 'token-1')).rejects.toMatchObject({
      error: 'invalid_token',
      errorDescription: 'The access token is not intended for the UserInfo endpoint',
    });
  });

  it('should reject a token that carries no audience', async () => {
    const c = await contextWithToken(tokenInfo({ audience: undefined }));

    await expect(resolveUserInfoToken(c, 'token-1')).rejects.toMatchObject({ error: 'invalid_token' });
  });
});
