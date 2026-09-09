import { INACTIVE_INTROSPECTION_RESPONSE, type IntrospectionResponse } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { restrictIntrospectionResponseToCaller } from './audience.js';

function activeResponse(overrides: Partial<Extract<IntrospectionResponse, { active: true }>> = {}): IntrospectionResponse {
  return {
    active: true,
    scope: 'openid',
    client_id: 'issued-to-client',
    token_type: 'Bearer',
    sub: 'testuser',
    exp: 1785801600,
    ...overrides,
  };
}

describe('restrictIntrospectionResponseToCaller', () => {
  describe('Responses disclosed to the caller (RFC 9701 §3)', () => {
    it('should return the response unchanged for the client the token was issued to', () => {
      const response = activeResponse();

      expect(restrictIntrospectionResponseToCaller(response, 'issued-to-client')).toEqual({
        active: true,
        scope: 'openid',
        client_id: 'issued-to-client',
        token_type: 'Bearer',
        sub: 'testuser',
        exp: 1785801600,
      });
    });

    it('should return the response unchanged for a caller listed in a string aud', () => {
      const response = activeResponse({ aud: 'rs-client' });

      expect(restrictIntrospectionResponseToCaller(response, 'rs-client')).toEqual({
        active: true,
        scope: 'openid',
        client_id: 'issued-to-client',
        token_type: 'Bearer',
        sub: 'testuser',
        exp: 1785801600,
        aud: 'rs-client',
      });
    });

    it('should return the response unchanged for a caller listed in an array aud', () => {
      const response = activeResponse({ aud: ['http://localhost:3000/userinfo', 'rs-client'] });

      expect(restrictIntrospectionResponseToCaller(response, 'rs-client')).toEqual({
        active: true,
        scope: 'openid',
        client_id: 'issued-to-client',
        token_type: 'Bearer',
        sub: 'testuser',
        exp: 1785801600,
        aud: ['http://localhost:3000/userinfo', 'rs-client'],
      });
    });
  });

  describe('Responses withheld from the caller (RFC 9701 §5 MUST NOT)', () => {
    it('should replace the response with active false only for a caller that is neither issuee nor audience', () => {
      const response = activeResponse({ aud: ['http://localhost:3000/userinfo'] });

      expect(restrictIntrospectionResponseToCaller(response, 'other-client')).toEqual({
        active: false,
      });
    });

    it('should withhold a response without an aud member from every caller but the issuee', () => {
      const response = activeResponse();

      expect(restrictIntrospectionResponseToCaller(response, 'other-client')).toEqual({
        active: false,
      });
    });

    // The withheld shape must be the shared inactive singleton so a restricted
    // response is byte-identical to a genuinely inactive one (no oracle).
    it('should return the shared inactive response object when withholding', () => {
      const restricted = restrictIntrospectionResponseToCaller(activeResponse(), 'other-client');

      expect(restricted).toBe(INACTIVE_INTROSPECTION_RESPONSE);
    });
  });

  describe('Inactive responses', () => {
    it('should pass an inactive response through unchanged', () => {
      const response: IntrospectionResponse = { active: false };

      expect(restrictIntrospectionResponseToCaller(response, 'any-client')).toBe(response);
    });
  });

  describe('Purity', () => {
    it('should not mutate the input response when withholding', () => {
      const response = activeResponse({ aud: 'someone-else' });

      restrictIntrospectionResponseToCaller(response, 'other-client');

      expect(response).toEqual({
        active: true,
        scope: 'openid',
        client_id: 'issued-to-client',
        token_type: 'Bearer',
        sub: 'testuser',
        exp: 1785801600,
        aud: 'someone-else',
      });
    });
  });
});
