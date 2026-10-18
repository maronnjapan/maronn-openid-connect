import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, providerContext } from '../../../../test-support/context.js';
import {
  CLIENT_ID,
  NOW,
  SUBJECT,
  authorizationCodeRequest,
  decodeJwt,
  refreshTokenRequest,
  verifiesWith,
} from '../../../../test-support/token.js';
import { issueAccessToken } from './issue-access-token.js';

const USERINFO_ENDPOINT = `${TEST_ISSUER}/userinfo`;

describe('issueAccessToken', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('JWT format', () => {
    // RFC 9068 §2.1: typ is at+jwt, signed with the key the JWKS publishes.
    it('should sign an at+jwt access token with the signing key and its kid', async () => {
      const { c, signingKey } = await providerContext();

      const { accessToken } = await issueAccessToken(c, {
        signingKey,
        subject: SUBJECT,
        validatedRequest: authorizationCodeRequest(),
        issuedAt: NOW,
        acr: undefined,
      });

      expect(decodeJwt(accessToken).header).toEqual({ alg: 'RS256', typ: 'at+jwt', kid: 'test-rs256-key' });
      expect(await verifiesWith(accessToken, signingKey)).toBe(true);
    });

    // RFC 9068 §2.2 / §2.2.1: iss, sub, aud, exp, iat, jti, scope, client_id and acr.
    it('should put the claims of RFC 9068 and the acr into the payload it signs and returns', async () => {
      const { c, signingKey } = await providerContext({ options: { config: { accessTokenExpiresIn: 600 } } });

      const { accessToken, accessTokenPayload } = await issueAccessToken(c, {
        signingKey,
        subject: SUBJECT,
        validatedRequest: authorizationCodeRequest({ scope: ['openid', 'profile'] }),
        issuedAt: NOW,
        acr: 'urn:acr:mfa',
      });

      expect(accessTokenPayload.jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(decodeJwt(accessToken).payload).toEqual({
        iss: TEST_ISSUER,
        sub: SUBJECT,
        aud: [USERINFO_ENDPOINT],
        exp: NOW + 600,
        iat: NOW,
        nbf: NOW,
        jti: accessTokenPayload.jti,
        scope: 'openid profile',
        client_id: CLIENT_ID,
        acr: 'urn:acr:mfa',
      });
    });

    it('should leave the acr claim out when the authentication has no acr', async () => {
      const { c, signingKey } = await providerContext();

      const { accessToken } = await issueAccessToken(c, {
        signingKey,
        subject: SUBJECT,
        validatedRequest: authorizationCodeRequest(),
        issuedAt: NOW,
        acr: undefined,
      });

      expect(decodeJwt(accessToken).payload).not.toHaveProperty('acr');
    });
  });

  describe('Audience', () => {
    // RFC 9068 §3: aud is never empty; the UserInfo endpoint is always a member, the resource follows.
    it('should return the UserInfo endpoint followed by the requested resource as the audience', async () => {
      const { c, signingKey } = await providerContext();

      const { accessToken, audience } = await issueAccessToken(c, {
        signingKey,
        subject: SUBJECT,
        validatedRequest: authorizationCodeRequest({ audience: ['https://rs.example.com'] }),
        issuedAt: NOW,
        acr: undefined,
      });

      expect(audience).toEqual([USERINFO_ENDPOINT, 'https://rs.example.com']);
      expect(decodeJwt(accessToken).payload.aud).toEqual([USERINFO_ENDPOINT, 'https://rs.example.com']);
    });

    // OAuth 2.1 §4.3.1: a refresh keeps the stored audience, which already holds the UserInfo endpoint.
    it('should keep the stored audience of a refresh token grant without repeating the UserInfo endpoint', async () => {
      const { c, signingKey } = await providerContext();

      const { audience } = await issueAccessToken(c, {
        signingKey,
        subject: SUBJECT,
        validatedRequest: refreshTokenRequest({ audience: [USERINFO_ENDPOINT, 'https://rs.example.com'] }),
        issuedAt: NOW,
        acr: undefined,
      });

      expect(audience).toEqual([USERINFO_ENDPOINT, 'https://rs.example.com']);
    });
  });

  describe('Opaque format', () => {
    it('should mint a 43-character opaque token when accessTokenFormat is opaque', async () => {
      const { c, signingKey } = await providerContext({ options: { config: { accessTokenFormat: 'opaque' } } });

      const { accessToken } = await issueAccessToken(c, {
        signingKey,
        subject: SUBJECT,
        validatedRequest: authorizationCodeRequest(),
        issuedAt: NOW,
        acr: undefined,
      });

      // 32 random bytes, base64url without padding.
      expect(accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });
});
