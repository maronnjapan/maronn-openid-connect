import type { ClientInfo } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import {
  authorizationParams,
  CLIENT_ID,
  recordingResponseMode,
  REDIRECT_URI,
  STATE,
  validatedRequestOf,
} from '../../../../test-support/authorize.js';
import { TEST_ISSUER } from '../../../../test-support/context.js';
import type { AuthorizationRequestInput } from '../../../endpoints/authorize/outcome.js';
import { createFragmentResponseMode } from '../response-mode.js';
import { validateImplicitRequest } from './validate-implicit-request.js';

const LOOPBACK_REDIRECT_URI = 'http://127.0.0.1:8080/callback';

const client: ClientInfo = {
  clientId: CLIENT_ID,
  clientType: 'confidential',
  redirectUris: [REDIRECT_URI],
  responseTypes: ['id_token token', 'id_token'],
};

const fragment = createFragmentResponseMode({ issuer: TEST_ISSUER });

function paramsWith(overrides: Record<string, string> = {}): AuthorizationRequestInput {
  return authorizationParams({ response_type: 'id_token token', ...overrides }) as AuthorizationRequestInput;
}

describe('validateImplicitRequest', () => {
  describe('Implicit Flow', () => {
    // OIDC Core 1.0 §3.2.2.1: nonce, an https redirect_uri and the default
    // response mode (the fragment) make a valid request.
    it('should accept a request of response_type=id_token token and of id_token with a nonce', () => {
      const validate = (responseType: 'id_token token' | 'id_token') =>
        validateImplicitRequest(
          validatedRequestOf({ responseType }),
          paramsWith({ response_type: responseType }),
          client,
          fragment,
        );

      expect(validate('id_token token')).toBeUndefined();
      expect(validate('id_token')).toBeUndefined();
    });

    // OAuth 2.0 Form Post Response Mode §2 / Multiple Response Type Encoding
    // Practices §2.1: the response modes the request asked for by name.
    it('should accept response_mode=fragment and response_mode=form_post', () => {
      const { responseMode: formPost } = recordingResponseMode('form_post');

      expect(
        validateImplicitRequest(validatedRequestOf({ responseType: 'id_token' }), paramsWith({ response_mode: 'fragment' }), client, fragment),
      ).toBeUndefined();
      expect(
        validateImplicitRequest(validatedRequestOf({ responseType: 'id_token' }), paramsWith({ response_mode: 'form_post' }), client, formPost),
      ).toBeUndefined();
    });
  });

  describe('Authorization Code Flow', () => {
    // The code flow needs no nonce and may use the query.
    it('should leave a request of response_type=code alone', () => {
      expect(
        validateImplicitRequest(
          validatedRequestOf({ nonce: undefined }),
          authorizationParams({ response_mode: 'query', redirect_uri: 'http://rp.example.com/callback' }) as AuthorizationRequestInput,
          { ...client, clientType: 'confidential' },
          undefined,
        ),
      ).toBeUndefined();
    });
  });

  // OIDC Core 1.0 §3.2.2.6: each failure goes back to the redirect_uri with
  // the state, in the response mode of the request.
  describe('response_mode', () => {
    // OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5: the tokens
    // must not travel in the query.
    it('should reject response_mode=query with invalid_request', () => {
      expect(() =>
        validateImplicitRequest(validatedRequestOf({ responseType: 'id_token token' }), paramsWith({ response_mode: 'query' }), client, fragment),
      ).toThrow(
        expect.objectContaining({
          error: 'invalid_request',
          errorDescription: 'response_mode=query must not be used with the Implicit Flow',
          redirectUri: REDIRECT_URI,
          state: STATE,
        }),
      );
    });

    // OAuth 2.0 Multiple Response Type Encoding Practices §2.1: a value the
    // OP does not answer this request in is refused, not replaced.
    it('should reject a response_mode the request is not answered in with invalid_request', () => {
      expect(() =>
        validateImplicitRequest(validatedRequestOf({ responseType: 'id_token' }), paramsWith({ response_mode: 'query.jwt' }), client, fragment),
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
    // OIDC Core 1.0 §3.2.2.1: nonce is REQUIRED in the Implicit Flow.
    it('should reject a request without nonce with invalid_request', () => {
      expect(() =>
        validateImplicitRequest(validatedRequestOf({ responseType: 'id_token', nonce: undefined }), paramsWith(), client, fragment),
      ).toThrow(
        expect.objectContaining({
          error: 'invalid_request',
          errorDescription: 'Missing required parameter: nonce',
          redirectUri: REDIRECT_URI,
          state: STATE,
        }),
      );
    });
  });

  describe('redirect_uri', () => {
    // OIDC Core 1.0 §3.2.2.1: http only for a native client on a loopback host.
    it('should reject an http redirect_uri of a confidential client with invalid_request', () => {
      expect(() =>
        validateImplicitRequest(
          validatedRequestOf({ responseType: 'id_token', redirectUri: LOOPBACK_REDIRECT_URI }),
          paramsWith({ redirect_uri: LOOPBACK_REDIRECT_URI }),
          client,
          fragment,
        ),
      ).toThrow(
        expect.objectContaining({
          error: 'invalid_request',
          errorDescription:
            'redirect_uri of the Implicit Flow must use https, or http on a loopback host for a public client',
          redirectUri: LOOPBACK_REDIRECT_URI,
          state: STATE,
        }),
      );
    });

    it('should accept an http redirect_uri on a loopback host of a public client', () => {
      expect(
        validateImplicitRequest(
          validatedRequestOf({ responseType: 'id_token', redirectUri: LOOPBACK_REDIRECT_URI }),
          paramsWith({ redirect_uri: LOOPBACK_REDIRECT_URI }),
          { ...client, clientType: 'public', redirectUris: [LOOPBACK_REDIRECT_URI] },
          fragment,
        ),
      ).toBeUndefined();
    });
  });
});
