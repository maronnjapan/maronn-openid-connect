import { describe, expect, it } from 'vitest';
import {
  RECORDED_RESPONSE,
  recordingResponseMode,
  REDIRECT_URI,
  redirectOf,
} from '../../../test-support/authorize.js';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { buildErrorResponse, buildSuccessResponse, isAuthorizationRequestParams } from './outcome.js';

describe('isAuthorizationRequestParams', () => {
  it('should accept parameters that carry a string client_id', () => {
    expect(isAuthorizationRequestParams({ client_id: 'client-1', scope: 'openid' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'client_id=client-1'],
    ['parameters without client_id', { scope: 'openid' }],
    ['a client_id that is not a string', { client_id: ['client-1'] }],
  ])('should reject %s', (_label, params) => {
    expect(isAuthorizationRequestParams(params)).toBe(false);
  });
});

describe('buildErrorResponse', () => {
  describe('Plain query response', () => {
    // OIDC Core 1.0 §3.1.2.6 / RFC 6749 §4.1.2.1 / RFC 9207 §2
    it('should redirect with error, error_description, state and iss appended to the redirect_uri', async () => {
      const response = await buildErrorResponse(undefined, REDIRECT_URI, 'access_denied', 'state-1', 'User denied', TEST_ISSUER);

      expect(response).toEqual({
        method: 'redirect',
        location:
          'https://rp.example.com/callback?error=access_denied&error_description=User+denied&state=state-1&iss=https%3A%2F%2Fop.example.com',
      });
    });

    it('should keep the query the registered redirect_uri already has', async () => {
      const response = await buildErrorResponse(
        undefined,
        'https://rp.example.com/callback?tenant=a',
        'access_denied',
        undefined,
        undefined,
        TEST_ISSUER,
      );

      expect(response).toEqual({
        method: 'redirect',
        location: 'https://rp.example.com/callback?tenant=a&error=access_denied&iss=https%3A%2F%2Fop.example.com',
      });
    });

    it('should leave out error_description and state when they are not given', async () => {
      expect(await buildErrorResponse(undefined, REDIRECT_URI, 'invalid_request', undefined, undefined, TEST_ISSUER)).toEqual({
        method: 'redirect',
        location: 'https://rp.example.com/callback?error=invalid_request&iss=https%3A%2F%2Fop.example.com',
      });
    });

    // RFC 6749 §5.2: error_description is limited to %x20-21 / %x23-5B / %x5D-7E.
    it('should replace characters outside the RFC 6749 error_description set with ?', async () => {
      const response = await buildErrorResponse(undefined, REDIRECT_URI, 'invalid_request', undefined, 'bad "value"\n\\', TEST_ISSUER);

      expect(redirectOf((response as { location: string }).location).params['error_description']).toBe('bad ?value???');
    });
  });

  describe('Response mode of a feature', () => {
    it('should hand error, the sanitized error_description and state to the response mode and add no plain parameter', async () => {
      const { responseMode, respond } = recordingResponseMode();

      const response = await buildErrorResponse(responseMode, REDIRECT_URI, 'access_denied', 'state-1', 'say "no"', TEST_ISSUER);

      expect(response).toEqual(RECORDED_RESPONSE);
      expect(respond.mock.calls).toEqual([
        [REDIRECT_URI, { error: 'access_denied', error_description: 'say ?no?', state: 'state-1' }],
      ]);
    });
  });
});

describe('buildSuccessResponse', () => {
  describe('Plain query response', () => {
    // OIDC Core 1.0 §3.1.2.5 / RFC 9207 §2
    it('should redirect with code, state and iss appended to the redirect_uri', async () => {
      const response = await buildSuccessResponse(undefined, REDIRECT_URI, 'code-1', 'state-1', TEST_ISSUER);

      expect(response).toEqual({
        method: 'redirect',
        location: 'https://rp.example.com/callback?code=code-1&state=state-1&iss=https%3A%2F%2Fop.example.com',
      });
    });

    // RFC 9207 §2: iss is part of every authorization response, with or without state.
    it('should leave out state but still append iss when the request had no state', async () => {
      const response = await buildSuccessResponse(undefined, REDIRECT_URI, 'code-1', undefined, TEST_ISSUER);

      expect(response).toEqual({
        method: 'redirect',
        location: 'https://rp.example.com/callback?code=code-1&iss=https%3A%2F%2Fop.example.com',
      });
    });
  });

  describe('Response mode of a feature', () => {
    it('should hand code and state to the response mode and add no plain parameter', async () => {
      const { responseMode, respond } = recordingResponseMode();

      const response = await buildSuccessResponse(responseMode, REDIRECT_URI, 'code-1', 'state-1', TEST_ISSUER);

      expect(response).toEqual(RECORDED_RESPONSE);
      expect(respond.mock.calls).toEqual([[REDIRECT_URI, { code: 'code-1', state: 'state-1' }]]);
    });
  });
});
