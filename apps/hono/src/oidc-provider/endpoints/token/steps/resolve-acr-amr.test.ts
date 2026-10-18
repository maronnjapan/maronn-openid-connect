import type { AcrResolver } from '@maronn-openid-connect/core';
import { describe, expect, it, vi } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { CLIENT_ID, SUBJECT, authorizationCodeRequest, refreshTokenRequest } from '../../../../test-support/token.js';
import { resolveTokenAcrAmr } from './resolve-acr-amr.js';

function mfaResolver() {
  return vi.fn<AcrResolver>(async () => ({ acr: 'urn:acr:mfa', amr: ['pwd', 'otp'] }));
}

describe('resolveTokenAcrAmr', () => {
  describe('authorization_code grant with an acrResolver', () => {
    // OIDC Core 1.0 §3.1.2.1: the acrResolver decides from the requested acr_values.
    it('should return the acr and amr of the acrResolver asked with the sub, client_id and acr_values', async () => {
      const acrResolver = mfaResolver();
      const c = contextOf(undefined, { acrResolver });

      await expect(
        resolveTokenAcrAmr(c, {
          subject: SUBJECT,
          validatedRequest: authorizationCodeRequest({ acrValues: 'urn:acr:mfa urn:acr:pwd' }),
        }),
      ).resolves.toEqual({ acr: 'urn:acr:mfa', amr: ['pwd', 'otp'] });
      expect(acrResolver.mock.calls).toEqual([
        [{ userId: SUBJECT, clientId: CLIENT_ID, requestedAcrValues: 'urn:acr:mfa urn:acr:pwd' }],
      ]);
    });

    // OIDC Core 1.0 §5.5.1.1: claims.id_token.acr.values is a request for those acr values.
    it('should ask the acrResolver for the claims.id_token.acr.values when acr_values is absent', async () => {
      const acrResolver = mfaResolver();
      const c = contextOf(undefined, { acrResolver });

      await resolveTokenAcrAmr(c, {
        subject: SUBJECT,
        validatedRequest: authorizationCodeRequest({
          claims: { id_token: { acr: { essential: true, values: ['urn:acr:a', 'urn:acr:b'] } } },
        }),
      });

      expect(acrResolver.mock.calls).toEqual([
        [{ userId: SUBJECT, clientId: CLIENT_ID, requestedAcrValues: 'urn:acr:a urn:acr:b' }],
      ]);
    });

    it('should return neither acr nor amr when the acrResolver returns undefined', async () => {
      const c = contextOf(undefined, { acrResolver: vi.fn<AcrResolver>(async () => undefined) });

      await expect(
        resolveTokenAcrAmr(c, { subject: SUBJECT, validatedRequest: authorizationCodeRequest({ acrValues: 'urn:acr:mfa' }) }),
      ).resolves.toEqual({ acr: undefined, amr: undefined });
    });
  });

  describe('authorization_code grant without an acrResolver', () => {
    // OIDC Core 1.0 §3.1.2.1: acr_values lists the values in order of preference.
    it('should return the most preferred requested acr value and no amr', async () => {
      const c = contextOf();

      await expect(
        resolveTokenAcrAmr(c, {
          subject: SUBJECT,
          validatedRequest: authorizationCodeRequest({ acrValues: 'urn:acr:mfa urn:acr:pwd' }),
        }),
      ).resolves.toEqual({ acr: 'urn:acr:mfa', amr: undefined });
    });

    it('should return neither acr nor amr when no acr was requested', async () => {
      const c = contextOf();

      await expect(
        resolveTokenAcrAmr(c, { subject: SUBJECT, validatedRequest: authorizationCodeRequest() }),
      ).resolves.toEqual({ acr: undefined, amr: undefined });
    });
  });

  describe('refresh_token grant', () => {
    // OIDC Core 1.0 §12.1: the acr / amr of the first authentication are kept.
    it('should keep the acr and amr of the refresh token without asking the acrResolver', async () => {
      const acrResolver = mfaResolver();
      const c = contextOf(undefined, { acrResolver });

      await expect(
        resolveTokenAcrAmr(c, {
          subject: SUBJECT,
          validatedRequest: refreshTokenRequest({ acr: 'urn:acr:pwd', amr: ['pwd'] }),
        }),
      ).resolves.toEqual({ acr: 'urn:acr:pwd', amr: ['pwd'] });
      expect(acrResolver).not.toHaveBeenCalled();
    });
  });
});
