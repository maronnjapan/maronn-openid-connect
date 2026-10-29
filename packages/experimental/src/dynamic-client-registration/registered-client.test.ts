import { describe, expect, it } from 'vitest';
import {
  buildClientRegistrationResponse,
  buildRegisteredClient,
  type DynamicallyRegisteredClient,
} from './registered-client.js';
import type { ValidatedClientRegistration } from './registration-request.js';

const CONFIDENTIAL: ValidatedClientRegistration = {
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

const PUBLIC: ValidatedClientRegistration = {
  ...CONFIDENTIAL,
  tokenEndpointAuthMethod: 'none',
  metadata: { ...CONFIDENTIAL.metadata, token_endpoint_auth_method: 'none' },
};

const FIXED = { generateClientId: () => 'dcr-fixed', generateClientSecret: () => 'fixed-secret', now: () => 1_790_812_800_123 };

describe('buildRegisteredClient', () => {
  describe('issued values', () => {
    it('should mint a client_id with the dcr- prefix and a 22-character random part', () => {
      const client = buildRegisteredClient(CONFIDENTIAL);
      // 16 バイトの base64url は 22 文字（パディング無し）。
      expect(client.clientId).toMatch(/^dcr-[A-Za-z0-9_-]{22}$/);
    });

    it('should mint a 43-character base64url client_secret for a confidential client', () => {
      const client = buildRegisteredClient(CONFIDENTIAL);
      // 32 バイト（256 ビット）の base64url は 43 文字（パディング無し）。
      expect(client.clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(client.clientType).toBe('confidential');
    });

    it('should mint a different client_id and client_secret on every call', () => {
      const first = buildRegisteredClient(CONFIDENTIAL);
      const second = buildRegisteredClient(CONFIDENTIAL);
      expect(first.clientId).not.toBe(second.clientId);
      expect(first.clientSecret).not.toBe(second.clientSecret);
    });

    it('should use the injected generators and clock', () => {
      expect(buildRegisteredClient(CONFIDENTIAL, FIXED)).toEqual({
        clientId: 'dcr-fixed',
        clientSecret: 'fixed-secret',
        clientType: 'confidential',
        redirectUris: ['https://app.example.com/cb'],
        grantTypes: ['authorization_code'],
        responseTypes: ['code'],
        tokenEndpointAuthMethods: ['client_secret_basic'],
        idTokenSignedResponseAlg: 'RS256',
        clientIdIssuedAt: 1_790_812_800,
        metadata: CONFIDENTIAL.metadata,
      });
    });
  });

  describe('public clients (token_endpoint_auth_method none)', () => {
    it('should mark the client public and issue no client_secret', () => {
      const client = buildRegisteredClient(PUBLIC, FIXED);
      expect(client).toEqual({
        clientId: 'dcr-fixed',
        clientType: 'public',
        redirectUris: ['https://app.example.com/cb'],
        grantTypes: ['authorization_code'],
        responseTypes: ['code'],
        tokenEndpointAuthMethods: ['none'],
        idTokenSignedResponseAlg: 'RS256',
        clientIdIssuedAt: 1_790_812_800,
        metadata: PUBLIC.metadata,
      });
      expect(Object.hasOwn(client, 'clientSecret')).toBe(false);
    });
  });

  // RFC 7591 §2: a key-based method such as private_key_jwt authenticates
  // without a client_secret, so none is minted; the client stays confidential.
  describe('confidential clients without a secret', () => {
    it('should issue no client_secret for private_key_jwt', () => {
      const client = buildRegisteredClient(
        { ...CONFIDENTIAL, tokenEndpointAuthMethod: 'private_key_jwt' },
        FIXED,
      );
      expect(client.clientType).toBe('confidential');
      expect(Object.hasOwn(client, 'clientSecret')).toBe(false);
      expect(client.tokenEndpointAuthMethods).toEqual(['private_key_jwt']);
    });

    it('should issue a client_secret for a method the clientSecretAuthMethods option names', () => {
      const client = buildRegisteredClient(
        { ...CONFIDENTIAL, tokenEndpointAuthMethod: 'custom_secret_method' },
        { ...FIXED, clientSecretAuthMethods: ['custom_secret_method'] },
      );
      expect(client.clientSecret).toBe('fixed-secret');
    });
  });

  describe('registered metadata', () => {
    it('should carry scope, default_max_age, the signed response algs and jwks into the record', () => {
      const client = buildRegisteredClient(
        {
          ...CONFIDENTIAL,
          scope: ['openid', 'profile'],
          defaultMaxAge: 3600,
          idTokenSignedResponseAlg: 'RS256',
          userinfoSignedResponseAlg: 'ES256',
          jwks: { keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'AQAB', e: 'AQAB' }] },
        },
        FIXED,
      );
      expect(client).toMatchObject({
        scope: ['openid', 'profile'],
        defaultMaxAge: 3600,
        idTokenSignedResponseAlg: 'RS256',
        userinfoSignedResponseAlg: 'ES256',
        jwks: { keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'AQAB', e: 'AQAB' }] },
      });
    });

    // id_token_signed_response_alg is never left out: it always carries at
    // least its default (OIDC Dynamic Client Registration 1.0 §2).
    it('should leave the optional record fields out when they were not registered', () => {
      const client = buildRegisteredClient(CONFIDENTIAL, FIXED);
      expect(Object.keys(client)).toEqual([
        'clientId',
        'clientSecret',
        'clientType',
        'redirectUris',
        'grantTypes',
        'responseTypes',
        'tokenEndpointAuthMethods',
        'idTokenSignedResponseAlg',
        'clientIdIssuedAt',
        'metadata',
      ]);
    });

    it('should copy the metadata arrays and objects instead of sharing them', () => {
      const metadata: ValidatedClientRegistration = {
        ...CONFIDENTIAL,
        redirectUris: ['https://app.example.com/cb'],
        scope: ['openid'],
        jwks: { keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'AQAB', e: 'AQAB' }] },
        metadata: { ...CONFIDENTIAL.metadata, client_name: 'My Test App' },
      };
      const client = buildRegisteredClient(metadata);
      metadata.redirectUris.push('https://evil.example.com/cb');
      metadata.scope?.push('admin');
      metadata.jwks?.keys.push({ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'evil', e: 'AQAB' });
      metadata.metadata['client_name'] = 'Renamed';
      expect(client.redirectUris).toEqual(['https://app.example.com/cb']);
      expect(client.scope).toEqual(['openid']);
      expect(client.jwks?.keys).toHaveLength(1);
      expect(client.metadata['client_name']).toBe('My Test App');
    });
  });
});

describe('buildClientRegistrationResponse', () => {
  const confidentialClient: DynamicallyRegisteredClient = {
    clientId: 'dcr-fixed',
    clientSecret: 'fixed-secret',
    clientType: 'confidential',
    redirectUris: ['https://app.example.com/cb'],
    grantTypes: ['authorization_code'],
    responseTypes: ['code'],
    tokenEndpointAuthMethods: ['client_secret_basic'],
    scope: ['openid', 'profile'],
    clientIdIssuedAt: 1_790_812_800,
    metadata: {
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: 'My Test App',
      scope: 'openid profile',
      software_statement: 'eyJhbGciOiJSUzI1NiJ9.e30.sig',
      tenant_id: 'acme',
    },
  };

  it('should return the issued values followed by every registered metadata value (RFC 7591 Section 3.2.1)', () => {
    expect(buildClientRegistrationResponse(confidentialClient)).toEqual({
      client_id: 'dcr-fixed',
      client_secret: 'fixed-secret',
      // 0 は「無期限」（RFC 7591 §3.2.1）。即時失効ではない。
      client_secret_expires_at: 0,
      client_id_issued_at: 1_790_812_800,
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: 'My Test App',
      scope: 'openid profile',
      software_statement: 'eyJhbGciOiJSUzI1NiJ9.e30.sig',
      tenant_id: 'acme',
    });
  });

  it('should omit client_secret and client_secret_expires_at for a client without a secret', () => {
    const { clientSecret: _secret, ...withoutSecret } = confidentialClient;
    const response = buildClientRegistrationResponse({
      ...withoutSecret,
      clientType: 'public',
      tokenEndpointAuthMethods: ['none'],
      metadata: { ...confidentialClient.metadata, token_endpoint_auth_method: 'none' },
    });
    expect(Object.keys(response)).toEqual([
      'client_id',
      'client_id_issued_at',
      'redirect_uris',
      'token_endpoint_auth_method',
      'grant_types',
      'response_types',
      'client_name',
      'scope',
      'software_statement',
      'tenant_id',
    ]);
    expect(response['token_endpoint_auth_method']).toBe('none');
  });
});
