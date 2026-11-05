import { describe, expect, it } from 'vitest';
import { createProviderConfig } from './config.js';

describe('createProviderConfig', () => {
  it('should combine the defaults of config.ts with the defaults of the enabled features', () => {
    expect(createProviderConfig()).toEqual({
      issuer: 'http://localhost:3000',
      accessTokenExpiresIn: 3600,
      idTokenExpiresIn: 3600,
      // OAuth 2.1 §6.1: refresh tokens expire 90 days after initial issuance.
      refreshTokenAbsoluteLifetime: 7776000,
      // OIDC Core 1.0 §11: online refresh tokens are issued without offline_access.
      onlineRefreshTokenEnabled: true,
      accessTokenFormat: 'jwt',
      // OIDC Core 1.0 §3.1.3.1: authorization codes are short-lived.
      authorizationCodeTtl: 300,
      // The pkce feature makes PKCE required of confidential clients too (OAuth 2.1 §4.1.1).
      allowNonPkceAuthorizationCodeFlow: false,
      // The jwks_uri of the clients (RFC 7591 §2): https and public addresses only,
      // keys kept for max-age within 30 to 300 seconds (300 without max-age), an
      // unknown kid refetched at most every 30 seconds, and the fetch bounded.
      allowInsecureClientJwksUri: false,
      clientJwksUriCacheTtlSeconds: 300,
      clientJwksUriCacheMinTtlSeconds: 30,
      clientJwksUriCacheMaxTtlSeconds: 300,
      clientJwksUriRefetchIntervalSeconds: 30,
      clientJwksUriTimeoutMs: 3000,
      clientJwksUriMaxBytes: 65536,
      clientJwksUriMaxKeys: 32,
      clientJwksUriCacheMaxEntries: 1000,
      clientJwksUriPurposes: ['request_object', 'private_key_jwt', 'dpop'],
      // OIDC Core 1.0 §9: private_key_jwt assertions signed with the asymmetric algs core verifies.
      tokenEndpointAuthSigningAlgValuesSupported: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
      // The request-object feature requires signed Request Objects (OIDC Core 1.0 §6.1)
      // and accepts the algs core verifies (RFC 7518 §3.3 / §3.4).
      allowUnsignedRequestObject: false,
      requestObjectSigningAlgValuesSupported: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
      // OIDC Core 1.0 §6.2: request_uri fetched from https URLs of public hosts,
      // at most 512 characters, within 3 seconds and 64 KiB.
      requestUriParameterSupported: true,
      requireRequestUriRegistration: false,
      allowInsecureRequestUri: false,
      requestUriTimeoutMs: 3000,
      requestUriMaxBytes: 65536,
      requestUriMaxLength: 512,
    });
  });

  // UC-6: the settings are flat, so overriding one keeps the defaults of the others.
  it('should keep the other jwks_uri defaults when one of them is overridden', () => {
    const config = createProviderConfig({ clientJwksUriCacheMaxTtlSeconds: 3600, clientJwksUriTimeoutMs: 1000 });

    expect(config).toMatchObject({
      clientJwksUriCacheMaxTtlSeconds: 3600,
      clientJwksUriTimeoutMs: 1000,
      clientJwksUriCacheMinTtlSeconds: 30,
      clientJwksUriCacheTtlSeconds: 300,
      clientJwksUriRefetchIntervalSeconds: 30,
      clientJwksUriMaxBytes: 65536,
      allowInsecureClientJwksUri: false,
    });
  });

  it('should apply the overrides of the app over the defaults of the features', () => {
    const config = createProviderConfig({
      issuer: 'https://op.example.com',
      allowNonPkceAuthorizationCodeFlow: true,
      authorizationCodeTtl: 60,
    });

    expect(config).toMatchObject({
      issuer: 'https://op.example.com',
      allowNonPkceAuthorizationCodeFlow: true,
      authorizationCodeTtl: 60,
      accessTokenExpiresIn: 3600,
    });
  });

  it('should return a new object on every call', () => {
    const first = createProviderConfig();
    first.issuer = 'https://changed.example.com';

    expect(createProviderConfig().issuer).toBe('http://localhost:3000');
  });
});
