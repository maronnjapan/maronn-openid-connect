import { describe, expect, it } from 'vitest';
import { ClientRegistrationError, isClientRegistrationError } from './registration-error.js';
import {
  parseClientRegistrationBody,
  validateClientMetadata,
  validateClientRegistrationRequest,
} from './registration-request.js';
import { generateTestRs256Key } from './test-helpers.js';

function body(metadata: Record<string, unknown>): string {
  return JSON.stringify(metadata);
}

const MINIMAL = { redirect_uris: ['https://app.example.com/cb'] };

/**
 * 既定値だけが適用された最小登録の検証結果。RFC 7591 §2 の 3 つの既定値と、
 * OIDC Dynamic Client Registration 1.0 §2 の application_type（web）と
 * id_token_signed_response_alg（RS256）は、登録メタデータとして応答に現れる。
 */
const MINIMAL_VALIDATED = {
  redirectUris: ['https://app.example.com/cb'],
  tokenEndpointAuthMethod: 'client_secret_basic',
  grantTypes: ['authorization_code'],
  responseTypes: ['code'],
  applicationType: 'web',
  idTokenSignedResponseAlg: 'RS256',
  metadata: {
    redirect_uris: ['https://app.example.com/cb'],
    token_endpoint_auth_method: 'client_secret_basic',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    application_type: 'web',
    id_token_signed_response_alg: 'RS256',
  },
};

describe('parseClientRegistrationBody', () => {
  describe('request body shape', () => {
    it('should return the metadata of a JSON object body', () => {
      expect(parseClientRegistrationBody(body(MINIMAL))).toEqual({ metadata: MINIMAL });
    });

    it('should reject a body that is not valid JSON', () => {
      expect(() => parseClientRegistrationBody('not json')).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'request body must be valid JSON'),
      );
    });

    it('should reject a JSON array body', () => {
      expect(() => parseClientRegistrationBody('[]')).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'request body must be a JSON object'),
      );
    });

    it('should reject a JSON primitive body', () => {
      expect(() => parseClientRegistrationBody('"redirect_uris"')).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'request body must be a JSON object'),
      );
    });

    it('should reject a JSON null body', () => {
      expect(() => parseClientRegistrationBody('null')).toThrowError(
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
      const { metadata } = parseClientRegistrationBody(rawBody, { maxBodyBytes: limit });
      expect(metadata['client_name']).toBe('あ'.repeat(multiByteChars));
    });

    it('should reject a body one byte over the limit', () => {
      const fixedBytes = new TextEncoder().encode(base + suffix).length;
      const multiByteChars = 8;
      const limit = fixedBytes + multiByteChars * 3 - 1;
      const rawBody = base + 'あ'.repeat(multiByteChars) + suffix;
      expect(() => parseClientRegistrationBody(rawBody, { maxBodyBytes: limit })).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'request body must not exceed the configured maximum size',
        ),
      );
    });
  });

  describe('software_statement (RFC 7591 Section 2.3)', () => {
    it('should split the software_statement from the plain metadata', () => {
      const parsed = parseClientRegistrationBody(
        body({ ...MINIMAL, software_statement: 'eyJhbGciOiJSUzI1NiJ9.e30.sig' }),
      );
      expect(parsed).toEqual({
        metadata: MINIMAL,
        softwareStatement: 'eyJhbGciOiJSUzI1NiJ9.e30.sig',
      });
    });

    // RFC 7591 §3.1.1 defines the member as a JWT string; its content is for the verifier of the OP.
    it('should reject a software_statement that is not a string with invalid_software_statement', () => {
      expect(() => parseClientRegistrationBody(body({ ...MINIMAL, software_statement: { iss: 'x' } }))).toThrowError(
        new ClientRegistrationError('invalid_software_statement', 'software_statement must be a string'),
      );
    });

    it('should hand any string through unexamined, an empty one included', () => {
      expect(parseClientRegistrationBody(body({ ...MINIMAL, software_statement: '' }))).toEqual({
        metadata: MINIMAL,
        softwareStatement: '',
      });
      expect(parseClientRegistrationBody(body({ ...MINIMAL, software_statement: 'not-a-jwt' }))).toEqual({
        metadata: MINIMAL,
        softwareStatement: 'not-a-jwt',
      });
    });
  });

  it('should copy the own properties of the body instead of returning the parsed object', () => {
    const parsed = parseClientRegistrationBody(
      '{"redirect_uris":["https://app.example.com/cb"],"__proto__":{"polluted":true}}',
    );
    expect(Object.getPrototypeOf(parsed.metadata)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBe(undefined);
  });
});

describe('validateClientMetadata', () => {
  describe('defaults (RFC 7591 Section 2)', () => {
    it('should apply every default to a minimal registration', () => {
      expect(validateClientMetadata(MINIMAL)).toEqual(MINIMAL_VALIDATED);
    });

    it('should keep every explicitly registered value and echo it in the metadata', () => {
      const validated = validateClientMetadata({
        redirect_uris: ['https://app.example.com/cb', 'http://127.0.0.1:8080/cb'],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'My Test App',
      });
      expect(validated).toEqual({
        redirectUris: ['https://app.example.com/cb', 'http://127.0.0.1:8080/cb'],
        tokenEndpointAuthMethod: 'client_secret_post',
        grantTypes: ['authorization_code', 'refresh_token'],
        responseTypes: ['code'],
        applicationType: 'web',
        idTokenSignedResponseAlg: 'RS256',
        metadata: {
          redirect_uris: ['https://app.example.com/cb', 'http://127.0.0.1:8080/cb'],
          token_endpoint_auth_method: 'client_secret_post',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          application_type: 'web',
          client_name: 'My Test App',
          id_token_signed_response_alg: 'RS256',
        },
      });
    });

    it('should normalize duplicated grant_types values to one entry, keeping their order', () => {
      const validated = validateClientMetadata({
        ...MINIMAL,
        grant_types: ['refresh_token', 'authorization_code', 'refresh_token'],
      });
      expect(validated.grantTypes).toEqual(['refresh_token', 'authorization_code']);
    });
  });

  describe('unknown metadata (RFC 7591 Section 2 MUST ignore)', () => {
    it('should silently drop metadata this provider does not understand', () => {
      const validated = validateClientMetadata({
        ...MINIMAL,
        jwks_uri: 'https://app.example.com/jwks.json',
        sector_identifier_uri: 'https://app.example.com/redirect_uris.json',
        require_auth_time: true,
      });
      expect(validated).toEqual(MINIMAL_VALIDATED);
    });

    it('should drop __proto__ and constructor keys as unknown metadata without polluting the result', () => {
      const validated = validateClientMetadata(
        JSON.parse(
          '{"redirect_uris":["https://app.example.com/cb"],"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
        ) as Record<string, unknown>,
      );
      expect(validated).toEqual(MINIMAL_VALIDATED);
      expect(Object.getPrototypeOf(validated)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(validated.metadata)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>)['polluted']).toBe(undefined);
    });
  });

  describe('redirect_uris (OIDC Dynamic Client Registration 1.0 Section 2 REQUIRED)', () => {
    it('should reject a registration without redirect_uris', () => {
      expect(() => validateClientMetadata({})).toThrowError(
        new ClientRegistrationError('invalid_redirect_uri', 'redirect_uris must be a non-empty array of strings'),
      );
    });

    it('should reject an empty redirect_uris array', () => {
      expect(() => validateClientMetadata({ redirect_uris: [] })).toThrowError(
        new ClientRegistrationError('invalid_redirect_uri', 'redirect_uris must be a non-empty array of strings'),
      );
    });

    it('should reject a redirect_uris array with a non-string element', () => {
      expect(() => validateClientMetadata({ redirect_uris: ['https://a.example', 1] })).toThrowError(
        new ClientRegistrationError('invalid_redirect_uri', 'redirect_uris must be a non-empty array of strings'),
      );
    });

    it.each([
      ['a fragment component', 'https://app.example.com/cb#fragment'],
      ['a javascript: scheme', 'javascript:alert(1)'],
      ['a non-loopback plain http scheme', 'http://app.example.com/cb'],
    ])('should reject a redirect_uri with %s without reflecting it', (_label, uri) => {
      expect(() => validateClientMetadata({ redirect_uris: [uri] })).toThrowError(
        new ClientRegistrationError(
          'invalid_redirect_uri',
          'each redirect_uri must be an absolute URI without a fragment and must not use a dangerous scheme or non-loopback http',
        ),
      );
    });

    it('should accept mixed loopback http and https redirect_uris', () => {
      const validated = validateClientMetadata({
        redirect_uris: [
          'http://localhost:3000/cb',
          'http://127.0.0.1/cb',
          'http://[::1]:8080/cb',
          'https://app.example.com/cb',
        ],
      });
      expect(validated.redirectUris).toEqual([
        'http://localhost:3000/cb',
        'http://127.0.0.1/cb',
        'http://[::1]:8080/cb',
        'https://app.example.com/cb',
      ]);
    });

    // RFC 8252 §7.1: native apps register private-use (custom) URI schemes.
    it('should accept a private-use scheme redirect_uri', () => {
      const validated = validateClientMetadata({ redirect_uris: ['com.example.app:/oauth2redirect'] });
      expect(validated.redirectUris).toEqual(['com.example.app:/oauth2redirect']);
    });
  });

  describe('token_endpoint_auth_method', () => {
    it('should accept none and keep it', () => {
      const validated = validateClientMetadata({ ...MINIMAL, token_endpoint_auth_method: 'none' });
      expect(validated.tokenEndpointAuthMethod).toBe('none');
    });

    it('should reject a method outside the default three, such as private_key_jwt', () => {
      expect(() =>
        validateClientMetadata({ ...MINIMAL, token_endpoint_auth_method: 'private_key_jwt' }),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'token_endpoint_auth_method must be one of client_secret_basic, client_secret_post, none',
        ),
      );
    });

    it('should reject a non-string token_endpoint_auth_method', () => {
      expect(() =>
        validateClientMetadata({ ...MINIMAL, token_endpoint_auth_method: ['client_secret_basic'] }),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'token_endpoint_auth_method must be one of client_secret_basic, client_secret_post, none',
        ),
      );
    });

    it('should accept a method the tokenEndpointAuthMethods option adds', () => {
      const validated = validateClientMetadata(
        { ...MINIMAL, token_endpoint_auth_method: 'private_key_jwt' },
        { tokenEndpointAuthMethods: ['client_secret_basic', 'private_key_jwt'] },
      );
      expect(validated.tokenEndpointAuthMethod).toBe('private_key_jwt');
      expect(validated.metadata['token_endpoint_auth_method']).toBe('private_key_jwt');
    });

    it('should list the configured methods in the error of a method the option leaves out', () => {
      expect(() =>
        validateClientMetadata(
          { ...MINIMAL, token_endpoint_auth_method: 'none' },
          { tokenEndpointAuthMethods: ['client_secret_basic'] },
        ),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'token_endpoint_auth_method must be one of client_secret_basic',
        ),
      );
    });
  });

  describe('grant_types', () => {
    it('should reject a grant type outside the default authorization_code and refresh_token', () => {
      expect(() =>
        validateClientMetadata({
          ...MINIMAL,
          grant_types: ['authorization_code', 'urn:ietf:params:oauth:grant-type:token-exchange'],
        }),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'grant_types must be an array containing only authorization_code, refresh_token',
        ),
      );
    });

    it('should reject a non-array grant_types', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, grant_types: 'authorization_code' })).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'grant_types must be an array containing only authorization_code, refresh_token',
        ),
      );
    });

    it('should accept a grant type the grantTypes option adds', () => {
      const validated = validateClientMetadata(
        { ...MINIMAL, grant_types: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code'] },
        { grantTypes: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code'] },
      );
      expect(validated.grantTypes).toEqual(['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code']);
    });
  });

  describe('response_types', () => {
    it('should reject a response type this provider does not support', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, response_types: ['token'] })).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'response_types must be a non-empty array containing only code',
        ),
      );
    });

    it('should reject an empty response_types array', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, response_types: [] })).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'response_types must be a non-empty array containing only code',
        ),
      );
    });

    it('should normalize duplicated response_types values to one entry', () => {
      const validated = validateClientMetadata({ ...MINIMAL, response_types: ['code', 'code'] });
      expect(validated.responseTypes).toEqual(['code']);
    });

    // OAuth 2.0 Multiple Response Type Encoding Practices §1.2: the order of the
    // values of a response_type does not matter.
    it('should accept the response types of the responseTypes option in any value order and normalize them', () => {
      const validated = validateClientMetadata(
        {
          ...MINIMAL,
          grant_types: ['authorization_code', 'implicit'],
          response_types: ['code', 'token id_token', 'code id_token'],
        },
        { grantTypes: ['authorization_code', 'implicit'], responseTypes: ['code', 'id_token token', 'code id_token'] },
      );
      expect(validated.responseTypes).toEqual(['code', 'id_token token', 'code id_token']);
      expect(validated.metadata['response_types']).toEqual(['code', 'id_token token', 'code id_token']);
    });
  });

  // RFC 7591 §2.1 / OIDC Dynamic Client Registration 1.0 §2: code pairs with
  // authorization_code, token and id_token pair with implicit.
  describe('consistency of grant_types and response_types (RFC 7591 Section 2.1)', () => {
    const inconsistent = new ClientRegistrationError(
      'invalid_client_metadata',
      'grant_types and response_types must be consistent: code requires authorization_code, token and id_token require implicit',
    );
    const implicitOptions = { grantTypes: ['authorization_code', 'refresh_token', 'implicit'], responseTypes: ['code', 'id_token', 'id_token token', 'code id_token'] };

    it('should reject refresh_token without authorization_code while response_types defaults to code', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, grant_types: ['refresh_token'] })).toThrowError(inconsistent);
    });

    it('should reject an empty grant_types array', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, grant_types: [] })).toThrowError(inconsistent);
    });

    it('should reject an implicit response type while grant_types defaults to authorization_code', () => {
      expect(() =>
        validateClientMetadata({ ...MINIMAL, response_types: ['id_token'] }, implicitOptions),
      ).toThrowError(inconsistent);
    });

    it('should reject the implicit grant without a token or id_token response type', () => {
      expect(() =>
        validateClientMetadata({ ...MINIMAL, grant_types: ['authorization_code', 'implicit'] }, implicitOptions),
      ).toThrowError(inconsistent);
    });

    it('should accept an implicit client registering implicit with id_token token', () => {
      const validated = validateClientMetadata(
        { ...MINIMAL, grant_types: ['implicit'], response_types: ['id_token token'] },
        implicitOptions,
      );
      expect(validated.grantTypes).toEqual(['implicit']);
      expect(validated.responseTypes).toEqual(['id_token token']);
    });

    it('should accept a hybrid client registering authorization_code and implicit with code id_token', () => {
      const validated = validateClientMetadata(
        { ...MINIMAL, grant_types: ['authorization_code', 'implicit'], response_types: ['code id_token'] },
        implicitOptions,
      );
      expect(validated.responseTypes).toEqual(['code id_token']);
    });
  });

  describe('client_name', () => {
    it('should accept a client_name of exactly 128 characters', () => {
      const name = 'a'.repeat(128);
      expect(validateClientMetadata({ ...MINIMAL, client_name: name }).metadata['client_name']).toBe(name);
    });

    it('should reject a client_name of 129 characters', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, client_name: 'a'.repeat(129) })).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'client_name must be at most 128 characters'),
      );
    });

    it('should reject a non-string client_name', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, client_name: 42 })).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'client_name must be a string'),
      );
    });

    it.each([
      ['a control character', 'bad\nname'],
      ['a C1 control character', 'bad\u0085name'],
      // U+202E (RIGHT-TO-LEFT OVERRIDE) can reverse the rendered order of a
      // display name and disguise what the user approves.
      ['a bidi override character', 'bad‮name'],
      ['a zero-width character', 'bad​name'],
    ])('should reject a client_name containing %s', (_label, name) => {
      expect(() => validateClientMetadata({ ...MINIMAL, client_name: name })).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'client_name must not contain control or invisible formatting characters',
        ),
      );
    });
  });

  describe('informational URLs (client_uri, logo_uri, tos_uri, policy_uri)', () => {
    it('should register absolute http and https URLs and echo them', () => {
      const validated = validateClientMetadata({
        ...MINIMAL,
        client_uri: 'https://app.example.com/',
        logo_uri: 'https://cdn.example.com/logo.png',
        tos_uri: 'https://app.example.com/tos',
        policy_uri: 'http://localhost:3000/privacy',
      });
      expect(validated.metadata).toMatchObject({
        client_uri: 'https://app.example.com/',
        logo_uri: 'https://cdn.example.com/logo.png',
        tos_uri: 'https://app.example.com/tos',
        policy_uri: 'http://localhost:3000/privacy',
      });
    });

    it.each([
      ['a relative URL', '/logo.png'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a data: URL', 'data:image/png;base64,AAAA'],
      ['a non-string value', 42],
      ['a URL with a control character', 'https://app.example.com/\u0000'],
    ])('should reject logo_uri that is %s without reflecting it', (_label, value) => {
      expect(() => validateClientMetadata({ ...MINIMAL, logo_uri: value })).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'logo_uri must be an absolute http or https URL'),
      );
    });
  });

  describe('contacts', () => {
    it('should register an array of contact strings', () => {
      const validated = validateClientMetadata({ ...MINIMAL, contacts: ['ops@example.com', 'dev@example.com'] });
      expect(validated.metadata['contacts']).toEqual(['ops@example.com', 'dev@example.com']);
    });

    it.each([
      ['a string instead of an array', 'ops@example.com'],
      ['an empty array', []],
    ])('should reject contacts that is %s', (_label, value) => {
      expect(() => validateClientMetadata({ ...MINIMAL, contacts: value })).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'contacts must be an array of 1 to 32 strings'),
      );
    });

    it('should reject a contact containing a control character', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, contacts: ['ops@example.com\n'] })).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'each contact must not contain control or invisible formatting characters',
        ),
      );
    });
  });

  describe('scope (RFC 7591 Section 2 / RFC 6749 Section 3.3)', () => {
    it('should register the scope values from a space-delimited scope string', () => {
      const validated = validateClientMetadata({ ...MINIMAL, scope: 'openid profile' });
      expect(validated.scope).toEqual(['openid', 'profile']);
      expect(validated.metadata['scope']).toBe('openid profile');
    });

    it('should omit the scope key when scope is not provided', () => {
      const validated = validateClientMetadata(MINIMAL);
      expect(Object.hasOwn(validated, 'scope')).toBe(false);
      expect(Object.hasOwn(validated.metadata, 'scope')).toBe(false);
    });

    it('should deduplicate repeated scope values', () => {
      const validated = validateClientMetadata({ ...MINIMAL, scope: 'openid openid profile' });
      expect(validated.scope).toEqual(['openid', 'profile']);
      expect(validated.metadata['scope']).toBe('openid profile');
    });

    it.each([
      ['a non-string value', ['openid']],
      ['an empty string', ''],
      ['two spaces in a row', 'openid  profile'],
      ['a double quote', 'open"id'],
      ['a backslash', 'open\\id'],
      ['a control character', 'openid\tprofile'],
    ])('should reject scope that is %s with invalid_client_metadata', (_label, value) => {
      expect(() => validateClientMetadata({ ...MINIMAL, scope: value })).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'scope must be a space-delimited string of scope values',
        ),
      );
    });

    it('should accept any syntactically valid scope when the scopes option is not provided', () => {
      const validated = validateClientMetadata({ ...MINIMAL, scope: 'openid reports.read' });
      expect(validated.scope).toEqual(['openid', 'reports.read']);
    });

    it('should reject a scope value outside the scopes option', () => {
      expect(() =>
        validateClientMetadata({ ...MINIMAL, scope: 'openid reports.read' }, { scopes: ['openid', 'profile'] }),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'scope must contain only scope values this provider supports',
        ),
      );
    });
  });

  describe('software_id and software_version', () => {
    it('should register both strings', () => {
      const validated = validateClientMetadata({
        ...MINIMAL,
        software_id: '4NRB1-0XZABZI9E6-5SM3R',
        software_version: '2.0.1',
      });
      expect(validated.metadata).toMatchObject({ software_id: '4NRB1-0XZABZI9E6-5SM3R', software_version: '2.0.1' });
    });

    it('should reject a software_version over 64 characters', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, software_version: 'v'.repeat(65) })).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'software_version must be at most 64 characters'),
      );
    });

    it('should reject a non-string software_id', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, software_id: 1 })).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'software_id must be a string'),
      );
    });
  });

  describe('application_type (OIDC Dynamic Client Registration 1.0 Section 2)', () => {
    // §2: the default, if omitted, is web; §3.2: a default the AS applied is
    // part of the registered metadata it returns.
    it('should default application_type to web and register the default', () => {
      const validated = validateClientMetadata(MINIMAL);
      expect(validated.applicationType).toBe('web');
      expect(validated.metadata['application_type']).toBe('web');
    });

    it('should reject a null application_type instead of treating it as omitted', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, application_type: null })).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'application_type must be web or native'),
      );
    });

    it('should register web and native', () => {
      expect(validateClientMetadata({ ...MINIMAL, application_type: 'web' }).metadata['application_type']).toBe('web');
      expect(
        validateClientMetadata({ redirect_uris: ['com.example.app:/cb'], application_type: 'native' }).metadata[
          'application_type'
        ],
      ).toBe('native');
    });

    it('should reject another value', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, application_type: 'desktop' })).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'application_type must be web or native'),
      );
    });

    it('should let a native client register custom scheme and loopback http redirect_uris', () => {
      const validated = validateClientMetadata({
        redirect_uris: ['com.example.app:/cb', 'http://127.0.0.1:8080/cb', 'http://localhost/cb', 'http://[::1]/cb'],
        application_type: 'native',
      });
      expect(validated.redirectUris).toEqual([
        'com.example.app:/cb',
        'http://127.0.0.1:8080/cb',
        'http://localhost/cb',
        'http://[::1]/cb',
      ]);
    });

    it('should reject an https redirect_uri of a native client', () => {
      expect(() =>
        validateClientMetadata({ redirect_uris: ['https://app.example.com/cb'], application_type: 'native' }),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'a native client must register custom scheme or loopback http redirect_uris only',
        ),
      );
    });

    it('should let a web client without the implicit grant register a loopback http redirect_uri', () => {
      const validated = validateClientMetadata({ redirect_uris: ['http://localhost:3000/cb'], application_type: 'web' });
      expect(validated.redirectUris).toEqual(['http://localhost:3000/cb']);
    });

    // §2: the AS MUST verify that all registered redirect_uris conform to the
    // constraints of the application type, so the omitted type is checked as web.
    it('should apply the web constraints to a registration that omits application_type and uses the implicit grant', () => {
      const options = { grantTypes: ['authorization_code', 'implicit'], responseTypes: ['code', 'id_token'] };
      const implicitClient = { grant_types: ['implicit'], response_types: ['id_token'] };

      const registered = validateClientMetadata(
        { redirect_uris: ['https://app.example.com/cb'], ...implicitClient },
        options,
      );
      expect(registered.metadata['application_type']).toBe('web');
      expect(() =>
        validateClientMetadata({ redirect_uris: ['http://127.0.0.1:8080/cb'], ...implicitClient }, options),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'a web client using the implicit grant must register https redirect_uris that do not use localhost',
        ),
      );
    });

    it('should reject a localhost redirect_uri of a web client using the implicit grant', () => {
      expect(() =>
        validateClientMetadata(
          {
            redirect_uris: ['http://localhost:3000/cb'],
            application_type: 'web',
            grant_types: ['implicit'],
            response_types: ['id_token'],
          },
          { grantTypes: ['authorization_code', 'implicit'], responseTypes: ['code', 'id_token'] },
        ),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'a web client using the implicit grant must register https redirect_uris that do not use localhost',
        ),
      );
    });
  });

  describe('default_max_age', () => {
    it('should register a non-negative integer', () => {
      const validated = validateClientMetadata({ ...MINIMAL, default_max_age: 3600 });
      expect(validated.defaultMaxAge).toBe(3600);
      expect(validated.metadata['default_max_age']).toBe(3600);
    });

    it.each([
      ['a string', '3600'],
      ['a negative number', -1],
      ['a fraction', 1.5],
    ])('should reject default_max_age that is %s', (_label, value) => {
      expect(() => validateClientMetadata({ ...MINIMAL, default_max_age: value })).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'default_max_age must be a non-negative integer'),
      );
    });
  });

  describe('id_token_signed_response_alg and userinfo_signed_response_alg', () => {
    // OIDC Dynamic Client Registration 1.0 §2: the default, if omitted, is
    // RS256; §3.2: the AS returns the defaults it applied. userinfo has no
    // default alg: an omitted value means an unsigned JSON response.
    it('should default id_token_signed_response_alg to RS256 and register the default', () => {
      const validated = validateClientMetadata(MINIMAL);
      expect(validated.idTokenSignedResponseAlg).toBe('RS256');
      expect(validated.metadata['id_token_signed_response_alg']).toBe('RS256');
      expect(validated.userinfoSignedResponseAlg).toBeUndefined();
      expect(Object.hasOwn(validated.metadata, 'userinfo_signed_response_alg')).toBe(false);
    });

    it('should reject the omitted id_token_signed_response_alg when the OP cannot sign RS256', () => {
      expect(() => validateClientMetadata(MINIMAL, { idTokenSigningAlgValuesSupported: ['ES256'] })).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'id_token_signed_response_alg must be one of ES256'),
      );
    });

    it('should accept RS256 by default and echo it', () => {
      const validated = validateClientMetadata({
        ...MINIMAL,
        id_token_signed_response_alg: 'RS256',
        userinfo_signed_response_alg: 'RS256',
      });
      expect(validated.idTokenSignedResponseAlg).toBe('RS256');
      expect(validated.userinfoSignedResponseAlg).toBe('RS256');
      expect(validated.metadata).toMatchObject({
        id_token_signed_response_alg: 'RS256',
        userinfo_signed_response_alg: 'RS256',
      });
    });

    it('should reject an alg outside the supported values', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, id_token_signed_response_alg: 'ES256' })).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'id_token_signed_response_alg must be one of RS256'),
      );
    });

    it('should accept an alg the option adds', () => {
      const validated = validateClientMetadata(
        { ...MINIMAL, userinfo_signed_response_alg: 'ES256' },
        { userinfoSigningAlgValuesSupported: ['RS256', 'ES256'] },
      );
      expect(validated.userinfoSignedResponseAlg).toBe('ES256');
    });

    // OIDC Dynamic Client Registration 1.0 §2: none is not an ID Token alg this OP issues.
    it('should reject none even when the option lists it', () => {
      expect(() =>
        validateClientMetadata(
          { ...MINIMAL, id_token_signed_response_alg: 'none' },
          { idTokenSigningAlgValuesSupported: ['RS256', 'none'] },
        ),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'id_token_signed_response_alg must be one of RS256, none',
        ),
      );
    });
  });

  describe('jwks (RFC 7591 Section 2)', () => {
    const jwksDescription =
      'jwks must be a JWK Set of 1 to 16 public RSA (RS256, RS384, RS512) or EC (P-256, P-384, P-521) signature keys';

    it('should register the public keys of a JWK Set and echo the normalized set', async () => {
      const key = await generateTestRs256Key('client-key-1');
      const validated = validateClientMetadata({ ...MINIMAL, jwks: key.jwks });
      expect(validated.jwks).toEqual({
        keys: [{ kty: 'RSA', kid: 'client-key-1', use: 'sig', alg: 'RS256', n: key.jwk.n, e: key.jwk.e }],
      });
      expect(validated.metadata['jwks']).toEqual(validated.jwks);
    });

    it('should default alg to RS256 for an RSA key and to the curve alg and use sig for an EC key', () => {
      const validated = validateClientMetadata({
        ...MINIMAL,
        jwks: {
          keys: [
            { kty: 'RSA', n: 'AQAB', e: 'AQAB', x5c: ['ignored'] },
            { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
          ],
        },
      });
      expect(validated.jwks).toEqual({
        keys: [
          { kty: 'RSA', use: 'sig', alg: 'RS256', n: 'AQAB', e: 'AQAB' },
          { kty: 'EC', use: 'sig', alg: 'ES256', crv: 'P-256', x: 'x', y: 'y' },
        ],
      });
    });

    it('should reject a JWK Set carrying a private key parameter', () => {
      expect(() =>
        validateClientMetadata({ ...MINIMAL, jwks: { keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', d: 'secret' }] } }),
      ).toThrowError(new ClientRegistrationError('invalid_client_metadata', 'jwks must contain public keys only'));
    });

    it.each([
      ['not an object', 'keys'],
      ['without a keys array', { keys: 'none' }],
      ['with an empty keys array', { keys: [] }],
      ['with an unsupported key type', { keys: [{ kty: 'oct', k: 'x' }] }],
      ['with an RSA key of an unsupported alg', { keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', alg: 'PS256' }] }],
      ['with an EC key on an unsupported curve', { keys: [{ kty: 'EC', crv: 'secp256k1', x: 'x', y: 'y' }] }],
      ['with an EC key whose alg does not match its curve', { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', alg: 'ES384' }] }],
      ['with an encryption key', { keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', use: 'enc' }] }],
    ])('should reject jwks %s', (_label, jwks) => {
      expect(() => validateClientMetadata({ ...MINIMAL, jwks })).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', jwksDescription),
      );
    });

    it('should reject a key whose kid contains a control character', () => {
      expect(() =>
        validateClientMetadata({ ...MINIMAL, jwks: { keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', kid: 'k\nid' }] } }),
      ).toThrowError(
        new ClientRegistrationError(
          'invalid_client_metadata',
          'kid of a jwks key must not contain control or invisible formatting characters',
        ),
      );
    });

    // RFC 7591 §2: jwks_uri and jwks MUST NOT both be present.
    it('should reject jwks together with jwks_uri', () => {
      expect(() =>
        validateClientMetadata({
          ...MINIMAL,
          jwks: { keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB' }] },
          jwks_uri: 'https://app.example.com/jwks.json',
        }),
      ).toThrowError(
        new ClientRegistrationError('invalid_client_metadata', 'jwks and jwks_uri must not both be present'),
      );
    });
  });

  describe('software_statement echo (RFC 7591 Section 3.2.1)', () => {
    it('should return a software_statement string the caller placed as registered metadata', () => {
      const validated = validateClientMetadata({ ...MINIMAL, software_statement: 'eyJhbGciOiJSUzI1NiJ9.e30.sig' });
      expect(validated.metadata['software_statement']).toBe('eyJhbGciOiJSUzI1NiJ9.e30.sig');
    });

    it('should reject a software_statement that is not a string', () => {
      expect(() => validateClientMetadata({ ...MINIMAL, software_statement: 1 })).toThrowError(
        new ClientRegistrationError('invalid_software_statement', 'software_statement must be a string'),
      );
    });
  });

  describe('custom metadata', () => {
    it('should register the value a custom validator returns and echo it', () => {
      const validated = validateClientMetadata(
        { ...MINIMAL, tenant_id: 'acme' },
        { customMetadata: { tenant_id: (value) => (typeof value === 'string' ? value.toUpperCase() : undefined) } },
      );
      expect(validated.metadata['tenant_id']).toBe('ACME');
    });

    it('should leave a custom field out when its validator returns undefined', () => {
      const validated = validateClientMetadata(MINIMAL, {
        customMetadata: { tenant_id: (value) => value },
      });
      expect(Object.hasOwn(validated.metadata, 'tenant_id')).toBe(false);
    });

    it('should register the default a custom validator returns for an absent field', () => {
      const validated = validateClientMetadata(MINIMAL, {
        customMetadata: { tier: (value) => value ?? 'free' },
      });
      expect(validated.metadata['tier']).toBe('free');
    });

    it('should hand the validator the whole request metadata', () => {
      const seen: unknown[] = [];
      validateClientMetadata(
        { ...MINIMAL, tenant_id: 'acme' },
        { customMetadata: { tenant_id: (value, metadata) => void seen.push(value, metadata) } },
      );
      expect(seen).toEqual(['acme', { ...MINIMAL, tenant_id: 'acme' }]);
    });

    it('should propagate the ClientRegistrationError a validator throws', () => {
      expect(() =>
        validateClientMetadata(
          { ...MINIMAL, tenant_id: 42 },
          {
            customMetadata: {
              tenant_id: () => {
                throw new ClientRegistrationError('invalid_client_metadata', 'tenant_id must be a string');
              },
            },
          },
        ),
      ).toThrowError(new ClientRegistrationError('invalid_client_metadata', 'tenant_id must be a string'));
    });

    it('should refuse a custom validator that redefines a standard field', () => {
      expect(() =>
        validateClientMetadata(MINIMAL, { customMetadata: { redirect_uris: (value) => value } }),
      ).toThrowError(new TypeError('custom client metadata must not redefine the standard field redirect_uris'));
    });
  });
});

describe('validateClientRegistrationRequest', () => {
  it('should parse and validate a body in one step', () => {
    expect(validateClientRegistrationRequest(body(MINIMAL))).toEqual(MINIMAL_VALIDATED);
  });

  it('should pass the body size limit through', () => {
    expect(() => validateClientRegistrationRequest(body(MINIMAL), { maxBodyBytes: 8 })).toThrowError(
      new ClientRegistrationError(
        'invalid_client_metadata',
        'request body must not exceed the configured maximum size',
      ),
    );
  });

  // RFC 7591 §3.1.1: an authorization server that does not support software
  // statements may ignore the member.
  it('should ignore a software_statement instead of echoing or verifying it', () => {
    const validated = validateClientRegistrationRequest(
      body({ ...MINIMAL, software_statement: 'eyJhbGciOiJSUzI1NiJ9.e30.sig' }),
    );
    expect(validated).toEqual(MINIMAL_VALIDATED);
  });
});

describe('ClientRegistrationError', () => {
  it('should carry the RFC 7591 error code and description as properties', () => {
    const error = new ClientRegistrationError('unapproved_software_statement', 'fixed description');
    expect(error.error).toBe('unapproved_software_statement');
    expect(error.errorDescription).toBe('fixed description');
    expect(error.message).toBe('fixed description');
    expect(error.name).toBe('ClientRegistrationError');
  });
});

describe('isClientRegistrationError', () => {
  it('should recognize an instance of the class', () => {
    expect(isClientRegistrationError(new ClientRegistrationError('invalid_client_metadata', 'd'))).toBe(true);
  });

  // A second copy of this package (another bundle of the generated code) builds
  // the same shape from another class; the response code must still be read.
  it('should recognize an error of the same shape from another copy of the package', () => {
    const error = Object.assign(new Error('d'), {
      name: 'ClientRegistrationError',
      error: 'invalid_software_statement',
      errorDescription: 'd',
    });
    expect(isClientRegistrationError(error)).toBe(true);
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['an error with the name but without the code', Object.assign(new Error('d'), { name: 'ClientRegistrationError' })],
    ['null', null],
    ['a string', 'ClientRegistrationError'],
  ])('should reject %s', (_label, value) => {
    expect(isClientRegistrationError(value)).toBe(false);
  });
});
