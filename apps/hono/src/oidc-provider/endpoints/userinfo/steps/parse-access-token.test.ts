import { describe, expect, it } from 'vitest';
import { contextOf, formPost, requestTo } from '../../../../test-support/context.js';
import { UserInfoEndpointError } from '../response.js';
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
    it('should reject a token sent both in the header and in the body with 400 invalid_request', async () => {
      const c = contextOf(formPost('/userinfo', { access_token: 'token-2' }, { Authorization: 'Bearer token-1' }));

      await expect(parseUserInfoRequest(c)).rejects.toMatchObject({
        response: {
          status: 400,
          body: { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
          headers: { 'WWW-Authenticate': 'Bearer realm="UserInfo", error="invalid_request"' },
        },
      });
    });

    // RFC 6750 §3.1: a request without authentication gets the realm-only challenge.
    it('should reject a request without a token with 401 and the realm-only challenge', async () => {
      const c = contextOf(requestTo('/userinfo'));

      const rejection = parseUserInfoRequest(c);

      await expect(rejection).rejects.toBeInstanceOf(UserInfoEndpointError);
      await expect(rejection).rejects.toMatchObject({
        response: {
          status: 401,
          body: { error: 'invalid_token', error_description: 'Access token is required' },
          headers: { 'WWW-Authenticate': 'Bearer realm="UserInfo"' },
        },
      });
    });

    it('should treat another authentication scheme as no token', async () => {
      const c = contextOf(requestTo('/userinfo', { headers: { Authorization: 'Basic dXNlcjpwYXNz' } }));

      await expect(parseUserInfoRequest(c)).rejects.toMatchObject({ response: { status: 401 } });
    });
  });
});
