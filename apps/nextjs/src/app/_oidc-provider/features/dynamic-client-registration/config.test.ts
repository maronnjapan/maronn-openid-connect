import { describe, expect, it } from 'vitest';
import { dynamicClientRegistrationConfig } from './config';
import {
  customClientMetadata,
  verifyRegistrationInitialAccessToken,
  verifyRegistrationSoftwareStatement,
} from './policy';

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
