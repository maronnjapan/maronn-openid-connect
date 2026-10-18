import type { TokenRequestParams } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import {
  AUTH_TIME,
  CLIENT_ID,
  NOW,
  SUBJECT,
  refreshTokenRequest,
  storedRefreshToken,
} from '../../../../test-support/token.js';
import { validateRefreshTokenGrant } from './validate-refresh-token-grant.js';

function paramsOf(fields: Partial<TokenRequestParams>): TokenRequestParams {
  return { grant_type: 'refresh_token', refresh_token: 'rt-1', ...fields };
}

describe('validateRefreshTokenGrant', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Grant dispatch', () => {
    it('should return undefined for the authorization_code grant, which another step validates', async () => {
      const { c } = await providerContext();

      await expect(
        validateRefreshTokenGrant(c, { grant_type: 'authorization_code', code: 'code-1' }, CLIENT_ID, 'authorization_code'),
      ).resolves.toBeUndefined();
    });
  });

  describe('Valid refresh tokens', () => {
    // OAuth 2.1 §4.3.1: the grant of the stored refresh token, for the authenticated client.
    it('should return the validated request carrying the stored grant of an offline refresh token', async () => {
      const { c, stores } = await providerContext();
      await stores.refreshTokenStore.set(
        'rt-1',
        storedRefreshToken({ acr: 'urn:acr:mfa', amr: ['pwd', 'otp'], azp: CLIENT_ID, nonce: 'nonce-1' }),
      );

      await expect(validateRefreshTokenGrant(c, paramsOf({}), CLIENT_ID, 'refresh_token')).resolves.toEqual(
        refreshTokenRequest({ acr: 'urn:acr:mfa', amr: ['pwd', 'otp'], azp: CLIENT_ID, nonce: 'nonce-1' }),
      );
    });

    // RFC 6749 §6: the requested scope may only narrow the original grant.
    it('should narrow the scope to the requested subset and still report the offline_access of the grant', async () => {
      const { c, stores } = await providerContext();
      await stores.refreshTokenStore.set('rt-1', storedRefreshToken());

      await expect(
        validateRefreshTokenGrant(c, paramsOf({ scope: 'openid' }), CLIENT_ID, 'refresh_token'),
      ).resolves.toEqual(refreshTokenRequest({ scope: ['openid'], hadOfflineAccess: true }));
    });

    // OIDC Core 1.0 §11: an online refresh token is usable while its login session lasts.
    it('should accept an online refresh token whose login session is still active for the same user', async () => {
      const { c, stores } = await providerContext();
      await stores.browserSessionStore.set('session-1', { subject: SUBJECT, authTime: AUTH_TIME });
      await stores.refreshTokenStore.set(
        'rt-1',
        storedRefreshToken({ scope: ['openid', 'profile'], sessionId: 'session-1' }),
      );

      await expect(validateRefreshTokenGrant(c, paramsOf({}), CLIENT_ID, 'refresh_token')).resolves.toEqual(
        refreshTokenRequest({ scope: ['openid', 'profile'], hadOfflineAccess: false, sessionId: 'session-1' }),
      );
    });
  });

  describe('Rejected refresh tokens', () => {
    // RFC 6749 §6: refresh_token is REQUIRED.
    it('should reject a request without refresh_token with invalid_request', async () => {
      const { c } = await providerContext();

      await expect(
        validateRefreshTokenGrant(c, paramsOf({ refresh_token: undefined }), CLIENT_ID, 'refresh_token'),
      ).rejects.toMatchObject({ error: 'invalid_request', errorDescription: 'Missing required parameter: refresh_token' });
    });

    // RFC 6749 §5.2 / OAuth 2.1 §6.1: unknown, or past its absolute lifetime (the store evicts it).
    it('should reject a refresh token past its absolute lifetime with invalid_grant', async () => {
      const { c, stores } = await providerContext();
      await stores.refreshTokenStore.set('rt-1', storedRefreshToken({ expiresAt: NOW }));

      await expect(validateRefreshTokenGrant(c, paramsOf({}), CLIENT_ID, 'refresh_token')).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'Refresh token not found',
      });
    });

    // OAuth 2.1 §4.3.1 / RFC 9700 §4.14: reuse of a rotated refresh token revokes the token family.
    it('should reject a rotated refresh token with invalid_grant and revoke the tokens of its grant', async () => {
      const { c, stores } = await providerContext();
      await stores.refreshTokenStore.set('rt-1', storedRefreshToken({ used: true }));
      await stores.refreshTokenStore.set('rt-2', storedRefreshToken());
      await stores.accessTokenStore.set('at-1', {
        sub: SUBJECT,
        scope: ['openid'],
        clientId: CLIENT_ID,
        expiresAt: NOW + 3600,
        grantId: 'grant-1',
      });

      await expect(validateRefreshTokenGrant(c, paramsOf({}), CLIENT_ID, 'refresh_token')).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'Refresh token has already been used',
      });
      expect(await stores.refreshTokenStore.get('rt-2')).toBeUndefined();
      expect(await stores.accessTokenStore.get('at-1')).toBeUndefined();
    });

    // OAuth 2.1 §4.3.1: the refresh token is bound to the client it was issued to.
    it('should reject a refresh token issued to another client with invalid_grant', async () => {
      const { c, stores } = await providerContext();
      await stores.refreshTokenStore.set('rt-1', storedRefreshToken());

      await expect(validateRefreshTokenGrant(c, paramsOf({}), 'client-2', 'refresh_token')).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'Refresh token was issued to a different client',
      });
    });

    // OIDC Core 1.0 §11: an online refresh token stops working once its login session ends.
    it('should reject an online refresh token whose login session has ended with invalid_grant', async () => {
      const { c, stores } = await providerContext();
      await stores.refreshTokenStore.set('rt-1', storedRefreshToken({ sessionId: 'session-1' }));

      await expect(validateRefreshTokenGrant(c, paramsOf({}), CLIENT_ID, 'refresh_token')).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'The authentication session bound to this refresh token has ended',
      });
    });

    it('should reject an online refresh token whose session now belongs to another user with invalid_grant', async () => {
      const { c, stores } = await providerContext();
      await stores.browserSessionStore.set('session-1', { subject: 'user-2', authTime: AUTH_TIME });
      await stores.refreshTokenStore.set('rt-1', storedRefreshToken({ sessionId: 'session-1' }));

      await expect(validateRefreshTokenGrant(c, paramsOf({}), CLIENT_ID, 'refresh_token')).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'The authentication session bound to this refresh token belongs to another subject',
      });
    });

    // RFC 6749 §6: a scope not granted originally is invalid_scope.
    it('should reject a scope beyond the original grant with invalid_scope', async () => {
      const { c, stores } = await providerContext();
      await stores.refreshTokenStore.set('rt-1', storedRefreshToken());

      await expect(
        validateRefreshTokenGrant(c, paramsOf({ scope: 'openid email' }), CLIENT_ID, 'refresh_token'),
      ).rejects.toMatchObject({ error: 'invalid_scope', errorDescription: 'Requested scope exceeds original grant: email' });
    });
  });
});
