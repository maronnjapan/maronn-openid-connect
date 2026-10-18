import { describe, expect, it } from 'vitest';
import { contextOf, formPost, requestTo } from '../../../../test-support/context.js';
import { parseAuthorizationRequest } from './parse-request.js';

describe('parseAuthorizationRequest', () => {
  describe('Transport', () => {
    it('should return the query parameters of a GET request', async () => {
      const c = contextOf(requestTo('/authorize?client_id=client-1&response_type=code&scope=openid'));

      expect(await parseAuthorizationRequest(c)).toEqual({
        params: { client_id: 'client-1', response_type: 'code', scope: 'openid' },
      });
    });

    // OIDC Core 1.0 §3.1.2.1 / §13.2: POST sends the parameters form-encoded.
    it('should return the form fields of a POST request with a charset in its Content-Type', async () => {
      const c = contextOf(
        formPost('/authorize', { client_id: 'client-1', scope: 'openid' }, {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        }),
      );

      expect(await parseAuthorizationRequest(c)).toEqual({ params: { client_id: 'client-1', scope: 'openid' } });
    });

    // OIDC Core 1.0 §13.2
    it('should return bad_request for a POST that is not application/x-www-form-urlencoded', async () => {
      const c = contextOf(
        requestTo('/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: 'client-1' }),
        }),
      );

      expect(await parseAuthorizationRequest(c)).toEqual({
        kind: 'bad_request',
        error: 'invalid_request',
        errorDescription: 'Authorization POST requests must use application/x-www-form-urlencoded',
      });
    });
  });

  describe('Parameters', () => {
    // OIDC Core 1.0 §3.1.2.1 / RFC 6749 §3.1: request parameters MUST NOT be repeated.
    it('should return bad_request naming the parameter a GET request repeats', async () => {
      const c = contextOf(requestTo('/authorize?client_id=client-1&response_type=code&response_type=token'));

      expect(await parseAuthorizationRequest(c)).toEqual({
        kind: 'bad_request',
        error: 'invalid_request',
        errorDescription: 'Parameter "response_type" must not be repeated',
      });
    });

    // RFC 6749 §3.1: the raw body is scanned, so a repeated form field is caught too.
    it('should return bad_request naming the field a POST body repeats', async () => {
      const c = contextOf(
        requestTo('/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'client_id=client-1&scope=openid&scope=profile',
        }),
      );

      expect(await parseAuthorizationRequest(c)).toEqual({
        kind: 'bad_request',
        error: 'invalid_request',
        errorDescription: 'Parameter "scope" must not be repeated',
      });
    });

    it('should return bad_request when client_id is missing', async () => {
      const c = contextOf(requestTo('/authorize?response_type=code&scope=openid'));

      expect(await parseAuthorizationRequest(c)).toEqual({
        kind: 'bad_request',
        error: 'invalid_request',
        errorDescription: 'Missing required parameter: client_id',
      });
    });
  });
});
