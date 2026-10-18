import type { TokenRequestParams } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import {
  CLIENT_ID,
  NOW,
  REDIRECT_URI,
  SUBJECT,
  authorizationCodeRequest,
  storedAuthorizationCode,
  storedRefreshToken,
} from '../../../../test-support/token.js';
import { validateAuthorizationCodeGrant } from './validate-authorization-code-grant.js';

// RFC 7636 §4.1 / §4.2: a 46-character verifier and its S256 challenge.
const CODE_VERIFIER = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const CODE_CHALLENGE = 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU';

function paramsOf(fields: Partial<TokenRequestParams>): TokenRequestParams {
  return { grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT_URI, ...fields };
}

describe('validateAuthorizationCodeGrant', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Valid codes', () => {
    it('should return the validated request built from the stored code and mark the code used', async () => {
      const { c, stores } = await providerContext();
      await stores.authCodeStore.set('code-1', storedAuthorizationCode());

      await expect(validateAuthorizationCodeGrant(c, paramsOf({}), CLIENT_ID)).resolves.toEqual(
        authorizationCodeRequest(),
      );
      // OAuth 2.1 §4.1.2: the code is marked used, not deleted, so a replay is detected.
      expect((await stores.authCodeStore.get('code-1'))?.used).toBe(true);
    });

    // RFC 7636 §4.6: the S256 verifier matches the stored challenge.
    it('should report codeVerified true when the code_verifier matches the S256 code_challenge', async () => {
      const { c, stores } = await providerContext();
      await stores.authCodeStore.set(
        'code-1',
        storedAuthorizationCode({ codeChallenge: CODE_CHALLENGE, codeChallengeMethod: 'S256' }),
      );

      await expect(
        validateAuthorizationCodeGrant(c, paramsOf({ code_verifier: CODE_VERIFIER }), CLIENT_ID),
      ).resolves.toEqual(authorizationCodeRequest({ codeVerified: true }));
    });
  });

  describe('Rejected codes', () => {
    // RFC 6749 §4.1.3: code is REQUIRED.
    it('should reject a request without code with invalid_request', async () => {
      const { c } = await providerContext();

      await expect(validateAuthorizationCodeGrant(c, paramsOf({ code: undefined }), CLIENT_ID)).rejects.toMatchObject({
        error: 'invalid_request',
        errorDescription: 'Missing required parameter: code',
      });
    });

    // RFC 6749 §5.2: invalid_grant.
    it('should reject a code the store does not hold with invalid_grant', async () => {
      const { c } = await providerContext();

      await expect(validateAuthorizationCodeGrant(c, paramsOf({}), CLIENT_ID)).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'Authorization code not found',
      });
    });

    // OIDC Core 1.0 §3.1.3.1: the code is short-lived; the store no longer returns it after expiresAt.
    it('should reject an expired code with invalid_grant', async () => {
      const { c, stores } = await providerContext();
      await stores.authCodeStore.set('code-1', storedAuthorizationCode({ expiresAt: NOW }));

      await expect(validateAuthorizationCodeGrant(c, paramsOf({}), CLIENT_ID)).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'Authorization code not found',
      });
    });

    // OAuth 2.1 §4.1.2: a reused code is rejected and the tokens issued from it are revoked.
    it('should reject a used code with invalid_grant and revoke the tokens of its grant only', async () => {
      const { c, stores } = await providerContext();
      await stores.authCodeStore.set('code-1', storedAuthorizationCode({ used: true }));
      const accessToken = { sub: SUBJECT, scope: ['openid'], clientId: CLIENT_ID, expiresAt: NOW + 3600 };
      await stores.accessTokenStore.set('at-grant-1', { ...accessToken, grantId: 'grant-1' });
      await stores.accessTokenStore.set('at-grant-2', { ...accessToken, grantId: 'grant-2' });
      await stores.refreshTokenStore.set('rt-grant-1', storedRefreshToken({ grantId: 'grant-1' }));

      await expect(validateAuthorizationCodeGrant(c, paramsOf({}), CLIENT_ID)).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'Authorization code has already been used',
      });
      expect(await stores.accessTokenStore.get('at-grant-1')).toBeUndefined();
      expect(await stores.refreshTokenStore.get('rt-grant-1')).toBeUndefined();
      expect((await stores.accessTokenStore.get('at-grant-2'))?.grantId).toBe('grant-2');
    });

    // RFC 6749 §4.1.3: the code must have been issued to the authenticated client.
    it('should reject a code issued to another client with invalid_grant', async () => {
      const { c, stores } = await providerContext();
      await stores.authCodeStore.set('code-1', storedAuthorizationCode());

      await expect(validateAuthorizationCodeGrant(c, paramsOf({}), 'client-2')).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'Authorization code was issued to a different client',
      });
    });

    // OIDC Core 1.0 §3.1.3.2: redirect_uri must be identical to the one of the authorization request.
    it('should reject a redirect_uri that differs from the authorized one with invalid_grant', async () => {
      const { c, stores } = await providerContext();
      await stores.authCodeStore.set('code-1', storedAuthorizationCode());

      await expect(
        validateAuthorizationCodeGrant(c, paramsOf({ redirect_uri: 'https://rp.example.com/other' }), CLIENT_ID),
      ).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'redirect_uri does not match the authorization request',
      });
    });

    // OIDC Core 1.0 §3.1.3.2: redirect_uri is required when the authorization request included it.
    it('should reject a missing redirect_uri with invalid_grant when the authorization request included one', async () => {
      const { c, stores } = await providerContext();
      await stores.authCodeStore.set('code-1', storedAuthorizationCode({ redirectUriExplicit: true }));

      await expect(
        validateAuthorizationCodeGrant(c, paramsOf({ redirect_uri: undefined }), CLIENT_ID),
      ).rejects.toMatchObject({
        error: 'invalid_grant',
        errorDescription: 'redirect_uri is required because it was included in the authorization request',
      });
    });

    // RFC 7636 §4.6: a verifier that does not hash to the challenge.
    it('should reject a code_verifier that does not match the code_challenge with invalid_grant', async () => {
      const { c, stores } = await providerContext();
      await stores.authCodeStore.set(
        'code-1',
        storedAuthorizationCode({ codeChallenge: CODE_CHALLENGE, codeChallengeMethod: 'S256' }),
      );

      await expect(
        validateAuthorizationCodeGrant(c, paramsOf({ code_verifier: `${CODE_VERIFIER}-x` }), CLIENT_ID),
      ).rejects.toMatchObject({ error: 'invalid_grant', errorDescription: 'code_verifier validation failed' });
    });
  });
});
