import { describe, expect, it } from 'vitest';
import {
  buildClientRegistrationResponse,
  buildRegisteredClient,
} from './registered-client.js';
import type { ValidatedClientRegistration } from './registration-request.js';

const CONFIDENTIAL: ValidatedClientRegistration = {
  redirectUris: ['https://app.example.com/cb'],
  tokenEndpointAuthMethod: 'client_secret_basic',
  grantTypes: ['authorization_code'],
  responseTypes: ['code'],
};

const PUBLIC: ValidatedClientRegistration = {
  redirectUris: ['https://app.example.com/cb'],
  tokenEndpointAuthMethod: 'none',
  grantTypes: ['authorization_code'],
  responseTypes: ['code'],
};

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
      const client = buildRegisteredClient(CONFIDENTIAL, {
        generateClientId: () => 'dcr-fixed',
        generateClientSecret: () => 'fixed-secret',
        now: () => 1_790_812_800_123,
      });
      expect(client).toEqual({
        clientId: 'dcr-fixed',
        clientSecret: 'fixed-secret',
        clientType: 'confidential',
        redirectUris: ['https://app.example.com/cb'],
        grantTypes: ['authorization_code'],
        responseTypes: ['code'],
        tokenEndpointAuthMethods: ['client_secret_basic'],
        clientIdIssuedAt: 1_790_812_800,
      });
    });
  });

  describe('public clients (token_endpoint_auth_method none)', () => {
    it('should mark the client public and issue no client_secret', () => {
      const client = buildRegisteredClient(PUBLIC, {
        generateClientId: () => 'dcr-public',
        now: () => 1_790_812_800_000,
      });
      expect(client).toEqual({
        clientId: 'dcr-public',
        clientType: 'public',
        redirectUris: ['https://app.example.com/cb'],
        grantTypes: ['authorization_code'],
        responseTypes: ['code'],
        tokenEndpointAuthMethods: ['none'],
        clientIdIssuedAt: 1_790_812_800,
      });
      expect(Object.hasOwn(client, 'clientSecret')).toBe(false);
    });
  });

  describe('metadata copy', () => {
    it('should copy the metadata arrays instead of sharing them', () => {
      const metadata: ValidatedClientRegistration = {
        ...CONFIDENTIAL,
        redirectUris: ['https://app.example.com/cb'],
      };
      const client = buildRegisteredClient(metadata);
      metadata.redirectUris.push('https://evil.example.com/cb');
      expect(client.redirectUris).toEqual(['https://app.example.com/cb']);
    });

    it('should keep the registered client_name', () => {
      const client = buildRegisteredClient(
        { ...CONFIDENTIAL, clientName: 'My Test App' },
        { generateClientId: () => 'dcr-x', generateClientSecret: () => 's', now: () => 0 },
      );
      expect(client.clientName).toBe('My Test App');
    });
  });
});

describe('buildClientRegistrationResponse', () => {
  it('should return the issued values and all registered metadata for a confidential client (RFC 7591 Section 3.2.1)', () => {
    const response = buildClientRegistrationResponse({
      clientId: 'dcr-fixed',
      clientSecret: 'fixed-secret',
      clientType: 'confidential',
      redirectUris: ['https://app.example.com/cb'],
      grantTypes: ['authorization_code'],
      responseTypes: ['code'],
      tokenEndpointAuthMethods: ['client_secret_basic'],
      clientName: 'My Test App',
      clientIdIssuedAt: 1_790_812_800,
    });
    expect(response).toEqual({
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
    });
  });

  it('should omit client_secret and client_secret_expires_at for a public client', () => {
    const response = buildClientRegistrationResponse({
      clientId: 'dcr-public',
      clientType: 'public',
      redirectUris: ['https://app.example.com/cb'],
      grantTypes: ['authorization_code'],
      responseTypes: ['code'],
      tokenEndpointAuthMethods: ['none'],
      clientIdIssuedAt: 1_790_812_800,
    });
    expect(response).toEqual({
      client_id: 'dcr-public',
      client_id_issued_at: 1_790_812_800,
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
    expect(Object.hasOwn(response, 'client_secret')).toBe(false);
    expect(Object.hasOwn(response, 'client_secret_expires_at')).toBe(false);
  });

  it('should omit client_name when none was registered', () => {
    const response = buildClientRegistrationResponse({
      clientId: 'dcr-x',
      clientSecret: 's',
      clientType: 'confidential',
      redirectUris: ['https://app.example.com/cb'],
      grantTypes: ['authorization_code'],
      responseTypes: ['code'],
      tokenEndpointAuthMethods: ['client_secret_basic'],
      clientIdIssuedAt: 0,
    });
    expect(Object.hasOwn(response, 'client_name')).toBe(false);
  });
});
