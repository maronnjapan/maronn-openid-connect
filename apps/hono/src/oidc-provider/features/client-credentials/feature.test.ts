import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { discoveryOf, routesOf, tokenGrantsOf, type Feature } from '../feature.js';
import { clientCredentials } from './feature.js';

describe('clientCredentials', () => {
  // RFC 6749 §4.4.2: the grant the token endpoint answers, also advertised in grant_types_supported.
  it('should answer the client_credentials grant at the token endpoint', () => {
    expect(tokenGrantsOf([clientCredentials])).toEqual(['client_credentials']);
  });

  // RFC 8707 §2: fail safe, a request that names an audience is refused until the resources are listed.
  it('should allow no audience to be requested by default', () => {
    expect(clientCredentials.config).toEqual({ clientCredentialsAllowedAudiences: [] });
    expect(createProviderConfig().clientCredentialsAllowedAudiences).toEqual([]);
  });

  it('should take the allowed audiences from the settings of the app', () => {
    const config = createProviderConfig({ clientCredentialsAllowedAudiences: ['https://api.example.com'] });

    expect(config.clientCredentialsAllowedAudiences).toEqual(['https://api.example.com']);
  });

  it('should add no routes, no context values and no discovery members of its own', () => {
    expect(routesOf([clientCredentials])).toEqual([]);
    expect((clientCredentials as Feature).context).toBeUndefined();
    expect(discoveryOf([clientCredentials], {}, TEST_ISSUER, createProviderConfig({ issuer: TEST_ISSUER }))).toEqual({});
  });
});
