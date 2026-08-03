import { describe, it, expect, beforeAll } from 'vitest';
import { buildProviderMetadata, ProviderMetadataConfig } from './discovery.js';

let rsa256Key: CryptoKey;
let rsa384Key: CryptoKey;
let ec256Key: CryptoKey;

beforeAll(async () => {
  const rsa256 = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  rsa256Key = rsa256.privateKey;

  const rsa384 = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-384',
    },
    true,
    ['sign', 'verify'],
  );
  rsa384Key = rsa384.privateKey;

  const ec256 = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  ec256Key = ec256.privateKey;
});

function createValidConfig(overrides?: Partial<ProviderMetadataConfig>): ProviderMetadataConfig {
  return {
    issuer: 'https://example.com',
    authorizationEndpoint: 'https://example.com/authorize',
    tokenEndpoint: 'https://example.com/token',
    jwksUri: 'https://example.com/.well-known/jwks.json',
    responseTypesSupported: ['code'],
    subjectTypesSupported: ['public'],
    idTokenSigningKeys: [rsa256Key],
    ...overrides,
  };
}

describe('buildProviderMetadata', () => {
  describe('Required Fields', () => {
    it('should include issuer in the metadata', () => {
      const metadata = buildProviderMetadata(createValidConfig());
      expect(metadata.issuer).toEqual('https://example.com');
    });

    it('should include authorization_endpoint in the metadata', () => {
      const metadata = buildProviderMetadata(createValidConfig());
      expect(metadata.authorization_endpoint).toEqual('https://example.com/authorize');
    });

    it('should include token_endpoint in the metadata', () => {
      const metadata = buildProviderMetadata(createValidConfig());
      expect(metadata.token_endpoint).toEqual('https://example.com/token');
    });

    it('should include jwks_uri in the metadata', () => {
      const metadata = buildProviderMetadata(createValidConfig());
      expect(metadata.jwks_uri).toEqual('https://example.com/.well-known/jwks.json');
    });

    it('should include response_types_supported in the metadata', () => {
      const metadata = buildProviderMetadata(createValidConfig());
      expect(metadata.response_types_supported).toEqual(['code']);
    });

    it('should include subject_types_supported in the metadata', () => {
      const metadata = buildProviderMetadata(createValidConfig());
      expect(metadata.subject_types_supported).toEqual(['public']);
    });

    it('should derive id_token_signing_alg_values_supported from a single RS256 key', () => {
      const metadata = buildProviderMetadata(createValidConfig());
      expect(metadata.id_token_signing_alg_values_supported).toEqual(['RS256']);
    });

    it('should derive both algorithms when RS256 and ES256 keys are provided', () => {
      const metadata = buildProviderMetadata(
        createValidConfig({ idTokenSigningKeys: [rsa256Key, ec256Key] }),
      );
      // Set semantics: order is preserved by insertion, but we assert membership.
      expect(metadata.id_token_signing_alg_values_supported).toContain('RS256');
      expect(metadata.id_token_signing_alg_values_supported).toContain('ES256');
      expect(metadata.id_token_signing_alg_values_supported).toHaveLength(2);
    });

    it('should deduplicate algorithms when two RS256 keys are provided', () => {
      const metadata = buildProviderMetadata(
        createValidConfig({ idTokenSigningKeys: [rsa256Key, rsa256Key] }),
      );
      expect(metadata.id_token_signing_alg_values_supported).toEqual(['RS256']);
    });

    it('should throw when issuer is missing', () => {
      const config = createValidConfig({ issuer: '' });
      expect(() => buildProviderMetadata(config)).toThrow();
    });

    it('should throw when authorization_endpoint is missing', () => {
      const config = createValidConfig({ authorizationEndpoint: '' });
      expect(() => buildProviderMetadata(config)).toThrow();
    });

    it('should throw when token_endpoint is missing', () => {
      const config = createValidConfig({ tokenEndpoint: '' });
      expect(() => buildProviderMetadata(config)).toThrow();
    });

    it('should throw when jwks_uri is missing', () => {
      const config = createValidConfig({ jwksUri: '' });
      expect(() => buildProviderMetadata(config)).toThrow();
    });

    it('should throw when response_types_supported is empty', () => {
      const config = createValidConfig({ responseTypesSupported: [] });
      expect(() => buildProviderMetadata(config)).toThrow();
    });

    it('should throw when subject_types_supported is empty', () => {
      const config = createValidConfig({ subjectTypesSupported: [] });
      expect(() => buildProviderMetadata(config)).toThrow();
    });

    it('should throw when idTokenSigningKeys is empty', () => {
      const config = createValidConfig({ idTokenSigningKeys: [] });
      expect(() => buildProviderMetadata(config)).toThrow();
    });

    it('should throw when key set lacks an RS256 key (ES256 only)', () => {
      const config = createValidConfig({ idTokenSigningKeys: [ec256Key] });
      expect(() => buildProviderMetadata(config)).toThrow();
    });

    it('should throw when key set has only RSA keys with non-SHA-256 hash', () => {
      const config = createValidConfig({ idTokenSigningKeys: [rsa384Key] });
      expect(() => buildProviderMetadata(config)).toThrow();
    });
  });

  describe('Issuer Validation', () => {
    it('should throw when issuer uses http scheme (non-localhost)', () => {
      const config = createValidConfig({ issuer: 'http://example.com' });
      expect(() => buildProviderMetadata(config)).toThrow();
    });

    it('should allow issuer with localhost for development', () => {
      const config = createValidConfig({ issuer: 'http://localhost:3000' });
      expect(() => buildProviderMetadata(config)).not.toThrow();
    });

    it('should allow issuer with any IPv4 loopback address for development', () => {
      const config = createValidConfig({ issuer: 'http://127.0.0.2:3000' });
      expect(() => buildProviderMetadata(config)).not.toThrow();
    });

    it('should throw when issuer contains query parameters', () => {
      const config = createValidConfig({ issuer: 'https://example.com?foo=bar' });
      expect(() => buildProviderMetadata(config)).toThrow();
    });

    it('should throw when issuer contains fragment', () => {
      const config = createValidConfig({ issuer: 'https://example.com#section' });
      expect(() => buildProviderMetadata(config)).toThrow();
    });

    it('should allow issuer with path component', () => {
      const config = createValidConfig({
        issuer: 'https://example.com/op',
        authorizationEndpoint: 'https://example.com/op/authorize',
        tokenEndpoint: 'https://example.com/op/token',
        jwksUri: 'https://example.com/op/jwks',
      });
      const metadata = buildProviderMetadata(config);
      expect(metadata.issuer).toEqual('https://example.com/op');
    });
  });

  describe('Recommended Fields', () => {
    it('should include userinfo_endpoint when provided', () => {
      const config = createValidConfig({ userinfoEndpoint: 'https://example.com/userinfo' });
      const metadata = buildProviderMetadata(config);
      expect(metadata.userinfo_endpoint).toEqual('https://example.com/userinfo');
    });

    it('should omit userinfo_endpoint when not provided', () => {
      const config = createValidConfig();
      const metadata = buildProviderMetadata(config);
      expect(metadata.userinfo_endpoint).toBeUndefined();
    });

    it('should include scopes_supported when provided', () => {
      const config = createValidConfig({ scopesSupported: ['openid', 'profile', 'email'] });
      const metadata = buildProviderMetadata(config);
      expect(metadata.scopes_supported).toEqual(['openid', 'profile', 'email']);
    });

    it('should include claims_supported when provided', () => {
      const config = createValidConfig({ claimsSupported: ['sub', 'iss', 'name', 'email'] });
      const metadata = buildProviderMetadata(config);
      expect(metadata.claims_supported).toEqual(['sub', 'iss', 'name', 'email']);
    });

    // OIDC Discovery 1.0 §3 / Core 1.0 §5.6: this OP supports Normal Claims only.
    it('should omit claim_types_supported when not provided', () => {
      const metadata = buildProviderMetadata(createValidConfig());
      expect(metadata.claim_types_supported).toBeUndefined();
    });

    it('should include claim_types_supported as ["normal"] when provided', () => {
      const config = createValidConfig({ claimTypesSupported: ['normal'] });
      const metadata = buildProviderMetadata(config);
      expect(metadata.claim_types_supported).toEqual(['normal']);
    });

    it('should reject claim_types_supported values other than normal', () => {
      const config = createValidConfig({ claimTypesSupported: ['distributed'] });
      expect(() => buildProviderMetadata(config)).toThrow(
        "Unsupported claim_types_supported value(s): distributed. Only 'normal' is supported.",
      );
    });

    it('should include registration_endpoint when provided', () => {
      const config = createValidConfig({ registrationEndpoint: 'https://example.com/register' });
      const metadata = buildProviderMetadata(config);
      expect(metadata.registration_endpoint).toEqual('https://example.com/register');
    });

    // OIDC Discovery 1.0 Section 3 / Core 5.3.2:
    // userinfo_signing_alg_values_supported advertises the algorithms that the OP
    // can sign UserInfo responses with (used when userinfo_signed_response_alg
    // is set on the client).
    it('should include userinfo_signing_alg_values_supported when provided', () => {
      const config = createValidConfig({
        userinfoSigningAlgValuesSupported: ['RS256', 'none'],
      });
      const metadata = buildProviderMetadata(config);
      expect(metadata.userinfo_signing_alg_values_supported).toEqual(['RS256', 'none']);
    });

    it('should omit userinfo_signing_alg_values_supported when not provided', () => {
      const config = createValidConfig();
      const metadata = buildProviderMetadata(config);
      expect(metadata.userinfo_signing_alg_values_supported).toBeUndefined();
    });

    it('should omit userinfo_signing_alg_values_supported when empty array', () => {
      const config = createValidConfig({ userinfoSigningAlgValuesSupported: [] });
      const metadata = buildProviderMetadata(config);
      expect(metadata.userinfo_signing_alg_values_supported).toBeUndefined();
    });
  });

  describe('Optional Fields', () => {
    it('should include grant_types_supported when provided', () => {
      const config = createValidConfig({ grantTypesSupported: ['authorization_code'] });
      const metadata = buildProviderMetadata(config);
      expect(metadata.grant_types_supported).toEqual(['authorization_code']);
    });

    it('should include token_endpoint_auth_methods_supported when provided', () => {
      const config = createValidConfig({
        tokenEndpointAuthMethodsSupported: ['client_secret_basic', 'client_secret_post'],
      });
      const metadata = buildProviderMetadata(config);
      expect(metadata.token_endpoint_auth_methods_supported).toEqual([
        'client_secret_basic',
        'client_secret_post',
      ]);
    });

    // OAuth 2.1 §2.4 / RFC 8414 §2: `none` advertises that public clients are
    // accepted at the token endpoint (no client authentication).
    it('should include none in token_endpoint_auth_methods_supported for public clients', () => {
      const config = createValidConfig({
        tokenEndpointAuthMethodsSupported: ['client_secret_basic', 'client_secret_post', 'none'],
      });
      const metadata = buildProviderMetadata(config);
      expect(metadata.token_endpoint_auth_methods_supported).toEqual([
        'client_secret_basic',
        'client_secret_post',
        'none',
      ]);
    });

    it('should include response_modes_supported when provided', () => {
      const config = createValidConfig({ responseModesSupported: ['query'] });
      const metadata = buildProviderMetadata(config);
      expect(metadata.response_modes_supported).toEqual(['query']);
    });

    it('should include claims_parameter_supported when true', () => {
      const config = createValidConfig({ claimsParameterSupported: true });
      const metadata = buildProviderMetadata(config);
      expect(metadata.claims_parameter_supported).toEqual(true);
    });

    it('should include request_parameter_supported when true', () => {
      const config = createValidConfig({ requestParameterSupported: true });
      const metadata = buildProviderMetadata(config);
      expect(metadata.request_parameter_supported).toEqual(true);
    });

    it('should include request_uri_parameter_supported when provided', () => {
      const config = createValidConfig({ requestUriParameterSupported: false });
      const metadata = buildProviderMetadata(config);
      expect(metadata.request_uri_parameter_supported).toEqual(false);
    });

    // OIDC Discovery 1.0 §3: advertise the signing algs accepted for signed
    // Request Objects when request_parameter_supported is true.
    it('should include request_object_signing_alg_values_supported when provided', () => {
      const config = createValidConfig({
        requestObjectSigningAlgValuesSupported: ['RS256'],
      });
      const metadata = buildProviderMetadata(config);
      expect(metadata.request_object_signing_alg_values_supported).toEqual([
        'RS256',
      ]);
    });

    it('should omit request_object_signing_alg_values_supported when the list is empty', () => {
      const config = createValidConfig({
        requestObjectSigningAlgValuesSupported: [],
      });
      const metadata = buildProviderMetadata(config);
      expect(
        metadata.request_object_signing_alg_values_supported,
      ).toBeUndefined();
    });

    it('should omit optional boolean fields when not provided', () => {
      const config = createValidConfig();
      const metadata = buildProviderMetadata(config);
      expect(metadata.claims_parameter_supported).toBeUndefined();
      expect(metadata.request_parameter_supported).toBeUndefined();
      expect(metadata.request_uri_parameter_supported).toBeUndefined();
      expect(
        metadata.request_object_signing_alg_values_supported,
      ).toBeUndefined();
    });
  });

  // RFC 9207 §3: Authorization Servers that support the issuer identifier in
  // authorization responses MUST advertise it via
  // authorization_response_iss_parameter_supported in the discovery document.
  describe('RFC 9207 — Issuer Identification', () => {
    it('should include authorization_response_iss_parameter_supported when true', () => {
      const config = createValidConfig({
        authorizationResponseIssParameterSupported: true,
      });
      const metadata = buildProviderMetadata(config);
      expect(metadata.authorization_response_iss_parameter_supported).toEqual(true);
    });

    it('should include authorization_response_iss_parameter_supported when false', () => {
      const config = createValidConfig({
        authorizationResponseIssParameterSupported: false,
      });
      const metadata = buildProviderMetadata(config);
      expect(metadata.authorization_response_iss_parameter_supported).toEqual(false);
    });

    it('should omit authorization_response_iss_parameter_supported when not provided', () => {
      const config = createValidConfig();
      const metadata = buildProviderMetadata(config);
      expect(metadata.authorization_response_iss_parameter_supported).toBeUndefined();
    });
  });

  // RFC 8414 (OAuth 2.0 Authorization Server Metadata):
  // introspection_endpoint / revocation_endpoint and their *_auth_methods_supported
  // are advertised here even though OIDC Discovery 1.0 itself does not define them,
  // because the major IdPs and security tooling expect them on this document.
  describe('RFC 8414 Endpoints', () => {
    it('should include introspection_endpoint when provided', () => {
      const metadata = buildProviderMetadata(
        createValidConfig({ introspectionEndpoint: 'https://example.com/introspect' }),
      );
      expect(metadata.introspection_endpoint).toEqual('https://example.com/introspect');
    });

    it('should omit introspection_endpoint when not provided', () => {
      const metadata = buildProviderMetadata(createValidConfig());
      expect(metadata.introspection_endpoint).toBeUndefined();
    });

    it('should include introspection_endpoint_auth_methods_supported when provided', () => {
      const metadata = buildProviderMetadata(
        createValidConfig({
          introspectionEndpointAuthMethodsSupported: ['client_secret_basic'],
        }),
      );
      expect(metadata.introspection_endpoint_auth_methods_supported).toEqual([
        'client_secret_basic',
      ]);
    });

    it('should omit introspection_endpoint_auth_methods_supported when empty', () => {
      const metadata = buildProviderMetadata(
        createValidConfig({ introspectionEndpointAuthMethodsSupported: [] }),
      );
      expect(metadata.introspection_endpoint_auth_methods_supported).toBeUndefined();
    });

    it('should include revocation_endpoint when provided', () => {
      const metadata = buildProviderMetadata(
        createValidConfig({ revocationEndpoint: 'https://example.com/revoke' }),
      );
      expect(metadata.revocation_endpoint).toEqual('https://example.com/revoke');
    });

    it('should omit revocation_endpoint when not provided', () => {
      const metadata = buildProviderMetadata(createValidConfig());
      expect(metadata.revocation_endpoint).toBeUndefined();
    });

    it('should include revocation_endpoint_auth_methods_supported when provided', () => {
      const metadata = buildProviderMetadata(
        createValidConfig({
          revocationEndpointAuthMethodsSupported: ['client_secret_basic', 'client_secret_post'],
        }),
      );
      expect(metadata.revocation_endpoint_auth_methods_supported).toEqual([
        'client_secret_basic',
        'client_secret_post',
      ]);
    });

    it('should omit revocation_endpoint_auth_methods_supported when empty', () => {
      const metadata = buildProviderMetadata(
        createValidConfig({ revocationEndpointAuthMethodsSupported: [] }),
      );
      expect(metadata.revocation_endpoint_auth_methods_supported).toBeUndefined();
    });
  });

  describe('Array Handling', () => {
    it('should omit optional array fields with zero elements', () => {
      // Per OIDC Discovery spec: "Arrays with zero elements MUST be omitted"
      const config = createValidConfig({ scopesSupported: [] });
      const metadata = buildProviderMetadata(config);
      expect(metadata.scopes_supported).toBeUndefined();
    });

    it('should omit claims_supported when empty array', () => {
      const config = createValidConfig({ claimsSupported: [] });
      const metadata = buildProviderMetadata(config);
      expect(metadata.claims_supported).toBeUndefined();
    });
  });

  describe('Metadata Serialization', () => {
    it('should produce a JSON-serializable object', () => {
      const config = createValidConfig({
        userinfoEndpoint: 'https://example.com/userinfo',
        scopesSupported: ['openid', 'profile'],
        claimsSupported: ['sub', 'name'],
      });
      const metadata = buildProviderMetadata(config);
      expect(() => JSON.stringify(metadata)).not.toThrow();
    });

    it('should not include undefined values when serialized to JSON', () => {
      const config = createValidConfig();
      const metadata = buildProviderMetadata(config);
      const json = JSON.parse(JSON.stringify(metadata));
      for (const value of Object.values(json)) {
        expect(value).not.toBeUndefined();
      }
    });
  });
});
