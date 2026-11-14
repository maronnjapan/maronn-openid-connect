import { describe, expect, it } from 'vitest';
import { createProviderConfig } from '../../config';
import { tokenGrantsOf } from '../../feature';
import { clientCredentials } from './feature';

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

  it('should add no discovery members and no context values of its own', () => {
    expect(clientCredentials).not.toHaveProperty('discovery');
    expect(clientCredentials).not.toHaveProperty('context');
  });
});
