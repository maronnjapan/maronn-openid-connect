import { describe, expect, it } from 'vitest';
import {
  ClientRegistrationError,
  validateClientRegistrationRequest,
} from './registration-request.js';

function body(metadata: Record<string, unknown>): string {
  return JSON.stringify(metadata);
}

const MINIMAL = { redirect_uris: ['https://app.example.com/cb'] };

describe('validateClientRegistrationRequest', () => {
  describe('defaults (RFC 7591 Section 2)', () => {
    it('should apply every default to a minimal registration', () => {
      const validated = validateClientRegistrationRequest(body(MINIMAL));
      expect(validated).toEqual({
        redirectUris: ['https://app.example.com/cb'],
        tokenEndpointAuthMethod: 'client_secret_basic',
        grantTypes: ['authorization_code'],
        responseTypes: ['code'],
      });
    });

    it('should keep every explicitly registered value', () => {
      const validated = validateClientRegistrationRequest(
        body({
          redirect_uris: ['https://app.example.com/cb', 'http://127.0.0.1:8080/cb'],
          token_endpoint_auth_method: 'client_secret_post',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          client_name: 'My Test App',
        }),
      );
      expect(validated).toEqual({
        redirectUris: ['https://app.example.com/cb', 'http://127.0.0.1:8080/cb'],
        tokenEndpointAuthMethod: 'client_secret_post',
        grantTypes: ['authorization_code', 'refresh_token'],
        responseTypes: ['code'],
        clientName: 'My Test App',
      });
    });

    it('should normalize duplicated grant_types values to one entry', () => {
      const validated = validateClientRegistrationRequest(
        body({ ...MINIMAL, grant_types: ['authorization_code', 'authorization_code'] }),
      );
      expect(validated.grantTypes).toEqual(['authorization_code']);
    });
  });

  describe('unknown metadata (RFC 7591 Section 2 MUST ignore)', () => {
    it('should silently drop metadata this provider does not understand', () => {
      const validated = validateClientRegistrationRequest(
        body({
          ...MINIMAL,
          logo_uri: 'https://app.example.com/logo.png',
          jwks_uri: 'https://app.example.com/jwks.json',
          software_statement: 'eyJhbGciOiJSUzI1NiJ9.e30.sig',
        }),
      );
      expect(validated).toEqual({
        redirectUris: ['https://app.example.com/cb'],
        tokenEndpointAuthMethod: 'client_secret_basic',
        grantTypes: ['authorization_code'],
        responseTypes: ['code'],
      });
    });

    it('should drop __proto__ and constructor keys as unknown metadata without polluting the result', () => {
      const validated = validateClientRegistrationRequest(
        '{"redirect_uris":["https://app.example.com/cb"],"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
      );
      expect(validated).toEqual({
        redirectUris: ['https://app.example.com/cb'],
        tokenEndpointAuthMethod: 'client_secret_basic',
        grantTypes: ['authorization_code'],
        responseTypes: ['code'],
      });
      expect(Object.getPrototypeOf(validated)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>)['polluted']).toBe(undefined);
    });
  });

  describe('request body shape', () => {
    it('should reject a body that is not valid JSON', () => {
      expect(() => validateClientRegistrationRequest('not json')).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'request body must be valid JSON'),
      );
    });

    it('should reject a JSON array body', () => {
      expect(() => validateClientRegistrationRequest('[]')).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'request body must be a JSON object'),
      );
    });

    it('should reject a JSON primitive body', () => {
      expect(() => validateClientRegistrationRequest('"redirect_uris"')).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'request body must be a JSON object'),
      );
    });

    it('should reject a JSON null body', () => {
      expect(() => validateClientRegistrationRequest('null')).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'request body must be a JSON object'),
      );
    });
  });

  describe('body size limit (UTF-8 bytes)', () => {
    // 多バイト文字を含むボディで、判定が文字数ではなくバイト長であることを固定する。
    // 'あ' は UTF-8 で 3 バイト。
    const base = '{"redirect_uris":["https://app.example.com/cb"],"client_name":"';
    const suffix = '"}';

    it('should accept a body exactly at the byte limit', () => {
      const fixedBytes = new TextEncoder().encode(base + suffix).length;
      const multiByteChars = 8;
      const limit = fixedBytes + multiByteChars * 3;
      const rawBody = base + 'あ'.repeat(multiByteChars) + suffix;
      expect(new TextEncoder().encode(rawBody).length).toBe(limit);
      const validated = validateClientRegistrationRequest(rawBody, { maxBodyBytes: limit });
      expect(validated.clientName).toBe('あ'.repeat(multiByteChars));
    });

    it('should reject a body one byte over the limit', () => {
      const fixedBytes = new TextEncoder().encode(base + suffix).length;
      const multiByteChars = 8;
      const limit = fixedBytes + multiByteChars * 3 - 1;
      const rawBody = base + 'あ'.repeat(multiByteChars) + suffix;
      expect(() => validateClientRegistrationRequest(rawBody, { maxBodyBytes: limit })).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'request body must not exceed the configured maximum size',
        ),
      );
    });
  });

  describe('redirect_uris (OIDC Dynamic Client Registration 1.0 Section 2 REQUIRED)', () => {
    it('should reject a registration without redirect_uris', () => {
      expect(() => validateClientRegistrationRequest(body({}))).toThrowError(
        new ClientRegistrationError(
          'invalid_redirect_uri',
          'redirect_uris must be a non-empty array of strings',
        ),
      );
    });

    it('should reject an empty redirect_uris array', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ redirect_uris: [] })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_redirect_uri',
          'redirect_uris must be a non-empty array of strings',
        ),
      );
    });

    it('should reject a redirect_uris array with a non-string element', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ redirect_uris: ['https://a.example', 1] })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_redirect_uri',
          'redirect_uris must be a non-empty array of strings',
        ),
      );
    });

    it('should reject a redirect_uri with a fragment component', () => {
      expect(() =>
        validateClientRegistrationRequest(
          body({ redirect_uris: ['https://app.example.com/cb#fragment'] }),
        ),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_redirect_uri',
          'each redirect_uri must be an absolute URI without a fragment and must not use a dangerous scheme or non-loopback http',
        ),
      );
    });

    it('should reject a javascript: scheme redirect_uri', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ redirect_uris: ['javascript:alert(1)'] })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_redirect_uri',
          'each redirect_uri must be an absolute URI without a fragment and must not use a dangerous scheme or non-loopback http',
        ),
      );
    });

    it('should reject a non-loopback plain http redirect_uri', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ redirect_uris: ['http://app.example.com/cb'] })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_redirect_uri',
          'each redirect_uri must be an absolute URI without a fragment and must not use a dangerous scheme or non-loopback http',
        ),
      );
    });

    it('should not reflect the offending URI in error_description', () => {
      const secretUri = 'javascript:alert("secret-marker")';
      expect(() =>
        validateClientRegistrationRequest(body({ redirect_uris: [secretUri] })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_redirect_uri',
          'each redirect_uri must be an absolute URI without a fragment and must not use a dangerous scheme or non-loopback http',
        ),
      );
    });

    it('should accept mixed loopback http and https redirect_uris', () => {
      const validated = validateClientRegistrationRequest(
        body({
          redirect_uris: [
            'http://localhost:3000/cb',
            'http://127.0.0.1/cb',
            'http://[::1]:8080/cb',
            'https://app.example.com/cb',
          ],
        }),
      );
      expect(validated.redirectUris).toEqual([
        'http://localhost:3000/cb',
        'http://127.0.0.1/cb',
        'http://[::1]:8080/cb',
        'https://app.example.com/cb',
      ]);
    });

    // RFC 8252 §7.1: native apps register private-use (custom) URI schemes.
    // The registration rule equals the static one (core
    // validateRegisteredRedirectUris), which accepts any scheme outside its
    // dangerous-scheme list.
    it('should accept a private-use scheme redirect_uri', () => {
      const validated = validateClientRegistrationRequest(
        body({ redirect_uris: ['com.example.app:/oauth2redirect'] }),
      );
      expect(validated.redirectUris).toEqual(['com.example.app:/oauth2redirect']);
    });
  });

  describe('token_endpoint_auth_method', () => {
    it('should accept none and keep it', () => {
      const validated = validateClientRegistrationRequest(
        body({ ...MINIMAL, token_endpoint_auth_method: 'none' }),
      );
      expect(validated.tokenEndpointAuthMethod).toBe('none');
    });

    it('should reject an unsupported method such as private_key_jwt', () => {
      expect(() =>
        validateClientRegistrationRequest(
          body({ ...MINIMAL, token_endpoint_auth_method: 'private_key_jwt' }),
        ),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'token_endpoint_auth_method must be one of client_secret_basic, client_secret_post, none',
        ),
      );
    });

    it('should reject a non-string token_endpoint_auth_method', () => {
      expect(() =>
        validateClientRegistrationRequest(
          body({ ...MINIMAL, token_endpoint_auth_method: ['client_secret_basic'] }),
        ),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'token_endpoint_auth_method must be one of client_secret_basic, client_secret_post, none',
        ),
      );
    });
  });

  describe('grant_types', () => {
    it('should reject a grant type outside authorization_code and refresh_token', () => {
      expect(() =>
        validateClientRegistrationRequest(
          body({
            ...MINIMAL,
            grant_types: ['authorization_code', 'urn:ietf:params:oauth:grant-type:token-exchange'],
          }),
        ),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'grant_types must be an array containing only authorization_code and refresh_token',
        ),
      );
    });

    it('should reject a non-array grant_types', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ ...MINIMAL, grant_types: 'authorization_code' })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'grant_types must be an array containing only authorization_code and refresh_token',
        ),
      );
    });

    it('should reject refresh_token without authorization_code (RFC 7591 Section 2.1 consistency)', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ ...MINIMAL, grant_types: ['refresh_token'] })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'grant_types must include authorization_code',
        ),
      );
    });

    it('should reject an empty grant_types array', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ ...MINIMAL, grant_types: [] })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'grant_types must include authorization_code',
        ),
      );
    });
  });

  describe('response_types', () => {
    it('should reject a response type other than code', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ ...MINIMAL, response_types: ['token'] })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'response_types must be exactly ["code"]',
        ),
      );
    });

    it('should reject response_types with more than one entry', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ ...MINIMAL, response_types: ['code', 'code'] })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'response_types must be exactly ["code"]',
        ),
      );
    });
  });

  describe('client_name', () => {
    it('should accept a client_name of exactly 128 characters', () => {
      const name = 'a'.repeat(128);
      const validated = validateClientRegistrationRequest(
        body({ ...MINIMAL, client_name: name }),
      );
      expect(validated.clientName).toBe(name);
    });

    it('should reject a client_name of 129 characters', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ ...MINIMAL, client_name: 'a'.repeat(129) })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'client_name must be at most 128 characters',
        ),
      );
    });

    it('should reject a non-string client_name', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ ...MINIMAL, client_name: 42 })),
      ).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'client_name must be a string'),
      );
    });

    it('should reject a client_name containing a control character', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ ...MINIMAL, client_name: 'bad\nname' })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'client_name must not contain control or invisible formatting characters',
        ),
      );
    });

    it('should reject a client_name containing a C1 control character', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ ...MINIMAL, client_name: 'bad\u0085name' })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'client_name must not contain control or invisible formatting characters',
        ),
      );
    });

    // U+202E (RIGHT-TO-LEFT OVERRIDE) can reverse the rendered order of a
    // display name and disguise what the user approves.
    it('should reject a client_name containing a bidi override character', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ ...MINIMAL, client_name: 'bad\u202ename' })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'client_name must not contain control or invisible formatting characters',
        ),
      );
    });

    it('should reject a client_name containing a zero-width character', () => {
      expect(() =>
        validateClientRegistrationRequest(body({ ...MINIMAL, client_name: 'bad\u200bname' })),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'client_name must not contain control or invisible formatting characters',
        ),
      );
    });
  });
});

describe('ClientRegistrationError', () => {
  it('should carry the RFC 7591 error code and description as properties', () => {
    const error = new ClientRegistrationError('invalid_redirect_uri', 'fixed description');
    expect(error.error).toBe('invalid_redirect_uri');
    expect(error.errorDescription).toBe('fixed description');
    expect(error.message).toBe('fixed description');
    expect(error.name).toBe('ClientRegistrationError');
  });
});
