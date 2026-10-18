import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import {
  NOW,
  authorizationCodeRequest,
  refreshTokenRequest,
  storedRefreshToken,
} from '../../../../test-support/token.js';
import { revokeRotatedRefreshToken } from './revoke-rotated-refresh-token.js';

describe('revokeRotatedRefreshToken', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // OAuth 2.1 §4.3.1: the presented refresh token is marked used, not deleted, so its reuse is detected.
  it('should mark the presented refresh token used on the refresh_token grant', async () => {
    const { c, stores } = await providerContext();
    await stores.refreshTokenStore.set('rt-1', storedRefreshToken());

    await revokeRotatedRefreshToken(c, { grant_type: 'refresh_token', refresh_token: 'rt-1' }, refreshTokenRequest());

    expect(await stores.refreshTokenStore.get('rt-1')).toEqual(storedRefreshToken({ used: true }));
  });

  it('should leave the refresh tokens untouched on the authorization_code grant', async () => {
    const { c, stores } = await providerContext();
    await stores.refreshTokenStore.set('rt-1', storedRefreshToken());

    await revokeRotatedRefreshToken(
      c,
      { grant_type: 'authorization_code', code: 'code-1', refresh_token: 'rt-1' },
      authorizationCodeRequest(),
    );

    expect((await stores.refreshTokenStore.get('rt-1'))?.used).toBe(false);
  });

  it('should do nothing when the request presents no refresh_token', async () => {
    const { c } = await providerContext();

    await expect(
      revokeRotatedRefreshToken(c, { grant_type: 'refresh_token' }, refreshTokenRequest()),
    ).resolves.toBeUndefined();
  });

  // OAuth 2.1 §4.3.1: of two requests that rotate the same refresh token, only one succeeds.
  it('should reject with invalid_grant when another request already rotated the refresh token', async () => {
    const { c, stores } = await providerContext();
    await stores.refreshTokenStore.set('rt-1', storedRefreshToken({ used: true }));

    await expect(
      revokeRotatedRefreshToken(c, { grant_type: 'refresh_token', refresh_token: 'rt-1' }, refreshTokenRequest()),
    ).rejects.toMatchObject({ error: 'invalid_grant', errorDescription: 'Refresh token has already been used' });
  });
});
