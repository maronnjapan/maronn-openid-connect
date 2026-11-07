import { describe, expect, it } from 'vitest';
import {
  createRotatingSigningKeyProvider,
  echoRequestedAcr,
  readClientJwksUri,
  readCrossAppAccess,
  readDynamicClientRegistration,
  readList,
  readPostLogoutRedirectUris,
  readRegisteredClients,
  readRequestUri,
  readServerAddress,
} from './settings.js';

describe('readServerAddress', () => {
  it('should listen on 127.0.0.1:3010 and answer as its own address when nothing is set', () => {
    expect(readServerAddress({})).toEqual({ host: '127.0.0.1', port: 3010, issuer: 'http://127.0.0.1:3010' });
  });

  it('should derive the issuer from HOST and PORT', () => {
    expect(readServerAddress({ HOST: '0.0.0.0', PORT: '8080' })).toEqual({
      host: '0.0.0.0',
      port: 8080,
      issuer: 'http://0.0.0.0:8080',
    });
  });

  it('should answer as ISSUER when it is set', () => {
    expect(readServerAddress({ PORT: '8080', ISSUER: 'https://op.example.com' })).toEqual({
      host: '127.0.0.1',
      port: 8080,
      issuer: 'https://op.example.com',
    });
  });

  it('should reject a PORT that is not a positive integer', () => {
    expect(() => readServerAddress({ PORT: 'abc' })).toThrow('PORT must be a positive integer, not "abc"');
  });
});

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

// RFC 7591 §5: the inventory cap.
describe('readDynamicClientRegistration', () => {
  it('should read the cap', () => {
    expect(readDynamicClientRegistration({ OIDC_DCR_MAX_CLIENTS: '5' })).toEqual({ maxRegisteredClients: 5 });
  });

  it('should leave the cap out when the variable is unset', () => {
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

describe('readClientJwksUri', () => {
  it('should keep the defaults of the code when nothing is set', () => {
    expect(readClientJwksUri({})).toEqual({});
  });

  // UC-7: tests/e2e serves the keys of its client at http://127.0.0.1:3020.
  it('should allow insecure jwks_uri when OIDC_ALLOW_INSECURE_CLIENT_JWKS_URI is 1', () => {
    expect(readClientJwksUri({ OIDC_ALLOW_INSECURE_CLIENT_JWKS_URI: '1' })).toEqual({ allowInsecureClientJwksUri: true });
  });

  it('should read the cache ttl and the refetch interval, 0 included', () => {
    expect(
      readClientJwksUri({
        OIDC_CLIENT_JWKS_URI_CACHE_TTL_SECONDS: '120',
        OIDC_CLIENT_JWKS_URI_REFETCH_INTERVAL_SECONDS: '0',
      }),
    ).toEqual({ clientJwksUriCacheTtlSeconds: 120, clientJwksUriRefetchIntervalSeconds: 0 });
  });

  it('should reject a refetch interval that is not a non-negative integer', () => {
    expect(() => readClientJwksUri({ OIDC_CLIENT_JWKS_URI_REFETCH_INTERVAL_SECONDS: '-1' })).toThrow(
      'OIDC_CLIENT_JWKS_URI_REFETCH_INTERVAL_SECONDS must be a non-negative integer, not "-1"',
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
describe('echoRequestedAcr', () => {
  it('should echo the most preferred requested acr with amr pwd', async () => {
    const resolved = await echoRequestedAcr({ userId: 'alice', clientId: 'rp-1', requestedAcrValues: 'urn:acr:mfa urn:acr:pwd' });

    expect(resolved).toEqual({ acr: 'urn:acr:mfa', amr: ['pwd'] });
  });

  it('should resolve no acr when the client requested none', async () => {
    expect(await echoRequestedAcr({ userId: 'alice', clientId: 'rp-1' })).toBeUndefined();
  });
});

// OIDC Core 1.0 §10.1.1: a new key signs, and the old one stays published.
describe('createRotatingSigningKeyProvider', () => {
  it('should provide one RS256 key with the key id, the same key on every call before a rotation', async () => {
    const { signingKeyProvider } = createRotatingSigningKeyProvider('app-key-1');

    const first = await signingKeyProvider.getSigningKeys();
    const second = await signingKeyProvider.getSigningKeys();

    expect(first.map((key) => key.keyId)).toEqual(['app-key-1']);
    expect(first[0]!.publicJwk).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: 'app-key-1' });
    expect(second[0]).toBe(first[0]);
  });

  it('should put a new key with a kid of its own first and keep the old one after it', async () => {
    const { signingKeyProvider, rotateSigningKey } = createRotatingSigningKeyProvider('app-key-1');
    const before = await signingKeyProvider.getSigningKeys();

    const rotated = await rotateSigningKey();
    const after = await signingKeyProvider.getSigningKeys();

    expect(rotated).toEqual({ kid: 'app-key-1-rotated-1', kids: ['app-key-1-rotated-1', 'app-key-1'] });
    expect(after.map((key) => key.keyId)).toEqual(['app-key-1-rotated-1', 'app-key-1']);
    expect(after[1]).toBe(before[0]);
  });
});

describe('readRequestUri', () => {
  it('should keep the defaults of the request-object feature when nothing is set', () => {
    expect(readRequestUri({})).toEqual({});
  });

  // OIDC Core 1.0 §6.2 / OIDC Discovery 1.0 §3.
  it('should allow insecure request_uris and require their registration when the variables are 1', () => {
    expect(readRequestUri({ OIDC_ALLOW_INSECURE_REQUEST_URI: '1', OIDC_REQUIRE_REQUEST_URI_REGISTRATION: '1' })).toEqual({
      allowInsecureRequestUri: true,
      requireRequestUriRegistration: true,
    });
  });
});
