import { afterEach, describe, expect, it } from 'vitest';
import { dynamicClientRegistrationConfig, extendDynamicClientRegistrationConfig } from './config';

describe('dynamicClientRegistrationConfig', () => {
  // RFC 7591 §3.1 (SHOULD allow open registration), §3.1.1 (a server without
  // support ignores software statements) and §5 (inventory and size caps).
  it('should leave registration open, ignore software statements and cap at 100 clients and 16384-byte bodies, by default', () => {
    expect(dynamicClientRegistrationConfig).toMatchObject({
      verifyInitialAccessToken: undefined,
      verifySoftwareStatement: undefined,
      maxRegisteredClients: 100,
      maxRegistrationBodyBytes: 16384,
    });
  });

  // RFC 7591 §2: the values a client may register as generated — the methods
  // core verifies, the grants of the code flow and the Implicit Flow, no
  // metadata beyond the standard fields.
  it('should allow the three auth methods of core, the code and implicit grants, and no custom metadata', () => {
    expect(dynamicClientRegistrationConfig).toMatchObject({
      tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post', 'none'],
      grantTypes: ['authorization_code', 'refresh_token', 'implicit'],
      jwksPurposes: ['request_object', 'private_key_jwt', 'dpop'],
      customClientMetadata: {},
    });
  });

  // RFC 7591 §2 jwks_uri: accepted, fetched with globalThis.fetch and kept for 5 minutes.
  it('should accept jwks_uri, keep a fetched JWK Set for 300 seconds and fetch with the global fetch, by default', () => {
    expect(dynamicClientRegistrationConfig).toMatchObject({
      allowJwksUri: true,
      jwksUriCacheTtlSeconds: 300,
      jwksUriFetch: undefined,
    });
  });
});

describe('extendDynamicClientRegistrationConfig', () => {
  // dynamicClientRegistrationConfig is a shared() object: every test puts the
  // settings it changed back.
  const defaults = { ...dynamicClientRegistrationConfig };

  afterEach(() => {
    Object.assign(dynamicClientRegistrationConfig, defaults);
  });

  it('should leave the settings unchanged when nothing is added', () => {
    extendDynamicClientRegistrationConfig({});

    expect(dynamicClientRegistrationConfig).toEqual(defaults);
  });

  // A deployment adds what it allows beside the generated defaults, instead of repeating them.
  it('should add the given values to the lists and the table, each once', () => {
    const tenant = () => undefined;

    extendDynamicClientRegistrationConfig({
      tokenEndpointAuthMethods: ['private_key_jwt', 'none'],
      grantTypes: ['urn:ietf:params:oauth:grant-type:device_code'],
      jwksPurposes: ['dpop', 'my-purpose'],
      customClientMetadata: { tenant_id: tenant },
    });

    expect(dynamicClientRegistrationConfig).toMatchObject({
      tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post', 'none', 'private_key_jwt'],
      grantTypes: ['authorization_code', 'refresh_token', 'implicit', 'urn:ietf:params:oauth:grant-type:device_code'],
      jwksPurposes: ['request_object', 'private_key_jwt', 'dpop', 'my-purpose'],
      customClientMetadata: { tenant_id: tenant },
    });
  });

  it('should replace the scalar settings, set the verifier functions, and keep the defaults for an undefined field', () => {
    const verifyInitialAccessToken = async () => true;

    extendDynamicClientRegistrationConfig({ maxRegistrationBodyBytes: 4096, maxRegisteredClients: undefined, verifyInitialAccessToken });

    expect(dynamicClientRegistrationConfig).toMatchObject({
      maxRegistrationBodyBytes: 4096,
      maxRegisteredClients: 100,
      verifyInitialAccessToken,
    });
    expect(dynamicClientRegistrationConfig.verifySoftwareStatement).toBeUndefined();
  });

  it('should replace a validator with the same name', () => {
    const replaced = () => 'replaced';
    extendDynamicClientRegistrationConfig({ customClientMetadata: { tenant_id: () => 'original' } });

    extendDynamicClientRegistrationConfig({ customClientMetadata: { tenant_id: replaced } });

    expect(dynamicClientRegistrationConfig.customClientMetadata).toEqual({ tenant_id: replaced });
  });
});
