import { describe, expect, it } from 'vitest';
import { contextOf, formPost, requestTo } from '../../../../test-support/context.js';
import { TokenEndpointError } from '../response.js';
import { parseTokenRequest } from './parse-request.js';

function rawPost(body: string, contentType: string): Request {
  return requestTo('/token', { method: 'POST', headers: { 'Content-Type': contentType }, body });
}

describe('parseTokenRequest', () => {
  describe('Form body', () => {
    // RFC 6749 §4.1.3 / §2.3.1: the form fields and the Authorization header.
    it('should return every form field as params and the Authorization header as it was sent', async () => {
      const c = contextOf(
        formPost(
          '/token',
          { grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://rp.example.com/callback' },
          { Authorization: 'Basic Y2xpZW50LTE6c2VjcmV0' },
        ),
      );

      await expect(parseTokenRequest(c)).resolves.toEqual({
        params: {
          grant_type: 'authorization_code',
          code: 'code-1',
          redirect_uri: 'https://rp.example.com/callback',
        },
        authorization: 'Basic Y2xpZW50LTE6c2VjcmV0',
      });
    });

    it('should return an empty authorization when the request has no Authorization header', async () => {
      const c = contextOf(formPost('/token', { grant_type: 'refresh_token', refresh_token: 'rt-1' }));

      await expect(parseTokenRequest(c)).resolves.toEqual({
        params: { grant_type: 'refresh_token', refresh_token: 'rt-1' },
        authorization: '',
      });
    });

    // RFC 9110 §8.3.1: media types are case-insensitive and may carry parameters.
    it('should accept a form Content-Type written in another case with a charset parameter', async () => {
      const c = contextOf(rawPost('grant_type=authorization_code', 'Application/X-WWW-Form-URLEncoded; charset=UTF-8'));

      await expect(parseTokenRequest(c)).resolves.toEqual({
        params: { grant_type: 'authorization_code' },
        authorization: '',
      });
    });
  });

  describe('Malformed requests', () => {
    // RFC 6749 §4.1.3 / OIDC Core 1.0 §3.1.3.1: the body MUST be application/x-www-form-urlencoded.
    it('should reject a JSON body with 400 invalid_request', async () => {
      const c = contextOf(rawPost('{"grant_type":"authorization_code"}', 'application/json'));

      const parsing = parseTokenRequest(c);

      await expect(parsing).rejects.toBeInstanceOf(TokenEndpointError);
      await expect(parsing).rejects.toMatchObject({
        response: {
          status: 400,
          body: {
            error: 'invalid_request',
            error_description: 'Token requests must use application/x-www-form-urlencoded',
          },
        },
      });
    });

    // RFC 6749 §3.2: request parameters MUST NOT be included more than once.
    it('should reject a repeated parameter with 400 invalid_request naming the parameter', async () => {
      const c = contextOf(rawPost('grant_type=authorization_code&code=a&code=b', 'application/x-www-form-urlencoded'));

      await expect(parseTokenRequest(c)).rejects.toMatchObject({
        response: {
          status: 400,
          body: { error: 'invalid_request', error_description: 'Parameter "code" must not be repeated' },
        },
      });
    });

    // RFC 6749 §4.1.3: grant_type is REQUIRED.
    it('should reject a form without grant_type with 400 invalid_request', async () => {
      const c = contextOf(formPost('/token', { code: 'code-1' }));

      await expect(parseTokenRequest(c)).rejects.toMatchObject({
        response: {
          status: 400,
          body: { error: 'invalid_request', error_description: 'Missing required parameter: grant_type' },
        },
      });
    });
  });
});
