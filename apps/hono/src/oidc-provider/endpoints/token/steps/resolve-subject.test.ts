import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import {
  AUTH_TIME,
  NOW,
  SUBJECT,
  authorizationCodeRequest,
  refreshTokenRequest,
  storedAuthorizationCode,
} from '../../../../test-support/token.js';
import { resolveTokenSubject } from './resolve-subject.js';

describe('resolveTokenSubject', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('authorization_code grant', () => {
    it('should resolve sub and auth_time from the stored code and the nonce from the validated request', async () => {
      const { c, stores } = await providerContext();
      await stores.authCodeStore.set('code-1', storedAuthorizationCode({ used: true }));

      await expect(
        resolveTokenSubject(c, authorizationCodeRequest({ nonce: 'nonce-of-request' })),
      ).resolves.toEqual({ subject: SUBJECT, authTime: AUTH_TIME, nonce: 'nonce-of-request' });
    });

    // OIDC Core 1.0 §2: auth_time is needed for the ID Token; a code without it cannot be redeemed.
    it('should reject a stored code without auth_time with invalid_grant', async () => {
      const { c, stores } = await providerContext();
      await stores.authCodeStore.set('code-1', storedAuthorizationCode({ authTime: undefined }));

      await expect(resolveTokenSubject(c, authorizationCodeRequest())).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'Authorization code missing required subject context',
      });
    });

    it('should reject with invalid_grant when the store no longer holds the code', async () => {
      const { c } = await providerContext();

      await expect(resolveTokenSubject(c, authorizationCodeRequest())).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'Authorization code missing required subject context',
      });
    });
  });

  describe('refresh_token grant', () => {
    // OIDC Core 1.0 §12.1 / §12.2: sub and auth_time are kept, nonce is not re-issued.
    it('should return the sub and auth_time of the refresh token grant without the nonce', async () => {
      const { c } = await providerContext();

      await expect(
        resolveTokenSubject(c, refreshTokenRequest({ subject: 'user-2', authTime: AUTH_TIME - 60, nonce: 'nonce-1' })),
      ).resolves.toEqual({ subject: 'user-2', authTime: AUTH_TIME - 60, nonce: undefined });
    });
  });
});
