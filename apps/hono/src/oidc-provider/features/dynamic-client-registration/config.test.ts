import { describe, expect, it } from 'vitest';
import { dynamicClientRegistrationConfig, extendDynamicClientRegistrationConfig } from './config.js';
import {
  customClientMetadata,
  verifyRegistrationInitialAccessToken,
  verifyRegistrationSoftwareStatement,
} from './policy.js';

describe('dynamicClientRegistrationConfig', () => {
  // RFC 7591 §3.1 (SHOULD allow open registration) and §5 (inventory and size caps against DoS).
  it('should leave registration open, capped at 100 clients and 16384-byte bodies, by default', () => {
    expect(dynamicClientRegistrationConfig).toMatchObject({
      initialAccessToken: undefined,
      maxRegisteredClients: 100,
      maxRegistrationBodyBytes: 16384,
    });
  });

  // RFC 7591 §2: the values a client may register as generated — the methods
  // core verifies, the grants of the code flow and the Implicit Flow, no
  // trusted publisher (fail safe).
  it('should allow the three auth methods of core, the code and implicit grants, and trust no publisher', () => {
    expect(dynamicClientRegistrationConfig).toMatchObject({
      tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post', 'none'],
      grantTypes: ['authorization_code', 'refresh_token', 'implicit'],
      jwksPurposes: ['request_object', 'private_key_jwt', 'dpop'],
      trustedSoftwarePublishers: [],
    });
  });

  it('should take its registration policy from policy.ts', () => {
    expect(dynamicClientRegistrationConfig.verifyInitialAccessToken).toBe(verifyRegistrationInitialAccessToken);
    expect(dynamicClientRegistrationConfig.verifySoftwareStatement).toBe(verifyRegistrationSoftwareStatement);
    expect(dynamicClientRegistrationConfig.customClientMetadata).toBe(customClientMetadata);
    expect(customClientMetadata).toEqual({});
  });
});

describe('extendDynamicClientRegistrationConfig', () => {
  const publisher = { issuer: 'https://publisher.example.com', jwks: { keys: [] } };

  it('should return the defaults unchanged when nothing is added', () => {
    expect(extendDynamicClientRegistrationConfig(dynamicClientRegistrationConfig)).toEqual(dynamicClientRegistrationConfig);
    expect(extendDynamicClientRegistrationConfig(dynamicClientRegistrationConfig, {})).toEqual(dynamicClientRegistrationConfig);
  });

  // A deployment adds what it allows beside the generated defaults, instead of repeating them.
  it('should add the given values to the lists and the table, each once', () => {
    const tenant = () => undefined;
    const config = extendDynamicClientRegistrationConfig(dynamicClientRegistrationConfig, {
      tokenEndpointAuthMethods: ['private_key_jwt', 'none'],
      grantTypes: ['urn:ietf:params:oauth:grant-type:device_code'],
      jwksPurposes: ['dpop', 'my-purpose'],
      trustedSoftwarePublishers: [publisher],
      customClientMetadata: { tenant_id: tenant },
    });

    expect(config).toMatchObject({
      tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post', 'none', 'private_key_jwt'],
      grantTypes: ['authorization_code', 'refresh_token', 'implicit', 'urn:ietf:params:oauth:grant-type:device_code'],
      jwksPurposes: ['request_object', 'private_key_jwt', 'dpop', 'my-purpose'],
      trustedSoftwarePublishers: [publisher],
      customClientMetadata: { tenant_id: tenant },
    });
  });

  it('should replace the scalar settings and the policy functions, and keep them for an undefined field', () => {
    const verifyInitialAccessToken = async () => true;
    const config = extendDynamicClientRegistrationConfig(dynamicClientRegistrationConfig, {
      initialAccessToken: 'iat-1',
      maxRegisteredClients: undefined,
      verifyInitialAccessToken,
    });

    expect(config).toMatchObject({ initialAccessToken: 'iat-1', maxRegisteredClients: 100, verifyInitialAccessToken });
    expect(config.verifySoftwareStatement).toBe(dynamicClientRegistrationConfig.verifySoftwareStatement);
  });

  it('should replace a publisher with the same issuer and a validator with the same name', () => {
    const rotated = { ...publisher, jwks: { keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'AQAB', e: 'AQAB' }] } };
    const replaced = () => 'replaced';
    const base = extendDynamicClientRegistrationConfig(dynamicClientRegistrationConfig, {
      trustedSoftwarePublishers: [publisher],
      customClientMetadata: { tenant_id: () => 'original' },
    });

    const config = extendDynamicClientRegistrationConfig(base, {
      trustedSoftwarePublishers: [rotated],
      customClientMetadata: { tenant_id: replaced },
    });

    expect(config.trustedSoftwarePublishers).toEqual([rotated]);
    expect(config.customClientMetadata).toEqual({ tenant_id: replaced });
  });

  it('should leave the defaults it was given unchanged', () => {
    const base = { ...dynamicClientRegistrationConfig, tokenEndpointAuthMethods: ['none'] };

    extendDynamicClientRegistrationConfig(base, { tokenEndpointAuthMethods: ['private_key_jwt'] });

    expect(base.tokenEndpointAuthMethods).toEqual(['none']);
  });
});
