import { describe, expect, it } from 'vitest';
import { createProviderConfig } from './config';

describe('createProviderConfig', () => {
  // RFC 7591 §2 jwks_uri: https and public addresses only, keys kept for
  // max-age within 30 to 300 seconds (300 without max-age), an unknown kid
  // refetched at most every 30 seconds, and the fetch bounded.
  it('should hold the defaults of the jwks_uri of the clients', () => {
    expect(createProviderConfig()).toMatchObject({
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
});
