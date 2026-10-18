import { describe, expect, it } from 'vitest';
import { dynamicClientRegistrationConfig } from './config.js';

describe('dynamicClientRegistrationConfig', () => {
  // RFC 7591 §3.1 (SHOULD allow open registration) and §5 (inventory and size caps against DoS).
  it('should leave registration open, capped at 100 clients and 16384-byte bodies, by default', () => {
    expect(dynamicClientRegistrationConfig).toEqual({
      initialAccessToken: undefined,
      maxRegisteredClients: 100,
      maxRegistrationBodyBytes: 16384,
    });
  });
});
