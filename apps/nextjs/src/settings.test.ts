import { describe, expect, it } from 'vitest';
import {
  readCrossAppAccess,
  readDynamicClientRegistration,
  readList,
  readPostLogoutRedirectUris,
  readRegisteredClients,
} from './settings';

describe('readList', () => {
  it('should split on commas, trim the entries and drop empty ones', () => {
    expect(readList(' https://a.example , ,https://b.example,')).toEqual(['https://a.example', 'https://b.example']);
  });

  it('should return an empty list for an unset variable', () => {
    expect(readList(undefined)).toEqual([]);
  });
});

describe('readRegisteredClients', () => {
  it('should read the clients of OIDC_CLIENTS_JSON', () => {
    const encoded = JSON.stringify([{ clientId: 'rp-1', redirectUris: ['https://rp.example.com/cb'] }]);

    expect(readRegisteredClients(encoded)).toEqual([{ clientId: 'rp-1', redirectUris: ['https://rp.example.com/cb'] }]);
  });

  it('should return the two clients of tests/e2e when the variable is unset', () => {
    expect(readRegisteredClients(undefined).map((client) => client.clientId)).toEqual([
      'e2e-client',
      'e2e-resource-server',
    ]);
  });
});

// RP-Initiated Logout 1.0 §3: post_logout_redirect_uri values registered per client.
describe('readPostLogoutRedirectUris', () => {
  it('should read the registry of OIDC_POST_LOGOUT_REDIRECT_URIS_JSON', () => {
    const env = { OIDC_POST_LOGOUT_REDIRECT_URIS_JSON: '{"rp-1":["https://rp.example.com/logged-out"]}' };

    expect(readPostLogoutRedirectUris(env)).toEqual({ 'rp-1': ['https://rp.example.com/logged-out'] });
  });

  it('should return undefined when the variable is unset', () => {
    expect(readPostLogoutRedirectUris({})).toBeUndefined();
  });
});

// RFC 7591: the initial access token and the inventory cap.
describe('readDynamicClientRegistration', () => {
  it('should read the initial access token and the cap', () => {
    const env = { OIDC_DCR_INITIAL_ACCESS_TOKEN: 'iat-1', OIDC_DCR_MAX_CLIENTS: '5' };

    expect(readDynamicClientRegistration(env)).toEqual({ initialAccessToken: 'iat-1', maxRegisteredClients: 5 });
  });

  it('should leave both out when the variables are unset', () => {
    expect(readDynamicClientRegistration({})).toEqual({});
  });

  // A cap that is not a number would make every count comparison false and
  // switch the inventory cap off (RFC 7591 §5 DoS consideration).
  it('should reject a cap that is not a positive integer', () => {
    expect(() => readDynamicClientRegistration({ OIDC_DCR_MAX_CLIENTS: 'abc' })).toThrow(
      'OIDC_DCR_MAX_CLIENTS must be a positive integer, not "abc"',
    );
  });
});

describe('readCrossAppAccess', () => {
  it('should trust no identity provider, allow no audience and refuse actor tokens when nothing is set', () => {
    expect(readCrossAppAccess({})).toEqual({ allowedAudiences: [], allowActorTokens: false });
  });

  it('should read the trusted identity provider with the JWKS at its well-known location by default', () => {
    const env = {
      XAA_ALLOWED_AUDIENCES: 'https://as.example.com,https://as2.example.com',
      XAA_TRUSTED_IDP_ISSUER: 'https://idp.example.com',
      XAA_ALLOW_ACTOR_TOKENS: '1',
      XAA_ACTOR_TOKEN_RESOLVER: 'access-token',
    };

    expect(readCrossAppAccess(env)).toEqual({
      allowedAudiences: ['https://as.example.com', 'https://as2.example.com'],
      trustedIdentityProvider: {
        issuer: 'https://idp.example.com',
        jwksUri: 'https://idp.example.com/.well-known/jwks.json',
      },
      allowActorTokens: true,
      actorTokenResolver: 'access-token',
    });
  });

  it('should use XAA_TRUSTED_IDP_JWKS_URI when it is set', () => {
    const env = { XAA_TRUSTED_IDP_ISSUER: 'https://idp.example.com', XAA_TRUSTED_IDP_JWKS_URI: 'https://keys.example.com/jwks' };

    expect(readCrossAppAccess(env).trustedIdentityProvider).toEqual({
      issuer: 'https://idp.example.com',
      jwksUri: 'https://keys.example.com/jwks',
    });
  });
});

// OIDC Core 1.0 §2 / §3.1.2.1: the acr the client asked for, with amr pwd (RFC 8176).
