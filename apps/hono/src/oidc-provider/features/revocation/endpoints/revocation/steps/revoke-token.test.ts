import { RevocationError } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { accessTokenInfo, refreshTokenInfo } from '../../../../../../test-support/feature-endpoints.js';
import { revokeToken } from './revoke-token.js';

/** A context whose stores hold one grant (an access and a refresh token) and an access token of another grant. */
async function contextWithGrants() {
  const context = await providerContext();
  const { stores } = context;
  const accessToken = accessTokenInfo({ clientId: 'client-1', grantId: 'grant-1' });
  const refreshToken = refreshTokenInfo({ clientId: 'client-1', grantId: 'grant-1' });
  await stores.accessTokenStore.set('at-grant-1', accessToken);
  await stores.refreshTokenStore.set('rt-grant-1', refreshToken);
  await stores.accessTokenStore.set('at-grant-2', accessTokenInfo({ clientId: 'client-1', grantId: 'grant-2' }));
  return { ...context, accessToken, refreshToken };
}

describe('revokeToken', () => {
  // RFC 7009 §2.2: an unknown token is still a success.
  it('should change nothing when the token was not found', async () => {
    const { c, db } = await contextWithGrants();

    await revokeToken(c, 'unknown', null, 'client-1');

    expect([...db.accessTokens.keys()]).toEqual(['at-grant-1', 'at-grant-2']);
    expect([...db.refreshTokens.keys()]).toEqual(['rt-grant-1']);
  });

  // RFC 7009 §2.1: revoking an access token does not revoke the refresh token (the MAY is not taken).
  it('should revoke an access token and keep the refresh token of its grant', async () => {
    const { c, db, accessToken } = await contextWithGrants();

    await revokeToken(c, 'at-grant-1', { tokenType: 'access_token', accessToken }, 'client-1');

    expect([...db.accessTokens.keys()]).toEqual(['at-grant-2']);
    expect([...db.refreshTokens.keys()]).toEqual(['rt-grant-1']);
  });

  // RFC 7009 §2.1 SHOULD: revoking a refresh token revokes the access tokens of the same grant.
  it('should revoke a refresh token and the access tokens of its grant only', async () => {
    const { c, db, refreshToken } = await contextWithGrants();

    await revokeToken(c, 'rt-grant-1', { tokenType: 'refresh_token', refreshToken }, 'client-1');

    expect([...db.accessTokens.keys()]).toEqual(['at-grant-2']);
    expect([...db.refreshTokens.keys()]).toEqual([]);
  });

  // RFC 7009 §2.1: a token issued to another client is refused.
  it('should refuse a token issued to another client with invalid_grant and keep it', async () => {
    const { c, db, refreshToken } = await contextWithGrants();

    const revoking = revokeToken(c, 'rt-grant-1', { tokenType: 'refresh_token', refreshToken }, 'client-2');

    await expect(revoking).rejects.toBeInstanceOf(RevocationError);
    await expect(revoking).rejects.toMatchObject({
      error: 'invalid_grant',
      errorDescription: 'Token was not issued to the requesting client',
      statusCode: 400,
    });
    expect([...db.accessTokens.keys()]).toEqual(['at-grant-1', 'at-grant-2']);
    expect([...db.refreshTokens.keys()]).toEqual(['rt-grant-1']);
  });
});
