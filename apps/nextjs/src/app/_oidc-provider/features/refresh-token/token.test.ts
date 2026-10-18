import {
  TokenError,
  type TokenClientInfo,
  type ValidatedAuthorizationCodeRequest,
  type ValidatedRefreshTokenRequest,
} from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessTokenInfo, refreshTokenInfo } from '../../../../test-support/fixtures';
import { config, resolvers, stores } from '../../provider';
import {
  decideRefreshTokenIssuance,
  issueRefreshToken,
  revokeRotatedRefreshToken,
  validateRefreshTokenGrant,
  type RefreshTokenDecision,
} from './token';

// provider.ts keeps its stores in the key-value store of db/ (in memory for
// the tests, vitest.config.ts) for the whole file, so every test uses tokens,
// grants and sessions of its own.

/** 2026-01-01T00:00:00Z in Unix seconds: every test runs on this clock. */
const NOW = 1767225600;
const USERINFO = 'https://op.example.com/userinfo';
const defaultOnlineRefreshTokenEnabled = config.onlineRefreshTokenEnabled;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  config.onlineRefreshTokenEnabled = defaultOnlineRefreshTokenEnabled;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A client registered for the authorization_code and refresh_token grants. */
const refreshClient: TokenClientInfo = {
  clientId: 'client-1',
  grantTypes: ['authorization_code', 'refresh_token'],
  tokenEndpointAuthMethods: ['client_secret_basic'],
};

function codeRequest(overrides: Partial<ValidatedAuthorizationCodeRequest> = {}): ValidatedAuthorizationCodeRequest {
  return {
    grantType: 'authorization_code',
    clientId: 'client-1',
    code: 'code-1',
    grantId: 'grant-1',
    redirectUri: 'https://rp.example.com/callback',
    scope: ['openid'],
    codeVerified: true,
    ...overrides,
  };
}

function refreshRequest(overrides: Partial<ValidatedRefreshTokenRequest> = {}): ValidatedRefreshTokenRequest {
  return {
    grantType: 'refresh_token',
    clientId: 'client-1',
    subject: 'alice',
    scope: ['openid'],
    grantId: 'grant-1',
    authTime: NOW - 7200,
    originalIssuedAt: NOW - 3600,
    hadOfflineAccess: false,
    ...overrides,
  };
}

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

describe('validateRefreshTokenGrant', () => {
  it('should return undefined for another grant_type without reading a refresh token', async () => {
    const resolve = vi.spyOn(resolvers.refreshTokenResolver, 'resolve');

    const validated = await validateRefreshTokenGrant(
      { grant_type: 'authorization_code', code: 'code-1', refresh_token: 'rt-ignored' },
      'client-1',
      'authorization_code',
    );

    expect(validated).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  // OAuth 2.1 §4.3 / OIDC Core 1.0 §12.1: the validated request keeps what the
  // first authentication established, so the refreshed tokens carry the same values.
  it('should validate a stored refresh token into a refresh request of its grant', async () => {
    await stores.refreshTokenStore.set(
      'rt-valid',
      refreshTokenInfo({
        subject: 'alice',
        scope: ['openid', 'offline_access'],
        grantId: 'grant-valid',
        originalIssuedAt: NOW - 3600,
        authTime: NOW - 7200,
        audience: [USERINFO],
        nonce: 'nonce-1',
        acr: 'urn:acr:pwd',
        amr: ['pwd'],
      }),
    );

    const validated = await validateRefreshTokenGrant(
      { grant_type: 'refresh_token', refresh_token: 'rt-valid' },
      'client-1',
      'refresh_token',
    );

    expect(validated).toEqual({
      grantType: 'refresh_token',
      clientId: 'client-1',
      subject: 'alice',
      scope: ['openid', 'offline_access'],
      grantId: 'grant-valid',
      audience: [USERINFO],
      authTime: NOW - 7200,
      nonce: 'nonce-1',
      acr: 'urn:acr:pwd',
      amr: ['pwd'],
      originalIssuedAt: NOW - 3600,
      hadOfflineAccess: true,
    });
  });

  // RFC 6749 §6: the requested scope may only narrow the grant; offline_access
  // of the grant is still remembered for the rotation.
  it('should narrow the scope to the requested one and remember that the grant had offline_access', async () => {
    await stores.refreshTokenStore.set(
      'rt-narrowed',
      refreshTokenInfo({ scope: ['openid', 'profile', 'offline_access'], grantId: 'grant-narrowed' }),
    );

    const validated = await validateRefreshTokenGrant(
      { grant_type: 'refresh_token', refresh_token: 'rt-narrowed', scope: 'openid' },
      'client-1',
      'refresh_token',
    );

    expect(validated).toMatchObject({ scope: ['openid'], hadOfflineAccess: true });
  });

  // RFC 6749 §5.2: a refresh token that is not valid is invalid_grant.
  it('should reject a refresh token the OP does not know with invalid_grant', async () => {
    const error = await rejectionOf(
      validateRefreshTokenGrant({ grant_type: 'refresh_token', refresh_token: 'rt-unknown' }, 'client-1', 'refresh_token'),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({ error: 'invalid_grant', errorDescription: 'Refresh token not found' });
  });

  // RFC 6749 §6: a refresh token is bound to the client it was issued to.
  it('should reject a refresh token issued to another client with invalid_grant', async () => {
    await stores.refreshTokenStore.set('rt-other-client', refreshTokenInfo({ grantId: 'grant-other-client' }));

    await expect(
      validateRefreshTokenGrant({ grant_type: 'refresh_token', refresh_token: 'rt-other-client' }, 'client-2', 'refresh_token'),
    ).rejects.toMatchObject({ error: 'invalid_grant', errorDescription: 'Refresh token was issued to a different client' });
  });

  // OAuth 2.1 §4.3.1: a rotated refresh token presented again revokes the tokens of its grant.
  it('should reject a rotated refresh token with invalid_grant and revoke the tokens of its grant', async () => {
    await stores.accessTokenStore.set('at-replayed-grant', accessTokenInfo({ grantId: 'grant-replayed' }));
    await stores.refreshTokenStore.set('rt-replayed', refreshTokenInfo({ grantId: 'grant-replayed', used: true }));

    const error = await rejectionOf(
      validateRefreshTokenGrant({ grant_type: 'refresh_token', refresh_token: 'rt-replayed' }, 'client-1', 'refresh_token'),
    );

    expect(error).toMatchObject({ error: 'invalid_grant', errorDescription: 'Refresh token has already been used' });
    expect(await stores.accessTokenStore.get('at-replayed-grant')).toBeUndefined();
    expect(await stores.refreshTokenStore.get('rt-replayed')).toBeUndefined();
  });

  // OAuth 2.1 §6.1: the absolute lifetime ends the refresh token.
  it('should reject a refresh token past its absolute lifetime with invalid_grant', async () => {
    await stores.refreshTokenStore.set('rt-expiring', refreshTokenInfo({ grantId: 'grant-expiring', expiresAt: NOW + 10 }));
    vi.setSystemTime((NOW + 10) * 1000);

    await expect(
      validateRefreshTokenGrant({ grant_type: 'refresh_token', refresh_token: 'rt-expiring' }, 'client-1', 'refresh_token'),
    ).rejects.toMatchObject({ error: 'invalid_grant', errorDescription: 'Refresh token not found' });
  });

  // OIDC Core 1.0 §11: an online refresh token lives as long as its login session.
  describe('Online Refresh Tokens', () => {
    it('should keep the session an online refresh token is bound to while the session lives', async () => {
      await stores.browserSessionStore.set('sid-live', { subject: 'user-1', authTime: NOW - 7200 });
      await stores.refreshTokenStore.set('rt-online', refreshTokenInfo({ grantId: 'grant-online', sessionId: 'sid-live' }));

      const validated = await validateRefreshTokenGrant(
        { grant_type: 'refresh_token', refresh_token: 'rt-online' },
        'client-1',
        'refresh_token',
      );

      expect(validated).toMatchObject({ sessionId: 'sid-live', hadOfflineAccess: false });
    });

    it('should reject an online refresh token whose session has ended with invalid_grant', async () => {
      await stores.refreshTokenStore.set('rt-logged-out', refreshTokenInfo({ grantId: 'grant-logged-out', sessionId: 'sid-ended' }));

      await expect(
        validateRefreshTokenGrant({ grant_type: 'refresh_token', refresh_token: 'rt-logged-out' }, 'client-1', 'refresh_token'),
      ).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'The authentication session bound to this refresh token has ended',
      });
    });
  });
});

// OIDC Core 1.0 §11 / RFC 9700 §4.14.
describe('decideRefreshTokenIssuance', () => {
  describe('Authorization Code Grant', () => {
    it('should issue an offline refresh token bound to no session when the granted scope has offline_access', () => {
      const decision = decideRefreshTokenIssuance(
        refreshClient,
        codeRequest({ scope: ['openid', 'offline_access'], sessionId: 'sid-1' }),
      );

      expect(decision).toEqual({ grantHasOfflineAccess: true, boundSessionId: undefined, issueRefreshToken: true });
    });

    it('should issue an online refresh token bound to the login session without offline_access', () => {
      const decision = decideRefreshTokenIssuance(refreshClient, codeRequest({ scope: ['openid'], sessionId: 'sid-1' }));

      expect(decision).toEqual({ grantHasOfflineAccess: false, boundSessionId: 'sid-1', issueRefreshToken: true });
    });

    // Fail closed: an online refresh token needs a session that logging out ends.
    it('should issue no refresh token without offline_access when there is no login session to bind it to', () => {
      const decision = decideRefreshTokenIssuance(refreshClient, codeRequest({ scope: ['openid'] }));

      expect(decision).toEqual({ grantHasOfflineAccess: false, boundSessionId: undefined, issueRefreshToken: false });
    });

    it('should issue no online refresh token while onlineRefreshTokenEnabled is off', () => {
      config.onlineRefreshTokenEnabled = false;

      const decision = decideRefreshTokenIssuance(refreshClient, codeRequest({ scope: ['openid'], sessionId: 'sid-1' }));

      expect(decision).toEqual({ grantHasOfflineAccess: false, boundSessionId: 'sid-1', issueRefreshToken: false });
    });

    it('should still issue an offline refresh token while onlineRefreshTokenEnabled is off', () => {
      config.onlineRefreshTokenEnabled = false;

      const decision = decideRefreshTokenIssuance(refreshClient, codeRequest({ scope: ['openid', 'offline_access'] }));

      expect(decision).toEqual({ grantHasOfflineAccess: true, boundSessionId: undefined, issueRefreshToken: true });
    });
  });

  // RFC 7591 §2: grant_types defaults to ["authorization_code"], and a refresh
  // token the client may never use is not handed out (RFC 9700 §4.14).
  describe('Clients Without the refresh_token Grant', () => {
    it('should issue no refresh token to a client that did not register the refresh_token grant', () => {
      const client: TokenClientInfo = { ...refreshClient, grantTypes: ['authorization_code'] };

      const decision = decideRefreshTokenIssuance(
        client,
        codeRequest({ scope: ['openid', 'offline_access'], sessionId: 'sid-1' }),
      );

      expect(decision).toEqual({ grantHasOfflineAccess: false, boundSessionId: 'sid-1', issueRefreshToken: false });
    });

    it('should issue no refresh token to a client that registered no grant_types', () => {
      const client: TokenClientInfo = { clientId: 'client-1', tokenEndpointAuthMethods: ['client_secret_basic'] };

      const decision = decideRefreshTokenIssuance(client, codeRequest({ scope: ['openid', 'offline_access'] }));

      expect(decision).toEqual({ grantHasOfflineAccess: false, boundSessionId: undefined, issueRefreshToken: false });
    });
  });

  describe('Refresh Token Grant', () => {
    // RFC 6749 §6: offline_access dropped from the narrowed scope stays with the grant.
    it('should keep rotating an offline refresh token whose request narrowed offline_access away', () => {
      const decision = decideRefreshTokenIssuance(refreshClient, refreshRequest({ scope: ['openid'], hadOfflineAccess: true }));

      expect(decision).toEqual({ grantHasOfflineAccess: true, boundSessionId: undefined, issueRefreshToken: true });
    });

    it('should keep an online refresh token bound to the session of the token it rotates', () => {
      const decision = decideRefreshTokenIssuance(refreshClient, refreshRequest({ sessionId: 'sid-1' }));

      expect(decision).toEqual({ grantHasOfflineAccess: false, boundSessionId: 'sid-1', issueRefreshToken: true });
    });

    it('should not take offline_access from the narrowed scope when the grant did not have it', () => {
      const decision = decideRefreshTokenIssuance(
        refreshClient,
        refreshRequest({ scope: ['openid', 'offline_access'], hadOfflineAccess: false }),
      );

      expect(decision).toEqual({ grantHasOfflineAccess: false, boundSessionId: undefined, issueRefreshToken: false });
    });
  });
});

describe('issueRefreshToken', () => {
  const offline: RefreshTokenDecision = { grantHasOfflineAccess: true, boundSessionId: undefined, issueRefreshToken: true };

  function issueInput(overrides: Partial<Parameters<typeof issueRefreshToken>[0]> = {}) {
    return {
      decision: offline,
      subject: 'alice',
      authTime: NOW - 60,
      nonce: 'nonce-1',
      validatedRequest: codeRequest({ scope: ['openid', 'offline_access'] }),
      issuedAt: NOW,
      audience: [USERINFO],
      acr: 'urn:acr:pwd',
      amr: ['pwd'],
      ...overrides,
    };
  }

  it('should return undefined when the decision issues no refresh token', async () => {
    const decision: RefreshTokenDecision = { grantHasOfflineAccess: false, boundSessionId: undefined, issueRefreshToken: false };

    expect(await issueRefreshToken(issueInput({ decision }))).toBeUndefined();
  });

  it('should reject an issuance without authTime with invalid_grant', async () => {
    const error = await rejectionOf(issueRefreshToken(issueInput({ authTime: undefined })));

    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      error: 'invalid_grant',
      errorDescription: 'authTime is required to issue a refresh token',
    });
  });

  // OAuth 2.1 §6.1: the absolute lifetime (90 days) counts from the first issuance.
  it('should store an unused refresh token of the grant that expires the absolute lifetime after this issuance', async () => {
    const token = await issueRefreshToken(
      issueInput({ validatedRequest: codeRequest({ scope: ['openid', 'offline_access'], grantId: 'grant-issued' }) }),
    );

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await stores.refreshTokenStore.get(token ?? '')).toEqual({
      subject: 'alice',
      clientId: 'client-1',
      scope: ['openid', 'offline_access'],
      expiresAt: NOW + 7_776_000,
      originalIssuedAt: NOW,
      used: false,
      grantId: 'grant-issued',
      iat: NOW,
      issuer: 'https://op.example.com',
      audience: [USERINFO],
      authTime: NOW - 60,
      nonce: 'nonce-1',
      acr: 'urn:acr:pwd',
      amr: ['pwd'],
    });
  });

  // OAuth 2.1 §6.1: a rotation never moves the expiry forward. OIDC Core 1.0
  // §12.1: azp and the binding of an online token carry over.
  it('should keep the first issuance time, the azp and the session of the refresh token it rotates', async () => {
    const decision: RefreshTokenDecision = { grantHasOfflineAccess: false, boundSessionId: 'sid-1', issueRefreshToken: true };

    const token = await issueRefreshToken(
      issueInput({
        decision,
        validatedRequest: refreshRequest({ grantId: 'grant-rotated', originalIssuedAt: NOW - 3600, azp: 'client-1' }),
      }),
    );

    expect(await stores.refreshTokenStore.get(token ?? '')).toMatchObject({
      scope: ['openid'],
      expiresAt: NOW - 3600 + 7_776_000,
      originalIssuedAt: NOW - 3600,
      iat: NOW,
      grantId: 'grant-rotated',
      azp: 'client-1',
      sessionId: 'sid-1',
    });
  });

  // RFC 6749 §6: the access token gets the narrowed scope, but the grant keeps
  // offline_access so the next rotation still happens.
  it('should keep offline_access in the stored scope when the request narrowed it away', async () => {
    const token = await issueRefreshToken(
      issueInput({ validatedRequest: refreshRequest({ grantId: 'grant-kept', scope: ['openid'], hadOfflineAccess: true }) }),
    );

    expect((await stores.refreshTokenStore.get(token ?? ''))?.scope).toEqual(['openid', 'offline_access']);
  });

  it('should not add offline_access to the scope of an online refresh token', async () => {
    const decision: RefreshTokenDecision = { grantHasOfflineAccess: false, boundSessionId: 'sid-1', issueRefreshToken: true };

    const token = await issueRefreshToken(
      issueInput({ decision, validatedRequest: codeRequest({ grantId: 'grant-online-issued', scope: ['openid', 'profile'] }) }),
    );

    expect((await stores.refreshTokenStore.get(token ?? ''))?.scope).toEqual(['openid', 'profile']);
  });
});

// OAuth 2.1 §4.3.1: the rotated refresh token is revoked once the new one is stored.
describe('revokeRotatedRefreshToken', () => {
  it('should mark the presented refresh token used after a refresh', async () => {
    await stores.refreshTokenStore.set('rt-rotated', refreshTokenInfo({ grantId: 'grant-revoke' }));

    await revokeRotatedRefreshToken({ grant_type: 'refresh_token', refresh_token: 'rt-rotated' }, refreshRequest());

    expect(await stores.refreshTokenStore.get('rt-rotated')).toMatchObject({ grantId: 'grant-revoke', used: true });
  });

  it('should revoke nothing after an authorization code grant', async () => {
    const revoke = vi.spyOn(resolvers.refreshTokenResolver, 'revokeRefreshToken');
    await stores.refreshTokenStore.set('rt-untouched', refreshTokenInfo({ grantId: 'grant-untouched' }));

    await revokeRotatedRefreshToken({ grant_type: 'authorization_code', refresh_token: 'rt-untouched' }, codeRequest());

    expect(revoke).not.toHaveBeenCalled();
    expect(await stores.refreshTokenStore.get('rt-untouched')).toMatchObject({ used: false });
  });

  // OAuth 2.1 §4.3.1: of two refreshes with the same token, only one rotates it.
  it('should reject a second rotation of the same refresh token with invalid_grant', async () => {
    await stores.refreshTokenStore.set('rt-raced', refreshTokenInfo({ grantId: 'grant-raced' }));
    await revokeRotatedRefreshToken({ grant_type: 'refresh_token', refresh_token: 'rt-raced' }, refreshRequest());

    await expect(
      revokeRotatedRefreshToken({ grant_type: 'refresh_token', refresh_token: 'rt-raced' }, refreshRequest()),
    ).rejects.toMatchObject({ error: 'invalid_grant', errorDescription: 'Refresh token has already been used' });
  });
});
