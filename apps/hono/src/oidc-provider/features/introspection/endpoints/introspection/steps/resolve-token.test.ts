import { IntrospectionError } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { accessTokenInfo, refreshTokenInfo } from '../../../../../../test-support/feature-endpoints.js';
import { resolveIntrospectedToken } from './resolve-token.js';

describe('resolveIntrospectedToken', () => {
  describe('Lookup', () => {
    it('should resolve an access token from the access token store', async () => {
      const { c, stores } = await providerContext();
      const info = accessTokenInfo();
      await stores.accessTokenStore.set('at-1', info);

      expect(await resolveIntrospectedToken(c, { token: 'at-1' }, 'rs-1')).toEqual({
        tokenType: 'access_token',
        accessToken: info,
      });
    });

    it('should resolve a refresh token from the refresh token store', async () => {
      const { c, stores } = await providerContext();
      const info = refreshTokenInfo();
      await stores.refreshTokenStore.set('rt-1', info);

      expect(await resolveIntrospectedToken(c, { token: 'rt-1' }, 'rs-1')).toEqual({
        tokenType: 'refresh_token',
        refreshToken: info,
      });
    });

    // RFC 7662 §2.1: token_type_hint only orders the lookup.
    it('should look the refresh token up first when token_type_hint is refresh_token', async () => {
      const { c, stores } = await providerContext();
      const refreshToken = refreshTokenInfo();
      await stores.accessTokenStore.set('same-value', accessTokenInfo());
      await stores.refreshTokenStore.set('same-value', refreshToken);

      expect(
        await resolveIntrospectedToken(c, { token: 'same-value', token_type_hint: 'refresh_token' }, 'rs-1'),
      ).toEqual({ tokenType: 'refresh_token', refreshToken });
    });

    // RFC 7662 §2.1: a hint that misses still searches the other token type.
    it('should find an access token when token_type_hint names refresh_token', async () => {
      const { c, stores } = await providerContext();
      const info = accessTokenInfo();
      await stores.accessTokenStore.set('at-1', info);

      expect(await resolveIntrospectedToken(c, { token: 'at-1', token_type_hint: 'refresh_token' }, 'rs-1')).toEqual({
        tokenType: 'access_token',
        accessToken: info,
      });
    });

    it('should return null for a token no store holds', async () => {
      const { c } = await providerContext();

      expect(await resolveIntrospectedToken(c, { token: 'unknown' }, 'rs-1')).toBeNull();
    });
  });

  describe('Request Validation', () => {
    // RFC 7662 §2.1: token is REQUIRED.
    it('should reject a request without token with invalid_request', async () => {
      const { c } = await providerContext();

      const resolving = resolveIntrospectedToken(c, {}, 'rs-1');

      await expect(resolving).rejects.toBeInstanceOf(IntrospectionError);
      await expect(resolving).rejects.toMatchObject({
        error: 'invalid_request',
        errorDescription: 'Missing required parameter: token',
      });
    });

    it('should reject an unauthenticated caller with invalid_client', async () => {
      const { c } = await providerContext();

      await expect(resolveIntrospectedToken(c, { token: 'at-1' }, '')).rejects.toMatchObject({
        error: 'invalid_client',
        errorDescription: 'Client authentication required',
      });
    });
  });
});
