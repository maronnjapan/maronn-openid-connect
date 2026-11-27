import { describe, expect, it } from 'vitest';
import { contextOf, formPost, requestTo } from '../../../../test-support/context.js';
import { BEARER_CHALLENGE, UserInfoEndpointError, userInfoChallengeHeader, type UserInfoChallenges } from '../response.js';
import { parseUserInfoRequest } from './parse-access-token.js';

describe('parseUserInfoRequest', () => {
  describe('Authorization header', () => {
    // RFC 6750 §2.1
    it('should read the token of the Bearer scheme', async () => {
      const c = contextOf(requestTo('/userinfo', { headers: { Authorization: 'Bearer token-1' } }));

      expect(await parseUserInfoRequest(c)).toBe('token-1');
    });

    // RFC 7235 §2.1: the authentication scheme is case-insensitive; the token is kept verbatim.
    it('should match the scheme case-insensitively and keep the token as it is', async () => {
      const c = contextOf(requestTo('/userinfo', { headers: { Authorization: 'bEaReR Token-ABC' } }));

      expect(await parseUserInfoRequest(c)).toBe('Token-ABC');
    });

    // RFC 6750 §2.1: credentials = "Bearer" 1*SP b64token — one or more spaces follow the scheme.
    it('should read the token after several spaces following the scheme', async () => {
      const c = contextOf(requestTo('/userinfo', { headers: { Authorization: 'Bearer   token-1' } }));

      expect(await parseUserInfoRequest(c)).toBe('token-1');
    });
  });

  describe('Form body', () => {
    // RFC 6750 §2.2
    it('should read access_token from a form POST whose media type differs in case and has parameters', async () => {
      const c = contextOf(
        formPost('/userinfo', { access_token: 'token-1' }, {
          'Content-Type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8',
        }),
      );

      expect(await parseUserInfoRequest(c)).toBe('token-1');
    });

    it('should ignore access_token in a body that is not a form', async () => {
      const c = contextOf(
        requestTo('/userinfo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: 'token-1' }),
        }),
      );

      await expect(parseUserInfoRequest(c)).rejects.toMatchObject({ response: { status: 401 } });
    });
  });

  describe('Errors', () => {
    // RFC 6750 §2: a client MUST NOT use more than one method in a request.
    // RFC 9449 §7.2: both methods are Bearer ones, so the mechanism is known and its challenge alone delivers the error.
    it('should reject a token sent both in the header and in the body with 400 invalid_request in the Bearer challenge', async () => {
      const c = contextOf(formPost('/userinfo', { access_token: 'token-2' }, { Authorization: 'Bearer token-1' }));

      const rejection = parseUserInfoRequest(c);

      await expect(rejection).rejects.toMatchObject({
        response: {
          status: 400,
          body: { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
        },
      });
      await expect(rejection).rejects.toHaveProperty('challenge', { error: 'invalid_request' });
    });

    // RFC 9449 §7.2 Figure 18: the challenge of another accepted scheme stays bare.
    it('should leave the error of two Bearer methods out of the challenge of another scheme', async () => {
      const c = contextOf(formPost('/userinfo', { access_token: 'token-2' }, { Authorization: 'Bearer token-1' }));
      const challenges: UserInfoChallenges = {
        offered: [BEARER_CHALLENGE, { scheme: 'DPoP', parameters: ['algs="ES256"'] }],
        scheme: 'Bearer',
      };

      const error = await parseUserInfoRequest(c).catch((caught: unknown) => caught);
      const challenge = error instanceof UserInfoEndpointError ? error.challenge : undefined;

      expect(challenge).toBeDefined();
      expect(userInfoChallengeHeader(challenges, challenge ?? 'without-error')).toBe(
        'Bearer realm="UserInfo", error="invalid_request", DPoP algs="ES256"',
      );
    });

    // RFC 6750 §3.1: a request without authentication gets challenges without an error.
    it('should reject a request without a token with 401 and challenges without an error', async () => {
      const c = contextOf(requestTo('/userinfo'));

      const rejection = parseUserInfoRequest(c);

      await expect(rejection).rejects.toBeInstanceOf(UserInfoEndpointError);
      await expect(rejection).rejects.toMatchObject({
        response: {
          status: 401,
          body: { error: 'invalid_token', error_description: 'Access token is required' },
        },
        challenge: 'without-error',
      });
    });

    it('should reject a body it cannot read with 400 invalid_request and no challenge', async () => {
      const brokenBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('the connection was reset'));
        },
      });
      const c = contextOf(
        requestTo('/userinfo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: brokenBody,
          duplex: 'half',
        } as RequestInit),
      );

      const rejection = parseUserInfoRequest(c);

      await expect(rejection).rejects.toMatchObject({ response: { status: 400, body: { error: 'invalid_request' } } });
      await expect(rejection).rejects.toHaveProperty('challenge', undefined);
    });

    it('should treat another authentication scheme as no token', async () => {
      const c = contextOf(requestTo('/userinfo', { headers: { Authorization: 'Basic dXNlcjpwYXNz' } }));

      await expect(parseUserInfoRequest(c)).rejects.toMatchObject({ response: { status: 401 } });
    });
  });
});
