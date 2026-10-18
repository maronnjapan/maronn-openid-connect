import { describe, expect, it } from 'vitest';
import { idJag } from './feature.js';

describe('idJag', () => {
  it('should answer the token-exchange and the jwt-bearer grants at the token endpoint', () => {
    expect(idJag.token.grants).toEqual([
      'urn:ietf:params:oauth:grant-type:token-exchange',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    ]);
  });

  // ID-JAG draft §7.1 / §7.2; the trusted issuers are not disclosed (§9.4).
  it('should advertise the ID-JAG token type and grant profile in discovery', () => {
    expect(idJag.discovery()).toEqual({
      identity_chaining_requested_token_types_supported: ['urn:ietf:params:oauth:token-type:id-jag'],
      authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],
    });
  });
});
