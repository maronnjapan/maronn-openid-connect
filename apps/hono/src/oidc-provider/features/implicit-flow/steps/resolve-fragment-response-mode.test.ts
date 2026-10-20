import type { AuthorizationRequestParams } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../../test-support/context.js';
import { resolveFragmentResponseContext } from './resolve-fragment-response-mode.js';

function paramsWith(responseType: string | undefined, responseMode?: string): AuthorizationRequestParams {
  return {
    client_id: 'client-1',
    ...(responseType === undefined ? {} : { response_type: responseType }),
    ...(responseMode === undefined ? {} : { response_mode: responseMode }),
  } as AuthorizationRequestParams;
}

describe('resolveFragmentResponseContext', () => {
  describe('Default Response Mode', () => {
    // OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5: the
    // default of a response type that returns an ID Token or an access token.
    it('should answer in the fragment, adding the iss of the issuer, for response_type=id_token', async () => {
      const mode = resolveFragmentResponseContext(paramsWith('id_token'), TEST_ISSUER);

      expect(mode?.name).toBe('fragment');
      expect(await mode?.respond('https://rp.example.com/callback', { id_token: 'id-token-1' })).toEqual({
        method: 'redirect',
        location: 'https://rp.example.com/callback#id_token=id-token-1&iss=https%3A%2F%2Fop.example.com',
      });
    });

    // The order of the values does not matter (OAuth 2.0 Multiple Response
    // Type Encoding Practices §5), and an unsupported value such as token
    // alone gets its error in the fragment too (§2.1).
    it('should answer in the fragment for every response type that returns a token', () => {
      const names = ['id_token token', 'token id_token', 'token', 'code id_token', 'code token'].map(
        (responseType) => resolveFragmentResponseContext(paramsWith(responseType), TEST_ISSUER)?.name,
      );

      expect(names).toEqual(['fragment', 'fragment', 'fragment', 'fragment', 'fragment']);
    });

    // OAuth 2.0 Multiple Response Type Encoding Practices §2.1: the default
    // of response_type=code is the query.
    it('should return undefined for response_type=code and a request without response_type', () => {
      expect(resolveFragmentResponseContext(paramsWith('code'), TEST_ISSUER)).toBeUndefined();
      expect(resolveFragmentResponseContext(paramsWith(undefined), TEST_ISSUER)).toBeUndefined();
    });
  });

  describe('response_mode=fragment', () => {
    // OAuth 2.0 Multiple Response Type Encoding Practices §2.1: a code can be
    // asked for in the fragment.
    it('should answer response_type=code in the fragment when the request asks for it', () => {
      expect(resolveFragmentResponseContext(paramsWith('code', 'fragment'), TEST_ISSUER)?.name).toBe('fragment');
    });

    // OAuth 2.0 Multiple Response Type Encoding Practices §2.1: response_mode
    // values are case-sensitive.
    it('should return undefined for response_type=code with any other response_mode value', () => {
      const modes = ['query', 'FRAGMENT', 'fragment.jwt'].map((responseMode) =>
        resolveFragmentResponseContext(paramsWith('code', responseMode), TEST_ISSUER),
      );

      expect(modes).toEqual([undefined, undefined, undefined]);
    });
  });
});
