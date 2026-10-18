import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, providerContext } from '../../../../test-support/context.js';
import {
  AUTH_TIME,
  CLIENT_ID,
  NOW,
  SUBJECT,
  authorizationCodeRequest,
  refreshTokenRequest,
} from '../../../../test-support/token.js';
import type { RefreshTokenDecision } from './decide-refresh-token-issuance.js';
import { issueRefreshToken } from './issue-refresh-token.js';

const AUDIENCE = [`${TEST_ISSUER}/userinfo`];
const offline: RefreshTokenDecision = { grantHasOfflineAccess: true, boundSessionId: undefined, issueRefreshToken: true };

describe('issueRefreshToken', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should issue and store nothing when the decision is not to issue a refresh token', async () => {
    const { c, db } = await providerContext();

    await expect(
      issueRefreshToken(c, {
        decision: { grantHasOfflineAccess: false, boundSessionId: undefined, issueRefreshToken: false },
        subject: SUBJECT,
        authTime: AUTH_TIME,
        nonce: 'nonce-1',
        validatedRequest: authorizationCodeRequest(),
        issuedAt: NOW,
        audience: AUDIENCE,
        acr: undefined,
        amr: undefined,
      }),
    ).resolves.toBeUndefined();
    expect(db.refreshTokens.size).toBe(0);
  });

  describe('authorization_code grant', () => {
    // OAuth 2.1 §6.1: the absolute lifetime counts from this first issuance.
    it('should store a refresh token whose absolute lifetime starts at this issuance', async () => {
      const { c, stores } = await providerContext({ options: { config: { refreshTokenAbsoluteLifetime: 86400 } } });

      const refreshToken = await issueRefreshToken(c, {
        decision: offline,
        subject: SUBJECT,
        authTime: AUTH_TIME,
        nonce: 'nonce-1',
        validatedRequest: authorizationCodeRequest({ scope: ['openid', 'offline_access'] }),
        issuedAt: NOW,
        audience: AUDIENCE,
        acr: 'urn:acr:mfa',
        amr: ['pwd', 'otp'],
      });

      // 32 random bytes, base64url without padding.
      expect(refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await stores.refreshTokenStore.get(refreshToken ?? '')).toEqual({
        subject: SUBJECT,
        clientId: CLIENT_ID,
        scope: ['openid', 'offline_access'],
        expiresAt: NOW + 86400,
        originalIssuedAt: NOW,
        used: false,
        grantId: 'grant-1',
        iat: NOW,
        issuer: TEST_ISSUER,
        audience: AUDIENCE,
        authTime: AUTH_TIME,
        nonce: 'nonce-1',
        acr: 'urn:acr:mfa',
        amr: ['pwd', 'otp'],
      });
    });

    // OIDC Core 1.0 §11: an online refresh token is bound to the login session.
    it('should store the login session the decision binds an online refresh token to', async () => {
      const { c, stores } = await providerContext();

      const refreshToken = await issueRefreshToken(c, {
        decision: { grantHasOfflineAccess: false, boundSessionId: 'session-1', issueRefreshToken: true },
        subject: SUBJECT,
        authTime: AUTH_TIME,
        nonce: undefined,
        validatedRequest: authorizationCodeRequest(),
        issuedAt: NOW,
        audience: AUDIENCE,
        acr: undefined,
        amr: undefined,
      });

      expect(await stores.refreshTokenStore.get(refreshToken ?? '')).toMatchObject({
        scope: ['openid', 'profile'],
        sessionId: 'session-1',
      });
    });

    it('should reject with invalid_grant when the authentication has no auth_time', async () => {
      const { c, db } = await providerContext();

      await expect(
        issueRefreshToken(c, {
          decision: offline,
          subject: SUBJECT,
          authTime: undefined,
          nonce: undefined,
          validatedRequest: authorizationCodeRequest(),
          issuedAt: NOW,
          audience: AUDIENCE,
          acr: undefined,
          amr: undefined,
        }),
      ).rejects.toMatchObject({ error: 'invalid_grant', errorDescription: 'authTime is required to issue a refresh token' });
      expect(db.refreshTokens.size).toBe(0);
    });
  });

  describe('refresh_token grant', () => {
    // OAuth 2.1 §6.1 / OIDC Core 1.0 §12.1: rotation keeps the first issuance and the first authentication.
    it('should carry the originalIssuedAt, acr, amr and azp of the presented refresh token', async () => {
      const { c, stores } = await providerContext({ options: { config: { refreshTokenAbsoluteLifetime: 86400 } } });

      const refreshToken = await issueRefreshToken(c, {
        decision: offline,
        subject: SUBJECT,
        authTime: AUTH_TIME,
        nonce: undefined,
        validatedRequest: refreshTokenRequest({
          originalIssuedAt: NOW - 3600,
          acr: 'urn:acr:pwd',
          amr: ['pwd'],
          azp: CLIENT_ID,
        }),
        issuedAt: NOW,
        audience: AUDIENCE,
        acr: 'urn:acr:other',
        amr: ['other'],
      });

      expect(await stores.refreshTokenStore.get(refreshToken ?? '')).toEqual({
        subject: SUBJECT,
        clientId: CLIENT_ID,
        scope: ['openid', 'profile', 'offline_access'],
        expiresAt: NOW - 3600 + 86400,
        originalIssuedAt: NOW - 3600,
        used: false,
        grantId: 'grant-1',
        iat: NOW,
        issuer: TEST_ISSUER,
        audience: AUDIENCE,
        authTime: AUTH_TIME,
        acr: 'urn:acr:pwd',
        amr: ['pwd'],
        azp: CLIENT_ID,
      });
    });

    // RFC 6749 §6: the narrowed scope of one refresh does not take offline_access from the grant.
    it('should keep offline_access in the stored scope when the narrowed request scope left it out', async () => {
      const { c, stores } = await providerContext();

      const refreshToken = await issueRefreshToken(c, {
        decision: offline,
        subject: SUBJECT,
        authTime: AUTH_TIME,
        nonce: undefined,
        validatedRequest: refreshTokenRequest({ scope: ['openid'] }),
        issuedAt: NOW,
        audience: AUDIENCE,
        acr: undefined,
        amr: undefined,
      });

      expect((await stores.refreshTokenStore.get(refreshToken ?? ''))?.scope).toEqual(['openid', 'offline_access']);
    });
  });
});
