import { RevocationError } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { accessTokenInfo, refreshTokenInfo } from '../../../../../../test-support/feature-endpoints.js';
import { resolveRevocationTokenTarget } from './resolve-token.js';

describe('resolveRevocationTokenTarget', () => {
  describe('Lookup', () => {
    it('should resolve an access token from the access token store', async () => {
      const { c, stores } = await providerContext();
      const info = accessTokenInfo();
      await stores.accessTokenStore.set('at-1', info);

      expect(await resolveRevocationTokenTarget(c, { token: 'at-1' }, 'client-1')).toEqual({
        token: 'at-1',
        resolved: { tokenType: 'access_token', accessToken: info },
      });
    });

    it('should resolve a refresh token from the refresh token store', async () => {
      const { c, stores } = await providerContext();
      const info = refreshTokenInfo();
      await stores.refreshTokenStore.set('rt-1', info);

      expect(await resolveRevocationTokenTarget(c, { token: 'rt-1' }, 'client-1')).toEqual({
        token: 'rt-1',
        resolved: { tokenType: 'refresh_token', refreshToken: info },
      });
    });

    // RFC 7009 §2.1: token_type_hint only orders the lookup.
    it('should look the refresh token up first when token_type_hint is refresh_token', async () => {
      const { c, stores } = await providerContext();
      const refreshToken = refreshTokenInfo();
      await stores.accessTokenStore.set('same-value', accessTokenInfo());
      await stores.refreshTokenStore.set('same-value', refreshToken);

      expect(
        await resolveRevocationTokenTarget(c, { token: 'same-value', token_type_hint: 'refresh_token' }, 'client-1'),
      ).toEqual({ token: 'same-value', resolved: { tokenType: 'refresh_token', refreshToken } });
    });

    it('should look the access token up first without token_type_hint', async () => {
      const { c, stores } = await providerContext();
      const accessToken = accessTokenInfo();
      await stores.accessTokenStore.set('same-value', accessToken);
      await stores.refreshTokenStore.set('same-value', refreshTokenInfo());

      expect(await resolveRevocationTokenTarget(c, { token: 'same-value' }, 'client-1')).toEqual({
        token: 'same-value',
        resolved: { tokenType: 'access_token', accessToken },
      });
    });

    // RFC 7009 §2.2: an unknown token is not an error.
    it('should resolve an unknown token to null', async () => {
      const { c } = await providerContext();

      expect(await resolveRevocationTokenTarget(c, { token: 'unknown' }, 'client-1')).toEqual({
        token: 'unknown',
        resolved: null,
      });
    });
  });

  describe('Request Validation', () => {
    // RFC 7009 §2.1: token is REQUIRED.
    it('should reject a request without token with invalid_request', async () => {
      const { c } = await providerContext();

      const resolving = resolveRevocationTokenTarget(c, {}, 'client-1');

      await expect(resolving).rejects.toBeInstanceOf(RevocationError);
      await expect(resolving).rejects.toMatchObject({
        error: 'invalid_request',
        errorDescription: 'Missing required parameter: token',
      });
    });

    it('should reject an unidentified caller with invalid_client', async () => {
      const { c } = await providerContext();

      await expect(resolveRevocationTokenTarget(c, { token: 'at-1' }, '')).rejects.toMatchObject({
        error: 'invalid_client',
        errorDescription: 'Client authentication required',
      });
    });
  });
});
