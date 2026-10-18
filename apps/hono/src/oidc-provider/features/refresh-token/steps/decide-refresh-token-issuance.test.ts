import type { TokenClientInfo } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { CLIENT_ID, authorizationCodeRequest, refreshTokenRequest } from '../../../../test-support/token.js';
import { decideRefreshTokenIssuance } from './decide-refresh-token-issuance.js';

const refreshClient: TokenClientInfo = { clientId: CLIENT_ID, grantTypes: ['authorization_code', 'refresh_token'] };

describe('decideRefreshTokenIssuance', () => {
  describe('Client registration', () => {
    // RFC 7591 §2 / RFC 9700 §4.14: a client without the refresh_token grant could never use one.
    it('should issue no refresh token to a client not registered for the refresh_token grant', async () => {
      const { c } = await providerContext();

      expect(
        decideRefreshTokenIssuance(
          c,
          { clientId: CLIENT_ID, grantTypes: ['authorization_code'] },
          authorizationCodeRequest({ scope: ['openid', 'offline_access'] }),
        ),
      ).toEqual({ grantHasOfflineAccess: false, boundSessionId: 'session-1', issueRefreshToken: false });
    });
  });

  describe('authorization_code grant', () => {
    // OIDC Core 1.0 §11: an offline_access refresh token outlives the login session.
    it('should issue an offline refresh token bound to no session when offline_access was granted', async () => {
      const { c } = await providerContext();

      expect(
        decideRefreshTokenIssuance(c, refreshClient, authorizationCodeRequest({ scope: ['openid', 'offline_access'] })),
      ).toEqual({ grantHasOfflineAccess: true, boundSessionId: undefined, issueRefreshToken: true });
    });

    // OIDC Core 1.0 §11: "The Authorization Server MAY grant Refresh Tokens in other contexts".
    it('should issue an online refresh token bound to the login session of the code without offline_access', async () => {
      const { c } = await providerContext();

      expect(decideRefreshTokenIssuance(c, refreshClient, authorizationCodeRequest())).toEqual({
        grantHasOfflineAccess: false,
        boundSessionId: 'session-1',
        issueRefreshToken: true,
      });
    });

    it('should issue no online refresh token when the code has no login session to bind it to', async () => {
      const { c } = await providerContext();

      expect(decideRefreshTokenIssuance(c, refreshClient, authorizationCodeRequest({ sessionId: undefined }))).toEqual({
        grantHasOfflineAccess: false,
        boundSessionId: undefined,
        issueRefreshToken: false,
      });
    });

    it('should issue no online refresh token when onlineRefreshTokenEnabled is false', async () => {
      const { c } = await providerContext({ options: { config: { onlineRefreshTokenEnabled: false } } });

      expect(decideRefreshTokenIssuance(c, refreshClient, authorizationCodeRequest())).toEqual({
        grantHasOfflineAccess: false,
        boundSessionId: 'session-1',
        issueRefreshToken: false,
      });
    });
  });

  describe('refresh_token grant', () => {
    // RFC 6749 §6: narrowing the scope of one refresh does not take offline_access from the grant.
    it('should keep rotating an offline refresh token whose narrowed scope left out offline_access', async () => {
      const { c } = await providerContext();

      expect(
        decideRefreshTokenIssuance(c, refreshClient, refreshTokenRequest({ scope: ['openid'], hadOfflineAccess: true })),
      ).toEqual({ grantHasOfflineAccess: true, boundSessionId: undefined, issueRefreshToken: true });
    });

    it('should keep the session binding of a rotated online refresh token', async () => {
      const { c } = await providerContext();

      expect(
        decideRefreshTokenIssuance(
          c,
          refreshClient,
          refreshTokenRequest({ scope: ['openid'], hadOfflineAccess: false, sessionId: 'session-1' }),
        ),
      ).toEqual({ grantHasOfflineAccess: false, boundSessionId: 'session-1', issueRefreshToken: true });
    });
  });
});
