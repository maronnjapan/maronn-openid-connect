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
      // The request-object feature requires signed Request Objects (OIDC Core 1.0 §6.1)
      // and pre-registered request_uri values (§6.2).
      allowUnsignedRequestObject: false,
      requireRequestUriRegistration: true,
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
