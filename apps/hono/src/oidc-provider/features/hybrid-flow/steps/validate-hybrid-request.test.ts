import { describe, expect, it } from 'vitest';
import {
  authorizationParams,
  recordingResponseMode,
  REDIRECT_URI,
  STATE,
  validatedRequestOf,
} from '../../../../test-support/authorize.js';
import { TEST_ISSUER } from '../../../../test-support/context.js';
import type { AuthorizationRequestInput } from '../../../endpoints/authorize/outcome.js';
import { createFragmentResponseMode } from '../../implicit-flow/response-mode.js';
import { validateHybridRequest } from './validate-hybrid-request.js';

const fragment = createFragmentResponseMode({ issuer: TEST_ISSUER });

function paramsWith(overrides: Record<string, string> = {}): AuthorizationRequestInput {
  return authorizationParams({ response_type: 'code id_token token', ...overrides }) as AuthorizationRequestInput;
}

describe('validateHybridRequest', () => {
  describe('Hybrid Flow', () => {
    // OIDC Core 1.0 §3.3.2.1 / §3.3.2.11: a nonce and the default response mode
    // (the fragment) make a valid request of every hybrid response type.
    it('should accept a request of each hybrid response type with a nonce', () => {
      const validate = (responseType: 'code id_token' | 'code token' | 'code id_token token') =>
        validateHybridRequest(validatedRequestOf({ responseType }), paramsWith({ response_type: responseType }), fragment);

      expect(validate('code id_token')).toBeUndefined();
      expect(validate('code token')).toBeUndefined();
      expect(validate('code id_token token')).toBeUndefined();
    });

    // OAuth 2.0 Form Post Response Mode §2 / Multiple Response Type Encoding
    // Practices §2.1: the response modes the request asked for by name.
    it('should accept response_mode=fragment and response_mode=form_post', () => {
      const { responseMode: formPost } = recordingResponseMode('form_post');

      expect(
        validateHybridRequest(validatedRequestOf({ responseType: 'code id_token' }), paramsWith({ response_mode: 'fragment' }), fragment),
      ).toBeUndefined();
      expect(
        validateHybridRequest(validatedRequestOf({ responseType: 'code id_token' }), paramsWith({ response_mode: 'form_post' }), formPost),
      ).toBeUndefined();
    });
  });

  describe('Other flows', () => {
    // The code flow may use the query and needs no nonce; the Implicit Flow has
    // a step of its own.
    it('should leave a request of response_type=code and of the Implicit Flow alone', () => {
      expect(
        validateHybridRequest(
          validatedRequestOf({ nonce: undefined }),
          authorizationParams({ response_mode: 'query' }) as AuthorizationRequestInput,
          undefined,
        ),
      ).toBeUndefined();
      expect(
        validateHybridRequest(
          validatedRequestOf({ responseType: 'id_token', nonce: undefined }),
          paramsWith({ response_type: 'id_token', response_mode: 'query' }),
          fragment,
        ),
      ).toBeUndefined();
    });
  });

  // OIDC Core 1.0 §3.3.2.6: each failure goes back to the redirect_uri with
  // the state, in the response mode of the request.
  describe('response_mode', () => {
    // OAuth 2.0 Multiple Response Type Encoding Practices §5: the tokens must
    // not travel in the query.
    it('should reject response_mode=query with invalid_request', () => {
      expect(() =>
        validateHybridRequest(validatedRequestOf({ responseType: 'code token' }), paramsWith({ response_mode: 'query' }), fragment),
      ).toThrow(
        expect.objectContaining({
          error: 'invalid_request',
          errorDescription: 'response_mode=query must not be used with the Hybrid Flow',
          redirectUri: REDIRECT_URI,
          state: STATE,
        }),
      );
    });

    // OAuth 2.0 Multiple Response Type Encoding Practices §2.1: a value the
    // OP does not answer this request in is refused, not replaced.
    it('should reject a response_mode the request is not answered in with invalid_request', () => {
      expect(() =>
        validateHybridRequest(validatedRequestOf({ responseType: 'code id_token' }), paramsWith({ response_mode: 'query.jwt' }), fragment),
      ).toThrow(
        expect.objectContaining({
          error: 'invalid_request',
          errorDescription: 'Unsupported response_mode: query.jwt',
          redirectUri: REDIRECT_URI,
          state: STATE,
        }),
      );
    });
  });

  describe('nonce', () => {
    // OIDC Core 1.0 §3.3.2.11: nonce is REQUIRED when the authorization
    // endpoint returns an ID Token.
    it('should reject a request of code id_token and of code id_token token without nonce with invalid_request', () => {
      const validate = (responseType: 'code id_token' | 'code id_token token') => () =>
        validateHybridRequest(validatedRequestOf({ responseType, nonce: undefined }), paramsWith({ response_type: responseType }), fragment);

      expect(validate('code id_token')).toThrow(
        expect.objectContaining({
          error: 'invalid_request',
          errorDescription: 'Missing required parameter: nonce',
          redirectUri: REDIRECT_URI,
          state: STATE,
        }),
      );
      expect(validate('code id_token token')).toThrow(
        expect.objectContaining({ error: 'invalid_request', errorDescription: 'Missing required parameter: nonce' }),
      );
    });

    // code token returns no ID Token from the authorization endpoint: nonce
    // stays optional, as in the code flow (the OIDF
    // oidcc-ensure-request-without-nonce-succeeds-for-code-flow module).
    it('should accept a request of code token without nonce', () => {
      expect(
        validateHybridRequest(validatedRequestOf({ responseType: 'code token', nonce: undefined }), paramsWith({ response_type: 'code token' }), fragment),
      ).toBeUndefined();
    });
  });
});
